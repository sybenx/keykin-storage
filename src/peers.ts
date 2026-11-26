// Copies between boxes. Every box keeps a full copy of what its peers hold: it asks each peer what changed since it
// last asked (`POST /peer`, signed with this box's service key, answered only for keys in the peer's own list), takes
// in who holds what and what was let go or erased, and fetches the files it lacks with a plain GET, checking each
// sha256. Uploads go to whichever box a phone reaches first; the rest follow within a minute or so.
//
// - Nothing is inferred from a missing file. Only a let-go or an erase that a peer recorded moves anything here.
// - For each key the later change wins and a let-go wins a tie; an erase kills every hold from before it (db.ts). So
//   reading the same change twice changes nothing, and two boxes that both changed end up the same, with nothing
//   erased coming back.
// - Files stream to disk and are hashed as they arrive, so a video of many GB never sits in memory.
// - Peers are the owner's own setting, so a peer may sit on a tailnet (100.x) or a LAN address. That holds for peers
//   only: BUD-04 /mirror keeps its address rules (mirror.ts).

import http from 'node:http';
import https from 'node:https';
import { checkHttpAuth, HTTP_AUTH_KIND, parseAuth } from './auth.ts';
import type { Change, Db, Hold } from './db.ts';
import { signRequest } from './home.ts';
import { CONTENT_TYPE, readBody, Refusal, send } from './manage.ts';
import type { ServiceKey } from './servicekey.ts';
import { Aborted, TooLarge, type Store } from './store.ts';

export const PEER_PATH = '/peer';
/** Changes in one answer, at most. */
export const MAX_PAGE = 500;
/** Holds of one blob in an answer, at most (a blob is held by a few keys). */
const MAX_HOLDS = 10_000;
/** Largest answer read, bytes. */
const MAX_REPLY = 32 * 1024 * 1024;
const H64 = /^[0-9a-f]{64}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
/** The one answer for a good signature from a key that is not a peer. */
const NOT_A_PEER = 'this key is not a peer of this box';
/** Copies tried each round, at most; the rest wait for the next round. */
const WANTS_PER_ROUND = 200;
/** A copy that failed is tried again after a minute, then twice as long each time, up to six hours. */
const RETRY_S = 60, RETRY_MAX_S = 6 * 3600;

export interface PeerConfig {
  /** What the admin page calls it ("xumbrel"). */
  name: string;
  /** Where this box reaches it, with no trailing slash (http://100.x.y.z:7480 or https://storage2.example.com). */
  url: string;
  /** Its service key (hex): what it signs with when it asks this box, and what this box expects from it. */
  pubkey: string;
}

/** How one peer is doing, for the admin page. */
export interface PeerStatus {
  name: string;
  url: string;
  pubkey: string;
  /** Blobs on the peer at the last good read (null before one). */
  blobs: number | null;
  /** How many of those are here: `blobs` less the files still to copy that came from it. */
  copied: number | null;
  /** Files from it still to copy. */
  waiting: number;
  /** Changes on the peer not read yet (null before a good read). */
  behind: number | null;
  lastOk: number | null;
  lastTry: number | null;
  error: string | null;
}

// --- the answering side: POST /peer

export const isPeerPath = (path: string) => path === PEER_PATH;

/**
 * Answers peers. `{"method":"changes","params":[cursor, limit]}` → `{"result":{changes, head, blobs, more}}`. Signed
 * NIP-98 by a key in the peer list; the `u` tag must name `/peer` on whatever address the peer reaches this box at (a
 * tailnet address is not this box's public url), within a minute, over the exact body.
 */
export function peerHandler(o: { db: Db; peers: () => PeerConfig[]; now: () => number }) {
  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (o.peers().length === 0) throw new Refusal(404, 'this box has no peers');
      if (req.method !== 'POST') throw new Refusal(405, 'use POST');
      const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type !== CONTENT_TYPE) throw new Refusal(415, `content type must be ${CONTENT_TYPE}`);
      const body = await readBody(req, 4096);
      const p = parseAuth(req.headers.authorization, HTTP_AUTH_KIND);
      if (!p.ok) throw new Refusal(p.status, p.reason);
      const u = p.event.tags.find((t) => t[0] === 'u')?.[1] ?? '';
      let path = '';
      try {
        path = new URL(u).pathname;
      } catch {}
      if (path !== PEER_PATH) throw new Refusal(401, 'authorization is for another url');
      const r = checkHttpAuth(p.event, { urls: [u], method: 'POST', body }, o.now());
      if (!r.ok) throw new Refusal(r.status, r.reason);
      if (!o.peers().some((x) => x.pubkey === r.pubkey)) throw new Refusal(401, NOT_A_PEER);
      let call: { method: string; params: unknown[] };
      try {
        const j = JSON.parse(body.toString('utf8'));
        if (!j || typeof j.method !== 'string' || (j.params !== undefined && !Array.isArray(j.params))) throw new Error();
        call = { method: j.method, params: j.params ?? [] };
      } catch {
        throw new Refusal(400, 'body must be {"method": "...", "params": [...]}');
      }
      if (call.method !== 'changes') return send(res, 200, { error: 'unknown method' });
      const [cursor, limit = MAX_PAGE] = call.params;
      if (!Number.isSafeInteger(cursor) || (cursor as number) < 0) return send(res, 200, { error: 'params must be [cursor, limit]' });
      if (!Number.isSafeInteger(limit) || (limit as number) < 1) return send(res, 200, { error: 'params must be [cursor, limit]' });
      const n = Math.min(limit as number, MAX_PAGE);
      const page = o.db.changesSince(cursor as number, n);
      const next = page.changes.length ? page.changes[page.changes.length - 1].seq : (cursor as number);
      return send(res, 200, {
        result: { changes: page.changes, next, head: page.head, more: next < page.head, blobs: o.db.totals().blobs },
      });
    } catch (err) {
      if (!(err instanceof Refusal)) {
        console.error(err);
        if (!res.headersSent) send(res, 500, { error: 'server error' });
        return;
      }
      if (err.status === 413 || err.status === 408) res.setHeader('connection', 'close');
      if (!res.headersSent && !res.destroyed) send(res, err.status, { error: err.message });
    }
  }
  return { handle };
}

// --- the asking side

export interface PeersOptions {
  db: Db;
  store: Store;
  key: ServiceKey;
  peers: PeerConfig[];
  now: () => number;
  log: (line: string) => void;
  /** Seconds between rounds. */
  pollS: number;
  /** Days a binned blob stays: one binned longer than that on a peer is not copied. */
  binDays: number;
  /** Largest file this box keeps. */
  maxBlobBytes: number;
  /** Whether `n` more bytes leave the disk margin free. */
  room: (n: number) => boolean;
  /** Ms one request may sit with nothing arriving (default 60 s). */
  idleMs?: number;
}

class PeerError extends Error {}

export class Peers {
  private readonly o: PeersOptions;
  private timer: NodeJS.Timeout | null = null;
  private round: Promise<void> | null = null;
  private again = false;
  private readonly stopping = new AbortController();

  constructor(o: PeersOptions) {
    this.o = o;
    o.db.setPeers(o.peers);
  }

  /** Runs a round now and then every pollS seconds. */
  start(): void {
    void this.sync();
    this.timer = setInterval(() => void this.sync(), this.o.pollS * 1000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.stopping.abort();
    await this.round?.catch(() => {});
  }

  /**
   * One round: read every peer's changes, then copy what is missing. A call during a round waits for it and runs one
   * more after, so what it asked for is seen. Never throws.
   */
  sync(): Promise<void> {
    if (this.stopping.signal.aborted) return Promise.resolve();
    if (this.round) {
      this.again = true;
      return this.round;
    }
    this.round = (async () => {
      do {
        this.again = false;
        for (const p of this.o.peers) await this.read(p);
        await this.copy();
      } while (this.again && !this.stopping.signal.aborted);
    })().finally(() => {
      this.round = null;
    });
    return this.round;
  }

  status(): PeerStatus[] {
    return statusOf(this.o.db);
  }

  /** Reads a peer's changes since the last good read, page by page, taking each page in one at a time. */
  private async read(p: PeerConfig): Promise<void> {
    const { db, now } = this.o;
    const binBefore = () => now() - Math.ceil(this.o.binDays * 86400);
    db.savePeer(p.pubkey, { lastTry: now() });
    const wasDown = !!db.peerRows().find((r) => r.pubkey === p.pubkey)?.error;
    try {
      for (let pages = 0; pages < 10_000; pages++) {
        const row = db.peerRows().find((r) => r.pubkey === p.pubkey);
        const cursor = row?.cursor ?? 0;
        const page = await this.changes(p, cursor);
        let erased = 0, wanted = 0;
        for (const c of page.changes) {
          const r = db.applyPeer(c, p.pubkey, binBefore());
          if (r === 'erase') {
            this.o.store.remove(c.sha256);
            erased++;
          } else if (r === 'want') wanted++;
        }
        db.savePeer(p.pubkey, { cursor: Math.max(cursor, page.next), head: page.head, blobs: page.blobs, lastOk: now(), error: null });
        if (pages === 0 && wasDown) db.retryWants(p.pubkey); // what failed while it was away need not wait out its retry
        if (erased || wanted) this.o.log(`peer ${p.name}: ${page.changes.length} changes, ${wanted} files to copy, ${erased} erased`);
        if (!page.more || this.stopping.signal.aborted) break;
      }
    } catch (err) {
      const msg = err instanceof PeerError ? err.message : `could not reach it (${(err as Error).message ?? err})`;
      const before = db.peerRows().find((r) => r.pubkey === p.pubkey)?.error;
      db.savePeer(p.pubkey, { error: msg });
      if (before !== msg) this.o.log(`peer ${p.name}: ${msg}`);
    }
  }

  /** Copies wanted files whose try is due, one at a time, from the peer that told of it first, then the others. */
  private async copy(): Promise<void> {
    const { db, now } = this.o;
    for (const w of db.wants(now(), WANTS_PER_ROUND)) {
      if (this.stopping.signal.aborted) return;
      const order = [...this.o.peers].sort((a, b) => (a.pubkey === w.peer ? -1 : b.pubkey === w.peer ? 1 : 0));
      let why = 'no peer has it';
      let done = false;
      if (w.size > this.o.maxBlobBytes) why = `it is ${w.size} bytes, more than this box keeps`;
      else if (!this.o.room(w.size)) why = 'this box is out of disk space';
      else {
        for (const p of order) {
          try {
            await this.fetchOne(p, w.sha256, w.size);
            done = true;
            break;
          } catch (err) {
            why = `${p.name}: ${err instanceof PeerError ? err.message : (err as Error).message}`;
          }
        }
      }
      if (!done) {
        const wait = Math.min(RETRY_S * 2 ** Math.min(w.tries, 20), RETRY_MAX_S);
        db.wantFailed(w.sha256, now() + wait, why);
      }
    }
  }

  /** GETs one blob from a peer into place, streaming and hashing it. Throws PeerError when it can't. */
  private fetchOne(p: PeerConfig, sha256: string, size: number): Promise<void> {
    const { store, db } = this.o;
    return new Promise<void>((resolve, reject) => {
      const u = new URL(`${p.url}/${sha256}`);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.get(u, { signal: this.stopping.signal, headers: { 'user-agent': 'keykin-storage' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new PeerError(res.statusCode === 404 ? 'not there (yet)' : `answered ${res.statusCode}`));
        }
        const len = res.headers['content-length'];
        if (len !== undefined && Number(len) !== size) {
          res.destroy();
          return reject(new PeerError(`sent ${len} bytes, not ${size}`));
        }
        store.receive(res, size).then((got) => {
          if (got.sha256 !== sha256 || got.size !== size) {
            store.discard(got.tmp);
            return reject(new PeerError('sent other bytes than the hash says'));
          }
          let placed = false;
          try {
            placed = db.placeCopy(sha256, () => store.commit(got));
          } catch (err) {
            store.discard(got.tmp);
            return reject(err);
          }
          if (!placed) store.discard(got.tmp);
          resolve();
        }, (err) => {
          if (err instanceof TooLarge) reject(new PeerError('sent more bytes than the hash says'));
          else if (err instanceof Aborted) reject(new PeerError('the copy was cut off'));
          else reject(err);
        });
      });
      req.setTimeout(this.o.idleMs ?? 60_000, () => req.destroy(new PeerError('nothing arrived for a minute')));
      req.on('error', (err) => reject(err instanceof PeerError ? err : new PeerError(`could not reach it (${err.message})`)));
    });
  }

  /** One page of a peer's changes, checked. */
  private changes(p: PeerConfig, cursor: number): Promise<{ changes: Change[]; next: number; head: number; blobs: number; more: boolean }> {
    const url = `${p.url}${PEER_PATH}`;
    const body = JSON.stringify({ method: 'changes', params: [cursor, MAX_PAGE] });
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(u, {
        method: 'POST', signal: this.stopping.signal,
        headers: {
          'content-type': CONTENT_TYPE, accept: 'application/json', 'user-agent': 'keykin-storage',
          'content-length': Buffer.byteLength(body), authorization: signRequest(url, body, this.o.key, this.o.now()),
        },
      }, (res) => {
        const parts: Buffer[] = [];
        let n = 0;
        res.on('data', (c: Buffer) => {
          n += c.length;
          if (n > MAX_REPLY) {
            res.destroy();
            reject(new PeerError('its answer is too large'));
          } else parts.push(c);
        });
        res.on('error', (err) => reject(new PeerError(`could not reach it (${err.message})`)));
        res.on('end', () => {
          let j: any;
          try {
            j = JSON.parse(Buffer.concat(parts).toString('utf8'));
          } catch {
            return reject(new PeerError(`answered ${res.statusCode} without JSON`));
          }
          if (res.statusCode === 401 && j?.error === NOT_A_PEER) {
            return reject(new PeerError('it does not know this box: add this box to its STORAGE_PEERS'));
          }
          if (res.statusCode !== 200 || j?.error !== undefined) return reject(new PeerError(`answered ${res.statusCode}: ${String(j?.error ?? '').slice(0, 200)}`));
          try {
            resolve(parsePage(j.result, cursor));
          } catch (err) {
            reject(err);
          }
        });
      });
      req.setTimeout(this.o.idleMs ?? 60_000, () => req.destroy(new PeerError('nothing arrived for a minute')));
      req.on('error', (err) => reject(err instanceof PeerError ? err : new PeerError(`could not reach it (${err.message})`)));
      req.end(body);
    });
  }
}

const int = (v: unknown, what: string): number => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new PeerError(`its answer is malformed (${what})`);
  return v as number;
};

/** Checks a `changes` result. Throws PeerError on anything malformed, so nothing of a bad page is taken in. */
export function parsePage(r: any, cursor: number): { changes: Change[]; next: number; head: number; blobs: number; more: boolean } {
  if (!r || typeof r !== 'object' || !Array.isArray(r.changes) || r.changes.length > MAX_PAGE) throw new PeerError('its answer is malformed');
  const changes: Change[] = r.changes.map((c: any) => {
    if (!c || typeof c !== 'object' || typeof c.sha256 !== 'string' || !H64.test(c.sha256)) throw new PeerError('its answer is malformed (sha256)');
    if (!Array.isArray(c.holds) || c.holds.length > MAX_HOLDS) throw new PeerError('its answer is malformed (holds)');
    const holds: Hold[] = c.holds.map((h: any) => {
      if (!h || typeof h.key !== 'string' || !H64.test(h.key) || typeof h.held !== 'boolean') throw new PeerError('its answer is malformed (a hold)');
      return { key: h.key, held: h.held, at: int(h.at, 'at'), uploaded: int(h.uploaded, 'uploaded') };
    });
    return {
      sha256: c.sha256, size: int(c.size, 'size'), type: typeof c.type === 'string' && MIME.test(c.type) ? c.type : 'application/octet-stream',
      created: int(c.created, 'created'), erased: c.erased === null ? null : int(c.erased, 'erased'), holds,
    };
  });
  const next = int(r.next, 'next');
  if (next < cursor) throw new PeerError('its answer is malformed (next)');
  return { changes, next, head: int(r.head, 'head'), blobs: int(r.blobs, 'blobs'), more: r.more === true && next > cursor };
}

/** Each peer's state, from the database (the CLI reads it the same way). */
export function statusOf(db: Db): PeerStatus[] {
  return db.peerRows().map((r) => {
    const waiting = db.wantCount(r.pubkey);
    const blobs = r.blobs === null ? null : Number(r.blobs);
    return {
      name: r.name, url: r.url, pubkey: r.pubkey, blobs, copied: blobs === null ? null : Math.max(0, blobs - waiting), waiting,
      behind: r.head === null ? null : Math.max(0, Number(r.head) - Number(r.cursor)),
      lastOk: r.lastOk === null ? null : Number(r.lastOk), lastTry: r.lastTry === null ? null : Number(r.lastTry), error: r.error,
    };
  });
}

/** "xumbrel: 1,204 of 1,204 copied, last 11:40", and what's wrong if anything is. Times in the process's time zone. */
export function statusLine(s: PeerStatus): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const hhmm = (t: number) => {
    const d = new Date(t * 1000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  let line = s.blobs === null ? `${s.name}: not read yet` : `${s.name}: ${n(s.copied!)} of ${n(s.blobs)} copied, last ${s.lastOk ? hhmm(s.lastOk) : 'never'}`;
  if (s.behind) line += `, ${n(s.behind)} changes still to read`;
  if (s.error) line += ` (${s.error})`;
  return line;
}
