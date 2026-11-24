// Photo places for DMs: `POST /places`, the shape of /manage (manage.ts). Only keys on this box may call it: the box
// owner, the home's owner and the home's members (Db.onBox).
//
// - `members`: which of some keys are on this box, so a phone knows who would see where a photo was taken.
// - `put`, `get`, `drop`: place notes. A note is a small file sealed on the sender's phone (where the photo was
//   taken, and the bytes stripping removed from it). It is kept apart from blobs: never served by `GET /<sha256>`,
//   never listed, never counted in usage, never touched by the keeper. Anyone on the box may get any note by its
//   sha; the key that opens it travels in the message, not here.
// - `names`: the nearest town to each of some points, from the town list in the image (towns.ts). Points are rounded
//   to 2 decimals before anything is looked up.
//
// Log lines carry the method and counts, never coordinates or note bytes.

import { createHash } from 'node:crypto';
import type http from 'node:http';
import { checkHttpAuth, HTTP_AUTH_KIND, parseAuth } from './auth.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { Home } from './home.ts';
import { CONTENT_TYPE, readBody, Refusal, send } from './manage.ts';
import type { ServiceKey } from './servicekey.ts';
import type { Towns } from './towns.ts';

export const PLACES_PATH = '/places';
/** Largest body read, bytes. */
export const MAX_BODY = 256 * 1024;
/** Largest note, bytes (decoded). */
export const MAX_NOTE = 65536;
/** Most notes one account may keep. */
export const MAX_NOTES_PER_ACCOUNT = 100_000;
/** Most keys one `members` call may ask about. */
export const MAX_MEMBERS_ASKED = 500;
/** Most shas one `get` or `drop` may name. */
export const MAX_SHAS = 100;
/** Most points one `names` call may ask about. */
export const MAX_POINTS = 200;
/** `names` calls one key may make in a minute. */
export const NAMES_PER_MINUTE = 30;

const HEX64 = /^[0-9a-f]{64}$/;
/** The one answer for a good signature from a key that is not on this box, whatever it asked. */
const NOT_ON_BOX = 'this key is not on this box';

const ERR = {
  members: `members takes an array of 1 to ${MAX_MEMBERS_ASKED} pubkeys, as 64-character hex`,
  put: `put takes one sealed place note, at most ${MAX_NOTE} bytes, as base64`,
  tooMany: 'too many place notes stored for you',
  get: `get takes an array of 1 to ${MAX_SHAS} sha256 hashes`,
  drop: `drop takes an array of 1 to ${MAX_SHAS} sha256 hashes`,
  names: `names takes {"points": [[lat, lon], ...]}, 1 to ${MAX_POINTS} points`,
  noTowns: 'this box has no town list',
  loading: 'the town list is still loading',
  namesLimit: 'too many town lookups; wait a minute',
  disk: 'this box is out of disk space',
} as const;

export interface PlacesOptions {
  config: Config;
  db: Db;
  /** The home this storage follows, or null: then only STORAGE_OWNER is on the box. */
  home: Home | null;
  /** This storage's key. Unused while lookups are plain JSON; the sealed variant (contract 1.5) would use it. */
  key: ServiceKey;
  /** Whether the box is set up (STORAGE_PUBLIC_URL and STORAGE_OWNER). */
  ready: boolean;
  now: () => number;
  /** The town list, or null when it is off. */
  towns: Towns | null;
  /** Whether `n` more bytes leave the disk margin free (the uploads' check). */
  room: (n: number) => boolean;
  log: (line: string) => void;
}

/** Whether a path is the places endpoint (so its refusals are JSON). */
export const isPlacesPath = (path: string) => path === PLACES_PATH;

type Reply = { status?: number; body: { result: unknown } | { error: string }; line: string };

export function placesHandler(o: PlacesOptions) {
  const { config, db } = o;
  const base = config.publicUrl.replace(/\/+$/, '');
  // the exact url a client signs: the public url and /places, with or without a slash left on the base
  const urls = [`${base}${PLACES_PATH}`, `${base}/${PLACES_PATH}`];
  const maxNotes = config.maxPlaceNotes ?? MAX_NOTES_PER_ACCOUNT;
  /** `names` calls per key in the current minute. Oldest first, so it can be trimmed. */
  const lookups = new Map<string, { start: number; n: number }>();

  /** With no home set, only the box owner is on the box. */
  const onBox = (pubkey: string) => (o.home ? db.onBox(pubkey, config.owner) : pubkey === config.owner);

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method !== 'POST') throw new Refusal(405, 'use POST');
      const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type !== CONTENT_TYPE) throw new Refusal(415, `content type must be ${CONTENT_TYPE}`);
      const body = await readBody(req, MAX_BODY);
      let call: { method: string; params: unknown[] };
      try {
        const j = JSON.parse(body.toString('utf8'));
        if (!j || typeof j !== 'object' || typeof j.method !== 'string' || (j.params !== undefined && !Array.isArray(j.params))) throw new Error();
        call = { method: j.method, params: j.params ?? [] };
      } catch {
        throw new Refusal(400, 'body must be {"method": "...", "params": [...]}');
      }
      if (!o.ready) throw new Refusal(503, 'this box is not set up yet: set STORAGE_PUBLIC_URL and STORAGE_OWNER');
      const caller = await signer(req, body);
      const r = run(caller, call.method, call.params);
      o.log(`places: ${r.line}`);
      return send(res, r.status ?? 200, r.body);
    } catch (err) {
      if (!(err instanceof Refusal)) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOSPC') {
          if (!res.headersSent) send(res, 507, { error: ERR.disk });
          return;
        }
        console.error(err);
        if (!res.headersSent) send(res, 500, { error: 'server error' });
        return;
      }
      if (err.status === 413 || err.status === 408) res.setHeader('connection', 'close'); // the rest of the body isn't read
      if (!res.headersSent && !res.destroyed) send(res, err.status, { error: err.message });
    }
  }

  /**
   * The signer, when it is on the box. The signature is checked first and every refusal after it is the same, so no
   * answer says whether a key is a member to someone who can't sign as it. Only a good signature from a key not on
   * the box makes storage ask the home again (at most once a minute overall).
   */
  async function signer(req: http.IncomingMessage, body: Buffer): Promise<string> {
    const p = parseAuth(req.headers.authorization, HTTP_AUTH_KIND);
    if (!p.ok) throw new Refusal(p.status, p.reason);
    const r = checkHttpAuth(p.event, { urls, method: 'POST', body }, o.now());
    if (!r.ok) throw new Refusal(r.status, r.reason);
    if (onBox(r.pubkey)) return r.pubkey;
    if (o.home) {
      await o.home.lookUp(); // maybe someone the home just added
      if (onBox(r.pubkey)) return r.pubkey;
    }
    throw new Refusal(401, NOT_ON_BOX);
  }

  /** Runs one call from a key on the box. Bad params are an error reply, not a refusal. */
  function run(caller: string, method: string, params: unknown[]): Reply {
    switch (method) {
      case 'members': {
        const keys = list(params, MAX_MEMBERS_ASKED, (x) => (typeof x === 'string' && HEX64.test(x) ? x : null));
        if (!keys) return { body: { error: ERR.members }, line: 'members refused (params)' };
        const result: Record<string, boolean> = {};
        let yes = 0;
        for (const k of keys) if ((result[k] = onBox(k))) yes++;
        return { body: { result }, line: `members ${keys.length} asked, ${yes} on the box` };
      }
      case 'put': {
        const note = params.length === 1 ? base64(params[0]) : null;
        if (!note || note.length < 1 || note.length > MAX_NOTE) return { body: { error: ERR.put }, line: 'put refused (params)' };
        const sha = createHash('sha256').update(note).digest('hex');
        if (db.hasNote(sha)) return { body: { result: { sha } }, line: 'put 1 note, already here' };
        const account = accountFor(caller);
        if (account === null) throw new Refusal(401, NOT_ON_BOX);
        if (db.noteCount(account) >= maxNotes) return { body: { error: ERR.tooMany }, line: 'put refused (too many notes)' };
        if (!o.room(note.length)) return { status: 507, body: { error: ERR.disk }, line: 'put refused (disk)' };
        db.putNote(sha, account, note, o.now());
        return { body: { result: { sha } }, line: 'put 1 note' };
      }
      case 'get': {
        const shas = list(params, MAX_SHAS, sha256);
        if (!shas) return { body: { error: ERR.get }, line: 'get refused (params)' };
        const found = db.getNotes(shas);
        const result: Record<string, string> = {};
        for (const [s, b] of found) result[s] = Buffer.from(b).toString('base64');
        return { body: { result }, line: `get ${shas.length} asked, ${found.size} found` };
      }
      case 'drop': {
        const shas = list(params, MAX_SHAS, sha256);
        if (!shas) return { body: { error: ERR.drop }, line: 'drop refused (params)' };
        const account = accountFor(caller);
        const dropped = account === null ? 0 : db.dropNotes(account, shas);
        return { body: { result: { dropped } }, line: `drop ${shas.length} asked, ${dropped} dropped` };
      }
      case 'names': {
        const points = pointsOf(params);
        if (!points) return { body: { error: ERR.names }, line: 'names refused (params)' };
        const t = o.towns;
        if (!t || t.state === 'none') return { body: { error: ERR.noTowns }, line: 'names: no town list' };
        if (t.state === 'loading') return { body: { error: ERR.loading }, line: 'names: still loading' };
        if (!take(caller)) return { status: 429, body: { error: ERR.namesLimit }, line: 'names refused (limit)' };
        const names = points.map(([lat, lon]) => t.nearest(round2(lat), round2(lon)));
        const named = names.filter((n) => n !== null).length;
        return { body: { result: { list: t.version, names } }, line: `names ${points.length} points, ${named} named` };
      }
    }
    return { body: { error: 'unknown method' }, line: 'unknown method' };
  }

  /**
   * The account a caller's notes belong to: its own (the box owner and members always have one), or the box owner's
   * when the caller is the home's owner and has none.
   */
  function accountFor(caller: string): string | null {
    const a = db.accountOf(caller);
    if (a) return a.pubkey;
    if (caller === db.homeRoles().owner && db.account(config.owner)) return config.owner;
    return null;
  }

  /** Takes one of the caller's `names` calls for this minute. False when it has none left. */
  function take(caller: string): boolean {
    const now = o.now();
    let w = lookups.get(caller);
    lookups.delete(caller);
    if (!w || now - w.start >= 60) w = { start: now, n: 0 };
    lookups.set(caller, w);
    while (lookups.size > 4096) lookups.delete(lookups.keys().next().value!);
    if (w.n >= NAMES_PER_MINUTE) return false;
    w.n++;
    return true;
  }

  return { handle };
}

/** `[[x, ...]]` with 1 to `max` items, each passed through `item`, distinct, in order; or null. */
function list(params: unknown[], max: number, item: (x: unknown) => string | null): string[] | null {
  const xs = params[0];
  if (params.length !== 1 || !Array.isArray(xs) || xs.length < 1 || xs.length > max) return null;
  const out = new Set<string>();
  for (const x of xs) {
    const v = item(x);
    if (v === null) return null;
    out.add(v);
  }
  return [...out];
}

/** A sha256 as hex, either case, as lowercase; or null. */
const sha256 = (x: unknown): string | null => {
  const s = typeof x === 'string' ? x.toLowerCase() : '';
  return HEX64.test(s) ? s : null;
};

/** Standard base64 (padding optional) into bytes, or null for anything else. */
function base64(x: unknown): Buffer | null {
  if (typeof x !== 'string' || x.length > Math.ceil(MAX_NOTE / 3) * 4 + 4) return null;
  const bare = x.replace(/={1,2}$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(bare) || bare.length % 4 === 1) return null;
  if (x.length !== bare.length && x.length % 4 !== 0) return null;
  const b = Buffer.from(bare, 'base64');
  // only the one encoding of these bytes: stray bits in the last character are not quietly dropped
  return b.toString('base64').replace(/=+$/, '') === bare ? b : null;
}

/** `[{"points": [[lat, lon], ...]}]`, 1 to MAX_POINTS points of finite numbers in range; or null. */
function pointsOf(params: unknown[]): [number, number][] | null {
  const p = params[0] as { points?: unknown } | undefined;
  if (params.length !== 1 || !p || typeof p !== 'object' || Array.isArray(p)) return null;
  const pts = p.points;
  if (!Array.isArray(pts) || pts.length < 1 || pts.length > MAX_POINTS) return null;
  const out: [number, number][] = [];
  for (const x of pts) {
    if (!Array.isArray(x) || x.length !== 2) return null;
    const [lat, lon] = x;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    out.push([lat, lon]);
  }
  return out;
}

/** To 2 decimals (about 1 km), as the app's place ids are. */
const round2 = (x: number) => Math.round(x * 100) / 100 + 0; // + 0 turns -0 into 0
