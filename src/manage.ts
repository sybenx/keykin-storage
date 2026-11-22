// The management surface: `POST /manage`, one call per request, `{"method": …, "params": […]}` in and
// `{"result": …}` or `{"error": …}` out, signed with NIP-98 (kind 27235) by the box owner, the home's owner or one
// of the home's admins. It shows disk use and the bin, and restores or erases what is in the bin. Every call is a
// few indexed reads or one transaction: nothing walks the blob folder or sums every blob.

import { statfsSync } from 'node:fs';
import type http from 'node:http';
import { checkHttpAuth, HTTP_AUTH_KIND, parseAuth } from './auth.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { Home } from './home.ts';
import type { ServiceKey } from './servicekey.ts';

export const MANAGE_PATH = '/manage';
export const INFO_PATH = '/manage/info';
export const CONTENT_TYPE = 'application/nostr+json+rpc';
/** Largest body read, bytes. */
export const MAX_BODY = 64 * 1024;
/** A body declared or sent past this is not read at all: the connection is closed. */
const HARD_MAX = 1024 * 1024;
const BODY_TIMEOUT_MS = 10_000;
/** Most hashes one restore or erase may name. */
export const MAX_HASHES = 500;
/** Most bin items one `bin` call returns, newest first. */
export const MAX_BIN_ITEMS = 5000;
const DAY = 86400;
const SHA256 = /^[0-9a-f]{64}$/;
/** The one answer for a good signature from a key that may not do what it asked, whatever its role. */
const NOT_ALLOWED = 'this key may not manage this box';

type Role = 'owner' | 'admin';

/** Who may call each method. `info` needs no signature at all. */
const METHODS: Record<string, Role[]> = {
  usage: ['owner', 'admin'],
  bin: ['owner', 'admin'],
  restore: ['owner', 'admin'],
  erase: ['owner'],
};

export interface ManageOptions {
  config: Config;
  db: Db;
  /** The home this storage follows, or null. Its owner and admins may manage too. */
  home: Home | null;
  key: ServiceKey;
  /** Whether the box is set up (STORAGE_PUBLIC_URL and STORAGE_OWNER). */
  ready: boolean;
  now: () => number;
  /** Deletes an erased blob's file (after its row is gone). */
  removeFile: (sha256: string) => void;
}

class Refusal extends Error {
  readonly status: number;
  constructor(status: number, reason: string) {
    super(reason);
    this.status = status;
  }
}

export function send(res: http.ServerResponse, status: number, body: unknown, head = false): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(head ? undefined : JSON.stringify(body));
}

/** Whether a path belongs to the management surface (so its refusals are JSON). */
export const isManagePath = (path: string) => path === MANAGE_PATH || path === INFO_PATH;

export function manager(o: ManageOptions) {
  const { config, db } = o;
  const base = config.publicUrl.replace(/\/+$/, '');
  // the exact url a client signs: the public url and /manage, with or without a slash left on the base
  const urls = [`${base}${MANAGE_PATH}`, `${base}/${MANAGE_PATH}`];
  const binS = Math.ceil(config.binDays * DAY);

  const info = () => ({ pubkey: o.key.pk, home: o.home ? config.homeUrl : null });

  function roleOf(pubkey: string): Role | null {
    if (pubkey === config.owner) return 'owner';
    if (!o.home) return null; // a home no longer set says nothing about who manages this box
    const r = db.homeRoles();
    if (pubkey === r.owner) return 'owner';
    if (r.admins.includes(pubkey)) return 'admin';
    return null;
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    try {
      if (path === INFO_PATH) {
        if (method !== 'GET' && method !== 'HEAD') throw new Refusal(405, 'use GET');
        return send(res, 200, { result: info() }, method === 'HEAD');
      }
      if (method !== 'POST') throw new Refusal(405, 'use POST');
      const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type !== CONTENT_TYPE) throw new Refusal(415, `content type must be ${CONTENT_TYPE}`);
      const body = await readBody(req);
      let call: { method: string; params: unknown[] };
      try {
        const j = JSON.parse(body.toString('utf8'));
        if (!j || typeof j !== 'object' || typeof j.method !== 'string' || (j.params !== undefined && !Array.isArray(j.params))) throw new Error();
        call = { method: j.method, params: j.params ?? [] };
      } catch {
        throw new Refusal(400, 'body must be {"method": "...", "params": [...]}');
      }
      if (call.method === 'info') return send(res, 200, { result: info() });
      if (!o.ready) throw new Refusal(503, 'this box is not set up yet: set STORAGE_PUBLIC_URL and STORAGE_OWNER');
      const role = await signer(req, body);
      const allowed = METHODS[call.method];
      if (!allowed) return send(res, 200, { error: 'unknown method' });
      if (!allowed.includes(role)) throw new Refusal(401, NOT_ALLOWED); // the same words as for a stranger
      return send(res, 200, run(call.method, call.params));
    } catch (err) {
      if (!(err instanceof Refusal)) {
        console.error(err);
        if (!res.headersSent) send(res, 500, { error: 'server error' });
        return;
      }
      if (err.status === 413 || err.status === 408) res.setHeader('connection', 'close'); // the rest of the body isn't read
      if (!res.headersSent && !res.destroyed) send(res, err.status, { error: err.message });
    }
  }

  /**
   * The signer's role. Unlike uploads, the signature is checked first: the home keeps its admin list private, so
   * whether a key has a role here must not show in any answer to someone who can't sign as that key. Every refusal
   * before the signature depends only on the request; every refusal after it is the same NOT_ALLOWED. The per-address
   * limit bounds what the signature checks cost. Only a good signature may make storage ask the home again.
   */
  async function signer(req: http.IncomingMessage, body: Buffer): Promise<Role> {
    const p = parseAuth(req.headers.authorization, HTTP_AUTH_KIND);
    if (!p.ok) throw new Refusal(p.status, p.reason);
    const r = checkHttpAuth(p.event, { urls, method: 'POST', body }, o.now());
    if (!r.ok) throw new Refusal(r.status, r.reason);
    let role = roleOf(r.pubkey);
    if (!role && o.home) {
      await o.home.lookUp(); // maybe an admin the home just added (at most once a minute overall)
      role = roleOf(r.pubkey);
    }
    if (!role) throw new Refusal(401, NOT_ALLOWED);
    return role;
  }

  /** Runs one allowed call. Bad params are an error reply, not a refusal. */
  function run(method: string, params: unknown[]): { result: unknown } | { error: string } {
    switch (method) {
      case 'usage':
        return { result: usage() };
      case 'bin':
        return { result: bin() };
      case 'restore': {
        const shas = hashes(params);
        if (typeof shas === 'string') return { error: shas };
        const fallback = config.owner;
        const restored = db.tx(() => shas.filter((s) => db.restore(s, o.now(), { fallback }) !== null).length);
        return { result: { restored } };
      }
      case 'erase': {
        const shas = hashes(params);
        if (typeof shas === 'string') return { error: shas };
        const erased = db.tx(() => shas.filter((s) => db.eraseNow(s)));
        for (const s of erased) o.removeFile(s);
        return { result: { erased: erased.length } };
      }
    }
    return { error: 'unknown method' };
  }

  function usage() {
    let disk: { used: number | null; free: number | null } = { used: null, free: null };
    try {
      const s = statfsSync(config.dataDir);
      disk = { used: (s.blocks - s.bfree) * s.bsize, free: s.bavail * s.bsize };
    } catch {}
    return {
      disk,
      total: db.totals(),
      accounts: db.accounts().map((a) => ({
        pubkey: a.pubkey, used: Number(a.used), blobs: Number(a.blobs), quota: a.quota === null ? null : Number(a.quota),
        member: !!a.member, hand: !!a.hand,
      })),
    };
  }

  function bin() {
    const rows = db.binned(MAX_BIN_ITEMS + 1);
    const now = o.now();
    return {
      items: rows.slice(0, MAX_BIN_ITEMS).map((b) => ({
        sha256: b.sha256, size: Number(b.size), type: b.type, charged: b.charged, binnedAt: Number(b.binned), erasesAt: Number(b.binned) + binS,
      })),
      more: rows.length > MAX_BIN_ITEMS,
      // what the bin erases first is gone after binDays: only removals whose time isn't up are still waiting
      parked: db.parked(now - binS).map((p) => ({
        pubkey: p.pubkey, removedAt: Number(p.removedAt), reason: p.reason, bytes: Number(p.bytes), blobs: Number(p.blobs),
        erasesAt: Number(p.removedAt) + binS,
      })),
    };
  }

  return { handle };
}

/** `[[sha256, …]]` into distinct lowercase hashes, or why not. */
function hashes(params: unknown[]): string[] | string {
  const list = params[0];
  if (params.length !== 1 || !Array.isArray(list)) return 'params must be [[sha256, ...]]';
  if (list.length > MAX_HASHES) return `at most ${MAX_HASHES} hashes per call`;
  const out = new Set<string>();
  for (const x of list) {
    const s = typeof x === 'string' ? x.toLowerCase() : '';
    if (!SHA256.test(s)) return `not a sha256: ${JSON.stringify(x)?.slice(0, 80)}`;
    out.add(s);
  }
  return [...out];
}

/**
 * Reads a body of at most MAX_BODY bytes. A larger one is read to its end and refused (so the client gets the
 * answer, not a reset), unless it is past HARD_MAX, which is not read at all.
 */
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const declared = req.headers['content-length'];
  if (declared && /^\d+$/.test(declared) && Number(declared) > HARD_MAX) return Promise.reject(new Refusal(413, `body is over ${MAX_BODY / 1024} KiB`));
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let n = 0;
    const timer = setTimeout(() => {
      req.pause();
      reject(new Refusal(408, 'body too slow'));
    }, BODY_TIMEOUT_MS);
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > HARD_MAX) {
        clearTimeout(timer);
        req.destroy();
        return reject(new Refusal(413, `body is over ${MAX_BODY / 1024} KiB`));
      }
      if (n <= MAX_BODY) parts.push(c);
    });
    req.on('end', () => {
      clearTimeout(timer);
      if (n > MAX_BODY) reject(new Refusal(413, `body is over ${MAX_BODY / 1024} KiB`));
      else resolve(Buffer.concat(parts));
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
