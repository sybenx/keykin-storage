// The Blossom server: BUD-01 (get), 02 (upload), 04 (mirror), 06 (upload preflight), 11 (auth), 12 (list, delete).
// Writes come only from keys of accounts on this box. Reads are open. Nothing is deleted on a timer except blobs
// that sat in the bin (owned by nobody) for binDays.

import { createReadStream, statfsSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { checkAuth, parseAuth, type Auth, type Verb } from './auth.ts';
import type { Config } from './config.ts';
import { Db, type Account, type Blob, type Pending } from './db.ts';
import { clientAddress, RateLimit } from './limit.ts';
import { guardedFetch, MirrorError } from './mirror.ts';
import { Aborted, Store, TooLarge, TooSlow, type MinRate, type Received } from './store.ts';

const SHA_PATH = /^\/([0-9a-fA-F]{64})(\.[A-Za-z0-9]{1,10})?$/;
const LIST_PATH = /^\/list\/([0-9a-fA-F]{64})$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const EXT: Record<string, string> = {
  'application/octet-stream': 'bin', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg', 'application/pdf': 'pdf', 'text/plain': 'txt', 'application/json': 'json', 'application/zip': 'zip',
};
const DAY = 86400;
const MAX_IN_FLIGHT = 32;
const MAX_IN_FLIGHT_PER_ACCOUNT = 4;
/** Uploads stop when the disk would have less than this left. */
const DISK_MARGIN = 1024 ** 3;
/** An upload averaging under this many bytes a second over a minute is cut off, so it can't hold a slot forever. */
const MIN_RATE = 16 * 1024;

function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) {
    super(reason);
    this.status = status;
  }
}

export interface Running {
  server: http.Server;
  db: Db;
  url: string;
  /** Erases blobs whose time in the bin is up. Runs hourly by itself; exposed for tests. */
  sweep(): number;
  close(): Promise<void>;
}

export async function start(config: Config): Promise<Running> {
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  const db = new Db(join(config.dataDir, 'storage.db'), { maxBlobs: config.maxBlobsPerAccount });
  const store = new Store(config.dataDir);
  const ready = !!config.owner && !!config.publicUrl && config.domains.length > 0;
  if (ready) db.putAccount(config.owner, null, now()); // the box owner: always an account, never a quota

  const sweep = (): number => {
    const before = now() - config.binDays * DAY;
    let n = 0;
    for (const sha of db.expired(before)) {
      // row and file go in one synchronous step, so an upload can't slip between them
      if (db.erase(sha, before)) {
        store.remove(sha);
        n++;
      }
    }
    return n;
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError || err instanceof MirrorError ? err.status
        : err?.code === 'ENOSPC' ? 507 : 500;
      const reason = status === 500 ? 'server error' : status === 507 ? 'this box is out of disk space' : err.message;
      if (status === 500) console.error(err);
      if (!res.headersSent) fail(res, status, reason, req.method === 'HEAD');
      else res.destroy();
    });
  });
  server.requestTimeout = 0; // a big upload on a slow link may take hours…
  server.timeout = 60_000; // …but a socket that sends nothing for a minute is closed, one that sends under the
  // minimum rate over a minute is cut off (receive), and the small /mirror body has a deadline (readSmall)
  server.headersTimeout = 60_000;

  // uploads and mirrors in flight: a cap per account and overall, and their declared bytes count against quota
  const flight = { all: 0, by: new Map<string, { n: number; bytes: number }>() };
  /** Takes an upload slot. `grow(n)` reserves n bytes of disk and quota for it; `release()` gives all back. */
  const take = (account: Account): { grow(n: number): void; release(): void } => {
    const f = flight.by.get(account.pubkey) ?? { n: 0, bytes: 0 };
    if (flight.all >= MAX_IN_FLIGHT || f.n >= MAX_IN_FLIGHT_PER_ACCOUNT) throw new HttpError(429, 'too many uploads at once');
    f.n++;
    flight.all++;
    flight.by.set(account.pubkey, f);
    let mine = 0, done = false;
    return {
      grow(n: number) {
        const free = freeBytes(config.dataDir);
        let reserved = 0;
        for (const v of flight.by.values()) reserved += v.bytes;
        if (free !== null && free - reserved - n < (config.diskMarginBytes ?? DISK_MARGIN)) throw new HttpError(507, 'this box is out of disk space');
        mine += n;
        f.bytes += n;
      },
      release() {
        if (done) return;
        done = true;
        f.n--;
        f.bytes -= mine;
        flight.all--;
        if (f.n === 0) flight.by.delete(account.pubkey);
      },
    };
  };
  const pending = (account: Account): Pending => {
    const f = flight.by.get(account.pubkey);
    return { bytes: f?.bytes ?? 0, n: f?.n ?? 0 };
  };
  /** Throws 413 unless one of the x tags fits (a blob already charged to the account always does). */
  const mustFit = (account: Account, xs: string[], size: number) => {
    let why: string | null = 'over your quota on this box';
    for (const x of xs) if ((why = db.refusal(account, x, size, pending(account))) === null) return;
    throw new HttpError(413, why!);
  };

  const limit = new RateLimit({ burst: config.authBurst ?? 60, perSecond: config.authPerSecond ?? 10 });

  const timer = setInterval(sweep, 3600_000);
  timer.unref();
  sweep();

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    cors(res);
    const method = req.method ?? 'GET';
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      return fail(res, 400, 'bad request', method === 'HEAD'); // a request line no url can be read from: not worth a log
    }
    if (method === 'OPTIONS') return end(res, 204);
    if (req.headers.authorization !== undefined && !limit.take(clientAddress(req, config.behindCloudflare))) {
      return fail(res, 429, 'too many signed requests from your address; wait a few seconds', method === 'HEAD');
    }
    if (!ready && method !== 'GET' && method !== 'HEAD') {
      return fail(res, 503, 'this box is not set up yet: set STORAGE_PUBLIC_URL and STORAGE_OWNER');
    }

    if (path === '/upload' && method === 'PUT') return upload(req, res);
    if (path === '/upload' && method === 'HEAD') return preflight(req, res);
    if (path === '/mirror' && method === 'PUT') return mirror(req, res);
    const list = LIST_PATH.exec(path);
    if (list && method === 'GET') return listBlobs(req, res, list[1].toLowerCase());
    const blob = SHA_PATH.exec(path);
    if (blob && (method === 'GET' || method === 'HEAD')) return get(req, res, blob[1].toLowerCase(), method === 'HEAD');
    if (blob && method === 'DELETE') return del(req, res, blob[1].toLowerCase());
    if (path === '/' && (method === 'GET' || method === 'HEAD')) {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return end(res, 200, method === 'HEAD' ? undefined : 'Keykin Storage: a Blossom server for one account and its friends.\n' +
        (ready ? '' : '\nNot set up yet: set STORAGE_PUBLIC_URL (the address people reach this box at) and STORAGE_OWNER (your npub).\n'));
    }
    // /media (BUD-05), /report (BUD-09) and the rest: not here
    return fail(res, 404, 'not found', method === 'HEAD');
  }

  // --- auth

  function writer(req: http.IncomingMessage, verb: Verb): { auth: Auth; account: Account } {
    const p = parseAuth(req.headers.authorization);
    if (!p.ok) throw new HttpError(p.status, p.reason);
    // a key with no account here is refused before its signature is checked: strangers cost one lookup
    const account = db.accountOf(p.event.pubkey);
    if (!account) throw new HttpError(403, 'this key may not write here');
    return { auth: verified(p.event, verb), account };
  }

  function verified(event: Parameters<typeof checkAuth>[0], verb: Verb): Auth {
    const r = checkAuth(event, verb, config.domains, now());
    if (!r.ok) throw new HttpError(r.status, r.reason);
    return r.auth;
  }

  // --- BUD-01

  function get(req: http.IncomingMessage, res: http.ServerResponse, sha: string, head: boolean): void {
    const b = db.blob(sha);
    if (!b || !store.has(sha)) return fail(res, 404, 'not found', head);
    const type = servedType(b.type);
    res.setHeader('content-type', type);
    // anything that isn't plain media is a download, never a page or script on this domain
    if (type === 'application/octet-stream') res.setHeader('content-disposition', 'attachment');
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('etag', `"${sha}"`);
    // short and not immutable: after a take-down (CLI erase) an edge purge must stick
    res.setHeader('cache-control', 'public, max-age=86400');
    // uploaded bytes are served as-is; never let them run as a page on this origin
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'none'; sandbox");
    const range = parseRange(req.headers.range, b.size);
    if (range === 'bad') {
      res.setHeader('content-range', `bytes */${b.size}`);
      return fail(res, 416, 'range not satisfiable', head);
    }
    const [start, endAt] = range ?? [0, b.size - 1];
    res.setHeader('content-length', String(b.size === 0 ? 0 : endAt - start + 1));
    if (range) res.setHeader('content-range', `bytes ${start}-${endAt}/${b.size}`);
    res.statusCode = range ? 206 : 200;
    if (head || b.size === 0) return void res.end();
    const file = createReadStream(store.path(sha), { start, end: endAt });
    file.on('error', () => res.destroy());
    file.pipe(res);
  }

  // --- BUD-02

  async function upload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('connection', 'close'); // a refused upload's body isn't read
    const { auth, account } = writer(req, 'upload');
    if (auth.xs.length === 0) throw new HttpError(401, 'upload authorization needs an x tag');
    const len = req.headers['content-length'];
    if (!len || !/^\d+$/.test(len)) throw new HttpError(411, 'content-length required');
    const size = Number(len);
    if (size > config.maxBlobBytes) throw new HttpError(413, `blobs here are at most ${config.maxBlobBytes} bytes`);
    const claimed = header(req, 'x-sha-256')?.toLowerCase() ?? null;
    if (claimed && !auth.xs.includes(claimed)) throw new HttpError(403, 'x-sha-256 is not in the authorization');
    mustFit(account, auth.xs, size);

    const slot = take(account);
    let got: Received;
    try {
      slot.grow(size);
      got = await receive(req, size, {
        windowMs: config.uploadWindowMs ?? 60_000, bytesPerSecond: config.minUploadBytesPerSecond ?? MIN_RATE, expected: size,
      });
    } finally {
      slot.release();
    }
    if (claimed && got.sha256 !== claimed) {
      store.discard(got.tmp);
      throw new HttpError(409, 'body does not match x-sha-256');
    }
    finish(res, got, contentType(header(req, 'content-type')), auth);
  }

  /**
   * Puts a received blob in place and records the owner: the last checks and both writes in one synchronous step,
   * so the bin sweeper or a removed account can't slip in between.
   */
  function finish(res: http.ServerResponse, got: Received, type: string, auth: Auth): void {
    const account = db.accountOf(auth.pubkey); // again: it may have been removed while the body came in
    if (!account) {
      store.discard(got.tmp);
      throw new HttpError(403, 'this key may not write here');
    }
    if (!auth.xs.includes(got.sha256)) {
      store.discard(got.tmp);
      throw new HttpError(403, 'blob does not match the authorization x tag');
    }
    const why = db.refusal(account, got.sha256, got.size, pending(account));
    if (why) {
      store.discard(got.tmp);
      throw new HttpError(413, why);
    }
    const had = db.blob(got.sha256);
    store.commit(got);
    try {
      db.own(got.sha256, got.size, had?.type ?? type, auth.pubkey, now());
    } catch (err) {
      if (!had) store.remove(got.sha256); // no row, no file
      throw err;
    }
    json(res, had ? 200 : 201, descriptor(db.blob(got.sha256)!, db.uploadedAt(got.sha256, auth.pubkey) ?? now()));
  }

  async function receive(body: Readable, declared: number | null, rate?: MinRate): Promise<Received> {
    try {
      const got = await store.receive(body, config.maxBlobBytes, rate);
      if (declared !== null && got.size !== declared) {
        store.discard(got.tmp);
        throw new HttpError(400, 'body length does not match content-length');
      }
      return got;
    } catch (err) {
      if (err instanceof TooLarge) throw new HttpError(413, `blobs here are at most ${config.maxBlobBytes} bytes`);
      if (err instanceof Aborted) throw new HttpError(400, 'upload aborted');
      if (err instanceof TooSlow) throw new HttpError(408, 'upload too slow: under 16 KiB a second for a minute');
      throw err;
    }
  }

  // --- BUD-06

  function preflight(req: http.IncomingMessage, res: http.ServerResponse): void {
    const { auth, account } = writer(req, 'upload');
    const sha = header(req, 'x-sha-256')?.toLowerCase();
    const len = header(req, 'x-content-length');
    if (!len || !/^\d+$/.test(len)) throw new HttpError(411, 'x-content-length required');
    if (!sha || !/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(400, 'x-sha-256 required');
    if (!auth.xs.includes(sha)) throw new HttpError(403, 'x-sha-256 is not in the authorization');
    const size = Number(len);
    if (size > config.maxBlobBytes) throw new HttpError(413, `blobs here are at most ${config.maxBlobBytes} bytes`);
    mustFit(account, [sha], size);
    end(res, 200);
  }

  // --- BUD-04

  async function mirror(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('connection', 'close'); // a refused mirror's body isn't read
    const { auth, account } = writer(req, 'upload');
    // a mirror makes this box fetch a url someone else chose, from the box's home address: the owner's call only
    if (account.pubkey !== config.owner) throw new HttpError(403, 'mirror is only for the owner of this box; upload instead');
    if (auth.xs.length === 0) throw new HttpError(401, 'mirror authorization needs an x tag');
    let url: unknown;
    try {
      url = JSON.parse((await readSmall(req, 8192, config.mirrorBodyTimeoutMs ?? 10_000)).toString('utf8'))?.url;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'body must be {"url": "…"}');
    }
    if (typeof url !== 'string') throw new HttpError(400, 'body must be {"url": "…"}');
    // Skipping the fetch is safe only when this account already has these exact bytes: anyone can know a hash,
    // and with several x tags we couldn't tell which one the url serves.
    if (auth.xs.length === 1 && db.holds(account.pubkey, auth.xs[0]) && store.has(auth.xs[0])) {
      const b = db.blob(auth.xs[0])!;
      db.own(b.sha256, b.size, b.type, auth.pubkey, now());
      return json(res, 200, descriptor(b, db.uploadedAt(b.sha256, auth.pubkey) ?? now()));
    }
    const slot = take(account);
    let got: Received;
    let type: string | null;
    try {
      const signal = AbortSignal.timeout(config.mirrorTimeoutMs);
      const src = await guardedFetch(url, { timeoutMs: config.mirrorTimeoutMs, allowPrivate: config.mirrorAllowPrivate }, signal);
      type = src.type;
      // the source's length if it says, else the cap (the body is cut off there either way)
      const size = src.length ?? config.maxBlobBytes;
      if (size > config.maxBlobBytes) {
        src.body.destroy();
        throw new HttpError(413, `blobs here are at most ${config.maxBlobBytes} bytes`);
      }
      if (src.length !== null) {
        try {
          mustFit(account, auth.xs, size);
        } catch (err) {
          src.body.destroy();
          throw err;
        }
      }
      try {
        slot.grow(size);
      } catch (err) {
        src.body.destroy();
        throw err;
      }
      try {
        got = await receive(src.body, src.length);
      } catch (err) {
        src.body.destroy();
        if (err instanceof HttpError && err.status === 400) throw new HttpError(502, 'mirror source sent a broken body');
        if (err instanceof HttpError) throw err;
        throw new HttpError(502, 'mirror fetch failed');
      }
    } finally {
      slot.release();
    }
    if (!auth.xs.includes(got.sha256)) {
      store.discard(got.tmp);
      throw new HttpError(409, 'mirrored blob does not match the authorization x tag');
    }
    finish(res, got, contentType(type), auth);
  }

  // --- BUD-12

  function listBlobs(req: http.IncomingMessage, res: http.ServerResponse, pubkey: string): void {
    const p = parseAuth(req.headers.authorization);
    if (!p.ok) throw new HttpError(p.status, p.reason);
    if (p.event.pubkey !== pubkey) throw new HttpError(403, 'you can only list your own blobs');
    verified(p.event, 'list');
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const cursor = q.get('cursor')?.toLowerCase() ?? null;
    if (cursor && !/^[0-9a-f]{64}$/.test(cursor)) throw new HttpError(400, 'cursor is not a sha256');
    const limit = Math.min(Math.max(Number(q.get('limit')) || 1000, 1), 1000);
    json(res, 200, db.owned(pubkey, cursor, limit).map((o) => descriptor(o, o.uploaded)));
  }

  function del(req: http.IncomingMessage, res: http.ServerResponse, sha: string): void {
    // any key that holds a copy may let go of it, even one whose account was removed
    const p = parseAuth(req.headers.authorization);
    if (!p.ok) throw new HttpError(p.status, p.reason);
    if (db.uploadedAt(sha, p.event.pubkey) === null) throw new HttpError(404, 'you hold no copy of this blob');
    const a = verified(p.event, 'delete');
    if (!a.xs.includes(sha)) throw new HttpError(401, 'delete authorization must name this blob in an x tag');
    if (!db.disown(sha, a.pubkey, now())) throw new HttpError(404, 'you hold no copy of this blob');
    end(res, 204);
  }

  // --- helpers

  function descriptor(b: Blob, uploaded: number) {
    return { url: `${config.publicUrl}/${b.sha256}.${EXT[b.type] ?? 'bin'}`, sha256: b.sha256, size: b.size, type: b.type, uploaded };
  }

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;

  return {
    server,
    db,
    url: `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`,
    sweep,
    close: () => new Promise<void>((resolve) => {
      clearInterval(timer);
      server.closeAllConnections();
      server.close(() => {
        db.close();
        resolve();
      });
    }),
  };
}

function cors(res: http.ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'Authorization, *');
  res.setHeader('access-control-allow-methods', 'GET, HEAD, PUT, DELETE');
  res.setHeader('access-control-expose-headers', '*');
  res.setHeader('access-control-max-age', '86400');
}

function end(res: http.ServerResponse, status: number, body?: string): void {
  res.statusCode = status;
  res.end(body);
}

function fail(res: http.ServerResponse, status: number, reason: string, head = false): void {
  res.setHeader('x-reason', reason.replace(/[^\x20-\x7e]/g, '?'));
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  end(res, status, head ? undefined : reason + '\n');
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.setHeader('content-type', 'application/json');
  end(res, status, JSON.stringify(body));
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** The type a blob is served as: images (not SVG, which can carry script), video and audio as stored, the rest as bytes. */
export function servedType(stored: string): string {
  if (stored === 'image/svg+xml') return 'application/octet-stream';
  return /^(image|video|audio)\//.test(stored) ? stored : 'application/octet-stream';
}

function contentType(raw: string | null | undefined): string {
  const t = (raw ?? '').split(';')[0].trim().toLowerCase();
  return MIME.test(t) ? t : 'application/octet-stream';
}

/** One `bytes=` range: [start, end] inclusive, null for none, 'bad' for unsatisfiable. */
export function parseRange(h: string | undefined, size: number): [number, number] | null | 'bad' {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // not a form we serve: whole blob
  if (size === 0) return 'bad';
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'bad';
    return [Math.max(size - n, 0), size - 1];
  }
  const start = Number(m[1]);
  const endAt = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || endAt < start) return 'bad';
  return [start, endAt];
}

function readSmall(req: http.IncomingMessage, max: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let n = 0;
    const timer = setTimeout(() => {
      req.pause();
      reject(new HttpError(408, 'body too slow'));
    }, timeoutMs);
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) {
        clearTimeout(timer);
        req.destroy();
        return reject(new HttpError(413, 'body too large'));
      }
      parts.push(c);
    });
    req.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(parts));
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
