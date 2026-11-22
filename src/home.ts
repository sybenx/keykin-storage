// Accounts that follow a home's member list. The home (a relay the owner runs) says who its members are; members
// may upload here with the member quota. Storage asks with its own service key, keeps the last good list in its
// database, and never takes a failed, malformed or empty-looking answer as "everyone left".

import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from './auth.ts';
import type { Db } from './db.ts';
import type { ServiceKey } from './servicekey.ts';

// --- the home's reply, in one place: a field renamed on the home is a one-line change here

const REPLY = {
  result: 'result', error: 'error', owner: 'owner', members: 'members', removed: 'removed', admins: 'admins',
  pubkey: 'pubkey', removedAt: 'removedAt', deletesAt: 'deletesAt', reason: 'reason',
} as const;
/** What the home says when it doesn't know this storage's key yet (HTTP 401). */
const UNKNOWN_STORAGE = /storage service/i;
const METHOD = 'memberkeys';
const CONTENT_TYPE = 'application/nostr+json+rpc';
/** NIP-98 HTTP auth. */
const AUTH_KIND = 27235;

export interface MemberList {
  owner: string;
  members: string[];
  removed: { pubkey: string; removedAt: number; deletesAt: number | null; reason: 'removed' | 'erased' }[];
  /** Keys that may use this storage's management page besides the owner. A home that doesn't send it has none. */
  admins: string[];
}

export type HomeErrorKind = 'unknown-storage' | 'refused' | 'rate-limited' | 'unreachable' | 'malformed' | 'error';

export class HomeError extends Error {
  readonly kind: HomeErrorKind;
  constructor(kind: HomeErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Where member lists come from. The real one is `httpHome`; tests may give their own. */
export interface HomeSource {
  fetch(signal: AbortSignal): Promise<MemberList>;
}

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_REPLY = 1024 * 1024;

/** Reads a reply body into a member list. Throws HomeError: `error` for {"error": …}, `malformed` for the rest. */
export function parseReply(text: string): MemberList {
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new HomeError('malformed', 'not JSON');
  }
  if (!j || typeof j !== 'object') throw new HomeError('malformed', 'not a JSON object');
  if (j[REPLY.error] !== undefined) throw new HomeError('error', String(j[REPLY.error]).slice(0, 200));
  const r = j[REPLY.result];
  if (!r || typeof r !== 'object') throw new HomeError('malformed', `no ${REPLY.result}`);
  const hex = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || !HEX64.test(v.toLowerCase())) throw new HomeError('malformed', `${what} is not a hex pubkey`);
    return v.toLowerCase();
  };
  const owner = hex(r[REPLY.owner], REPLY.owner);
  if (!Array.isArray(r[REPLY.members])) throw new HomeError('malformed', `${REPLY.members} is not a list`);
  const members = [...new Set((r[REPLY.members] as unknown[]).map((m) => hex(m, 'a member')))];
  const rawRemoved = r[REPLY.removed] ?? [];
  if (!Array.isArray(rawRemoved)) throw new HomeError('malformed', `${REPLY.removed} is not a list`);
  const removed = rawRemoved.map((x: any) => {
    if (!x || typeof x !== 'object') throw new HomeError('malformed', 'a removal is not an object');
    const removedAt = x[REPLY.removedAt], deletesAt = x[REPLY.deletesAt];
    if (!Number.isSafeInteger(removedAt) || removedAt <= 0) throw new HomeError('malformed', `${REPLY.removedAt} is not a time`);
    if (deletesAt !== undefined && deletesAt !== null && !Number.isSafeInteger(deletesAt)) throw new HomeError('malformed', `${REPLY.deletesAt} is not a time`);
    // "erased": the person deleted their own account on the home. Anything else, or nothing, is a plain removal.
    const reason: 'removed' | 'erased' = x[REPLY.reason] === 'erased' ? 'erased' : 'removed';
    return { pubkey: hex(x[REPLY.pubkey], 'a removed pubkey'), removedAt, deletesAt: deletesAt ?? null, reason };
  });
  const rawAdmins = r[REPLY.admins] ?? [];
  if (!Array.isArray(rawAdmins)) throw new HomeError('malformed', `${REPLY.admins} is not a list`);
  const admins = [...new Set((rawAdmins as unknown[]).map((a) => hex(a, 'an admin')))];
  return { owner, members, removed, admins };
}

/** The body storage sends, byte for byte (its hash is in the auth). */
export const REQUEST_BODY = JSON.stringify({ method: METHOD, params: [] });

/** The Authorization header for one request: a kind 27235 event over the exact url, method and body. */
export function signRequest(url: string, body: string, key: ServiceKey, now: number): string {
  const e: any = {
    pubkey: key.pk, created_at: now, kind: AUTH_KIND, content: '',
    tags: [['u', url], ['method', 'POST'], ['payload', createHash('sha256').update(body).digest('hex')]],
  };
  e.id = eventId(e);
  e.sig = Buffer.from(schnorr.sign(Buffer.from(e.id, 'hex'), key.sk)).toString('hex');
  return 'Nostr ' + Buffer.from(JSON.stringify(e)).toString('base64');
}

/** The url requests go to: the home's url with one trailing slash. */
export const requestUrl = (homeUrl: string) => homeUrl.replace(/\/+$/, '') + '/';

/**
 * Asks a home over https (http only when a test allows it): POST, a timeout, at most 1 MiB back, no redirects
 * followed. The url is the operator's own setting, so it isn't held to the mirror's address rules.
 */
export function httpHome(homeUrl: string, key: ServiceKey, opts: { timeoutMs: number; now: () => number }): HomeSource {
  const url = requestUrl(homeUrl);
  return {
    fetch: (signal) => new Promise<MemberList>((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const both = AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs)]);
      const req = mod.request(u, {
        method: 'POST', signal: both,
        headers: {
          'content-type': CONTENT_TYPE, accept: 'application/json', 'user-agent': 'keykin-storage',
          'content-length': Buffer.byteLength(REQUEST_BODY), authorization: signRequest(url, REQUEST_BODY, key, opts.now()),
        },
      }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return reject(new HomeError('error', `the home answered ${status} (a redirect); redirects are not followed, so check STORAGE_HOME_URL`));
        }
        const parts: Buffer[] = [];
        let n = 0;
        res.on('data', (c: Buffer) => {
          n += c.length;
          if (n > MAX_REPLY) {
            res.destroy();
            return reject(new HomeError('malformed', 'the answer is over 1 MiB'));
          }
          parts.push(c);
        });
        res.on('error', (err) => reject(new HomeError('unreachable', err.message)));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let reason = '';
          try {
            reason = String(JSON.parse(text)?.[REPLY.error] ?? '');
          } catch {}
          if (status === 401 && UNKNOWN_STORAGE.test(reason)) return reject(new HomeError('unknown-storage', reason));
          if (status === 401) return reject(new HomeError('refused', reason || 'refused'));
          if (status === 429) return reject(new HomeError('rate-limited', reason || 'too many requests'));
          if (status !== 200) return reject(new HomeError('error', `the home answered ${status}${reason ? `: ${reason}` : ''}`));
          try {
            resolve(parseReply(text));
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('error', (err: any) => {
        const timedOut = both.aborted && !signal.aborted;
        reject(err instanceof HomeError ? err : new HomeError('unreachable', timedOut ? 'no answer in time' : err.message));
      });
      req.end(REQUEST_BODY);
    }),
  };
}

/** Plain words for `home status` and the log. */
export function describeError(kind: string, message: string): string {
  switch (kind) {
    case 'unknown-storage': return 'the home does not know this storage yet: register this storage\'s public key on the home (see `home key`)';
    case 'refused': return `the home refused this storage's signature (${message}). The likely cause is this box's clock being off`;
    case 'rate-limited': return 'the home says storage asked too often; it waits before asking again';
    case 'unreachable': return `could not reach the home: ${message}`;
    case 'malformed': return `the home's answer was not a member list: ${message}`;
    default: return `the home answered with an error: ${message}`;
  }
}

export interface HomeOptions {
  /** The box owner (hex): never a member, always unlimited. */
  owner: string;
  memberQuota: number;
  pollS: number;
  now: () => number;
  log: (line: string) => void;
  /** Deletes an erased blob's file (after the database no longer has it). */
  removeFile: (sha256: string) => void;
}

export type SyncResult =
  | { ok: true; joined: number; left: number; held: number }
  | { ok: false; kind: HomeErrorKind; message: string };

/** A lookup on a miss runs at most this often, seconds, so strangers can't make storage hammer the home. */
export const MISS_INTERVAL = 60;
/** After a 429 from the home, no fetch for this long, seconds. */
const BACKOFF = 120;
/** A poll that would remove more than half of a list this long or longer is held for `home apply`. */
const HOLD_FROM = 4;

interface Held {
  pubkey: string;
  removedAt: number;
  deletesAt: number | null;
  reason: 'removed' | 'erased';
}

/** Keeps the accounts in step with the home's member list. */
export class Home {
  private readonly db: Db;
  private readonly source: HomeSource;
  private readonly o: HomeOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private inflight: Promise<SyncResult> | null = null;
  private lastMiss = -Infinity;
  private backoffUntil = -Infinity;
  private timer: NodeJS.Timeout | undefined;
  private readonly stopping = new AbortController();
  private lastLogged = '';

  constructor(db: Db, source: HomeSource, opts: HomeOptions) {
    this.db = db;
    this.source = source;
    this.o = opts;
  }

  /** Polls every pollS seconds, and once now. */
  start(): void {
    this.timer = setInterval(() => void this.sync({ poll: true }), this.o.pollS * 1000);
    this.timer.unref();
    void this.sync({ poll: true });
  }

  /** Stops polling and gives up on a fetch in flight. Resolves once nothing is running. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.stopping.abort();
    await this.queue.catch(() => {});
  }

  /** Fetches the list now and applies it (one at a time). A poll skips while backing off after a 429. */
  sync(opts: { poll?: boolean } = {}): Promise<SyncResult> {
    const run = async (): Promise<SyncResult> => {
      if (this.stopping.signal.aborted) return { ok: false, kind: 'unreachable', message: 'stopping' };
      if (opts.poll && this.o.now() < this.backoffUntil) return { ok: false, kind: 'rate-limited', message: 'backing off' };
      this.db.saveHomeState({ lastTry: this.o.now() });
      let list: MemberList;
      try {
        list = await this.source.fetch(this.stopping.signal);
      } catch (err) {
        const e = err instanceof HomeError ? err : new HomeError('unreachable', (err as Error).message);
        if (e.kind === 'rate-limited') this.backoffUntil = this.o.now() + BACKOFF;
        if (!this.stopping.signal.aborted) {
          this.db.saveHomeState({ errorKind: e.kind, error: e.message });
          this.logOnce(`home: ${describeError(e.kind, e.message)}. Keeping the last good member list.`);
        }
        return { ok: false, kind: e.kind, message: e.message };
      }
      return this.apply(list, false);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    this.inflight = p;
    void p.finally(() => { if (this.inflight === p) this.inflight = null; });
    return p;
  }

  /**
   * An unknown key tried to write: refresh the list once and let the caller look again. Joins a fetch already in
   * flight; otherwise fetches at most once per MISS_INTERVAL overall, and not while backing off.
   */
  async lookUp(): Promise<void> {
    if (this.inflight) {
      await this.inflight.catch(() => {});
      return;
    }
    const now = this.o.now();
    if (now - this.lastMiss < MISS_INTERVAL || now < this.backoffUntil) return;
    this.lastMiss = now;
    await this.sync().catch(() => {});
  }

  /** `home apply`: applies the last good list with any held removals. */
  applyHeld(): SyncResult {
    const s = this.db.homeState();
    if (!s.list) return { ok: false, kind: 'error', message: 'no member list yet: run `home sync` first' };
    return this.apply(JSON.parse(s.list) as MemberList, true);
  }

  /** Applies a good list in one transaction. Removals that look like a mistake are held unless `force`. */
  private apply(list: MemberList, force: boolean): SyncResult {
    const now = this.o.now();
    const erased: string[] = [];
    const r = this.db.tx(() => {
      const state = this.db.homeState();
      const before = new Set(this.db.members());
      const wanted = new Set(list.members);
      wanted.add(list.owner); // the home's owner may always write here...
      wanted.delete(this.o.owner); // ...and is this box's unlimited owner when it is the same key
      const prevHeld = new Map<string, Held>((state.held ? JSON.parse(state.held) as Held[] : []).map((h) => [h.pubkey, h]));
      const explicit = new Map(list.removed.map((x) => [x.pubkey, x]));

      const leaving: Held[] = [];
      for (const k of before) {
        if (wanted.has(k)) continue;
        const x = explicit.get(k);
        // gone from both lists (the home lists a removal for 14 days only): removed when first noticed
        leaving.push(x ? { pubkey: k, removedAt: Math.min(x.removedAt, now), deletesAt: x.deletesAt, reason: x.reason }
          : { pubkey: k, removedAt: prevHeld.get(k)?.removedAt ?? now, deletesAt: null, reason: 'removed' });
      }
      const tooMany = before.size >= HOLD_FROM && leaving.length > before.size / 2;
      // an empty list where people just vanished is more likely a fault on the home than everyone leaving at once
      const emptyLooking = list.members.length === 0 && leaving.some((l) => !explicit.has(l.pubkey));
      const hold = !force && leaving.length > 0 && (tooMany || emptyLooking);

      this.db.setMemberQuota(this.o.memberQuota);
      let joined = 0;
      for (const k of wanted) {
        if (!before.has(k)) {
          this.db.joinMember(k, this.o.memberQuota, now);
          joined++;
        }
      }
      if (!hold) for (const l of leaving) erased.push(...this.db.leaveMember({ ...l, noticed: now }, now));
      const held = hold ? leaving : [];
      const heldJson = held.length ? JSON.stringify(held) : null;
      if (heldJson !== state.held) {
        if (held.length) {
          this.o.log(`home: holding the removal of ${held.length} of ${before.size} members (${tooMany ? 'more than half at once' : 'the home sent an empty member list'}). ` +
            'Check the home; if it is right, run `home apply`.');
        }
      }
      this.db.saveHomeState({
        lastGood: now, list: JSON.stringify(list), errorKind: null, error: null,
        homeOwner: list.owner, admins: JSON.stringify(list.admins ?? []), // a list stored by 0.2.0 has no admins
        held: heldJson, heldSince: held.length ? (state.heldSince ?? now) : null,
      });
      return { ok: true as const, joined, left: hold ? 0 : leaving.length, held: held.length };
    });
    for (const sha of erased) this.o.removeFile(sha);
    if (r.joined || r.left) this.o.log(`home: ${r.joined} joined, ${r.left} left; ${this.db.members().length} members now`);
    this.lastLogged = '';
    return r;
  }

  private logOnce(line: string): void {
    if (line === this.lastLogged) return;
    this.lastLogged = line;
    this.o.log(line);
  }
}

