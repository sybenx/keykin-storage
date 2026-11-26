// The Blossom server: BUD-01 (get), 02 (upload), 04 (mirror), 06 (upload preflight), 11 (auth), 12 (list, delete).
// And the management surface, POST /manage (manage.ts), and photo places for DMs, POST /places (places.ts).
// Writes come only from keys of accounts on this box. Reads are open. Nothing is deleted on a timer except blobs
// that sat in the bin (owned by nobody) for binDays.

import { randomBytes } from 'node:crypto';
import { createReadStream, statfsSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { checkAuth, parseAuth, type Auth, type Verb } from './auth.ts';
import type { Config } from './config.ts';
import { Db, type Account, type Blob, type Pending, type Upload } from './db.ts';
import { Home, httpHome, type HomeSource } from './home.ts';
import { httpRpc, Keeper, wsUrlOf, type HomeRpc } from './keeper.ts';
import { clientAddress, RateLimit } from './limit.ts';
import { isManagePath, manager, send } from './manage.ts';
import { guardedFetch, MirrorError } from './mirror.ts';
import { isPeerPath, peerHandler, Peers } from './peers.ts';
import { isPlacesPath, placesHandler } from './places.ts';
import { serviceKey, type ServiceKey } from './servicekey.ts';
import { Aborted, Store, TooLarge, TooSlow, type MinRate, type Received } from './store.ts';
import { Towns } from './towns.ts';

const SHA_PATH = /^\/([0-9a-fA-F]{64})(\.[A-Za-z0-9]{1,10})?$/;
const UPLOADS_PATH = /^\/uploads\/([^/]+)(?:\/([^/]+))?$/;
const UPLOAD_ID = /^[0-9a-f]{32}$/;
const LIST_PATH = /^\/list\/([0-9a-fA-F]{64})$/;
const GROUP_EVENTS_PATH = /^\/groups\/([0-9a-f]{32})\/events$/;
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
/** An upload in pieces that gets no new piece for this long, seconds, is discarded. */
export const UPLOAD_IDLE = DAY;
/** Most pieces one upload may have, so its status stays small. */
export const MAX_PIECES = 4096;
/** The one answer for an upload id that is unknown, someone else's or expired, so ids can't be probed. */
const NO_UPLOAD = 'no such upload';

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
  /** Discards uploads in pieces that got nothing for a day, and stray upload files. Runs every minute; exposed for tests. */
  sweepUploads(): number;
  /** This storage's own key (public half shown at start and by `home key`). */
  serviceKey: ServiceKey;
  /** Follows the home's member list, when STORAGE_HOME_URL is set and the box is set up. */
  home: Home | null;
  /** Keeps the home's group keys and messages (keeper.ts), with the same conditions as `home`. */
  keeper: Keeper | null;
  /** The town list behind `names` (towns.ts), or null when STORAGE_TOWNS is off. It loads after the server listens. */
  towns: Towns | null;
  /** Copies to and from peer boxes (peers.ts), or null with no STORAGE_PEERS. */
  peers: Peers | null;
  close(): Promise<void>;
}

export async function start(config: Config, opts: {
  homeSource?: HomeSource; homeRpc?: HomeRpc; noKeeperStart?: boolean;
  /** Tests only: this town list instead of the one STORAGE_TOWNS names; it is not loaded here. */
  towns?: Towns | null;
  /** Tests only: don't copy from peers on a timer (call `peers.sync()`). */
  noPeerStart?: boolean;
} = {}): Promise<Running> {
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  /** Largest body of one request (PUT /upload, /mirror); bigger files come in pieces. */
  const maxRequest = Math.min(config.maxRequestBytes ?? 256 * 1024 * 1024, config.maxBlobBytes);
  const tooBig = () => new HttpError(413, maxRequest < config.maxBlobBytes
    ? `one request here carries at most ${maxRequest} bytes; send bigger files in pieces (POST /uploads)`
    : `blobs here are at most ${config.maxBlobBytes} bytes`);
  const log = config.log ?? ((line: string) => console.log(line));
  const db = new Db(join(config.dataDir, 'storage.db'), { maxBlobs: config.maxBlobsPerAccount });
  const store = new Store(config.dataDir);
  const ready = !!config.owner && !!config.publicUrl && config.domains.length > 0;
  if (ready) db.putAccount(config.owner, null, now()); // the box owner: always an account, never a quota
  const key = serviceKey(config.dataDir);
  // with no home set, accounts that came from one don't write (nothing is deleted either), as before homes existed
  db.membersWrite = !!config.homeUrl;
  const home = ready && config.homeUrl
    ? new Home(db, opts.homeSource ?? httpHome(config.homeUrl, key, { timeoutMs: config.homeTimeoutMs ?? 10_000, now }), {
      owner: config.owner, memberQuota: config.memberQuota, pollS: config.homePollS, now, log, removeFile: (s) => store.remove(s),
    })
    : null;
  if (home) db.saveHomeState({ url: config.homeUrl });
  // The group keeper: this box holds every group key on the home (keeper.ts). Only with a home, like accounts.
  const keeper = ready && config.homeUrl && (config.keeper !== false || opts.homeRpc)
    ? new Keeper(db, opts.homeRpc ?? httpRpc(config.homeUrl, key, { timeoutMs: config.homeTimeoutMs ?? 10_000, now }), key, {
      now, log, pollS: config.keeperPollS ?? 60, wsUrl: opts.homeRpc ? null : wsUrlOf(config.homeUrl), publicUrl: config.publicUrl,
    })
    : null;

  const pieceBytes = config.pieceBytes ?? 8 * 1024 * 1024;
  /** Largest file in pieces. */
  const largest = Math.min(config.maxBlobBytes, pieceBytes * MAX_PIECES);
  const maxOpenPer = config.maxOpenUploadsPerAccount ?? 2;
  const maxOpen = config.maxOpenUploads ?? 32;
  /** Uploads touched after this are open. */
  const live = () => now() - UPLOAD_IDLE;
  /** Pieces being written now, by `<id>/<index>`: a new write of the same piece stops the old one first. */
  const writing = new Map<string, { abort(): void; done: Promise<unknown> }>();
  /** Completions running now, by upload id: a second `complete` waits for the first and gets the same answer. */
  const completing = new Map<string, Promise<{ status: number; body: unknown }>>();
  /** Fires on close, so a completion stops hashing. */
  const closing = new AbortController();
  const busy = (id: string) => completing.has(id) || [...writing.keys()].some((k) => k.startsWith(id + '/'));
  const stopWrites = (id: string) => {
    for (const [k, w] of writing) if (k.startsWith(id + '/')) w.abort();
  };

  /**
   * Discards uploads that got no piece for UPLOAD_IDLE (not one being completed), and upload files with no row (their
   * account was removed, or the CLI took it away). Returns how many uploads it discarded.
   */
  const sweepUploads = (): number => {
    let n = 0;
    for (const id of db.expiredUploads(live())) {
      if (completing.has(id)) continue;
      stopWrites(id);
      if (db.dropUpload(id)) n++;
      store.dropUpload(id);
    }
    for (const id of store.uploadIds()) {
      if (!db.upload(id) && !busy(id)) store.dropUpload(id);
    }
    return n;
  };
  // after a restart: an upload whose file is gone or the wrong length can't be finished
  for (const u of db.uploads()) {
    if (store.uploadSize(u.id) !== u.size) db.dropUpload(u.id);
  }
  sweepUploads();

  const sweep = (): number => {
    const before = now() - config.binDays * DAY;
    let n = 0;
    for (const sha of db.expired(before)) {
      // row and file go in one synchronous step, so an upload can't slip between them
      if (db.erase(sha, before, now())) {
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

  // Uploads, mirrors, pieces and completions in flight: a cap per account and overall. The declared bytes of uploads
  // and mirrors count against quota and disk; so do open uploads in pieces (kept in the database), until they finish.
  const flight = { all: 0, by: new Map<string, { n: number; blobs: number; bytes: number }>() };
  /** Throws 507 unless `n` more bytes leave the disk margin free, with everything in flight and open held back. */
  const diskRoom = (n: number) => {
    const free = freeBytes(config.dataDir);
    if (free === null) return;
    let reserved = db.openAll(live()).remaining;
    for (const v of flight.by.values()) reserved += v.bytes;
    if (free - reserved - n < (config.diskMarginBytes ?? DISK_MARGIN)) throw new HttpError(507, 'this box is out of disk space');
  };
  /**
   * Takes an upload slot. `grow(n)` reserves n bytes of disk and quota for it; `release()` gives all back. A slot for
   * a piece or a completion (`blob: false`) counts toward the caps on requests at once, but not as a blob to come: its
   * upload in pieces already holds that back.
   */
  const take = (account: Account, opts: { blob?: boolean } = {}): { grow(n: number): void; release(): void } => {
    const f = flight.by.get(account.pubkey) ?? { n: 0, blobs: 0, bytes: 0 };
    if (flight.all >= MAX_IN_FLIGHT || f.n >= MAX_IN_FLIGHT_PER_ACCOUNT) throw new HttpError(429, 'too many uploads at once');
    const blob = opts.blob !== false ? 1 : 0;
    f.n++;
    f.blobs += blob;
    flight.all++;
    flight.by.set(account.pubkey, f);
    let mine = 0, done = false;
    return {
      grow(n: number) {
        diskRoom(n);
        mine += n;
        f.bytes += n;
      },
      release() {
        if (done) return;
        done = true;
        f.n--;
        f.blobs -= blob;
        f.bytes -= mine;
        flight.all--;
        if (f.n === 0) flight.by.delete(account.pubkey);
      },
    };
  };
  /** What the account has coming: uploads in flight, and open uploads in pieces (but `except`). */
  const pending = (account: Account, except: string | null = null): Pending => {
    const f = flight.by.get(account.pubkey);
    const open = db.openFor(account.pubkey, live(), except);
    return { bytes: (f?.bytes ?? 0) + open.bytes, n: (f?.blobs ?? 0) + open.n };
  };
  /** Throws 413 unless one of the x tags fits (a blob already charged to the account always does). */
  const mustFit = (account: Account, xs: string[], size: number) => {
    let why: string | null = 'over your quota on this box';
    for (const x of xs) if ((why = db.refusal(account, x, size, pending(account))) === null) return;
    throw new HttpError(413, why!);
  };

  const limit = new RateLimit({ burst: config.authBurst ?? 60, perSecond: config.authPerSecond ?? 10 });
  const manage = manager({ config, db, home, key, ready, now, removeFile: (s) => store.remove(s), peers: () => peers?.status() ?? [] });
  const townsFile = config.towns ?? 'off';
  const towns = opts.towns !== undefined ? opts.towns : townsFile === 'off' ? null : new Towns(townsFile, log);
  const room = (n: number) => {
    try {
      diskRoom(n);
      return true;
    } catch {
      return false;
    }
  };
  const places = placesHandler({ config, db, home, key, ready, now, towns, room, log });
  const peerList = (config.peers ?? []).filter((p) => {
    if (p.pubkey !== key.pk) return true;
    log(`peer ${p.name} is this box itself (its key is this box's): left out`);
    return false;
  });
  const peerAnswers = peerHandler({ db, peers: () => peerList, now });
  const peers = peerList.length > 0
    ? new Peers({
      db, store, key, peers: peerList, now, log, pollS: config.peerPollS ?? 60, binDays: config.binDays, maxBlobBytes: config.maxBlobBytes,
      room, idleMs: config.peerIdleMs,
    })
    : null;
  if (!peers) db.setPeers([]);

  const timer = setInterval(sweep, 3600_000);
  timer.unref();
  sweep();
  const uploadTimer = setInterval(sweepUploads, 60_000);
  uploadTimer.unref();

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
      const why = 'too many signed requests from your address; wait a few seconds';
      if (isManagePath(path) || isPlacesPath(path) || isPeerPath(path)) return send(res, 429, { error: why }, method === 'HEAD');
      return fail(res, 429, why, method === 'HEAD');
    }
    if (isManagePath(path)) return manage.handle(req, res, path); // answers `info` even before the box is set up
    if (isPlacesPath(path)) return places.handle(req, res); // answers 503 itself before the box is set up
    if (isPeerPath(path)) return peerAnswers.handle(req, res); // answers 404 itself with no peers
    if (!ready && method !== 'GET' && method !== 'HEAD') {
      return fail(res, 503, 'this box is not set up yet: set STORAGE_PUBLIC_URL and STORAGE_OWNER');
    }

    if (path === '/upload' && method === 'PUT') return upload(req, res);
    if (path === '/upload' && method === 'HEAD') return preflight(req, res);
    if (path === '/mirror' && method === 'PUT') return mirror(req, res);
    if (path === '/uploads' && method === 'POST') return startUpload(req, res);
    const up = UPLOADS_PATH.exec(path);
    if (up) {
      const [, id, part] = up;
      if (part === undefined && method === 'GET') return uploadStatus(req, res, id);
      if (part === undefined && method === 'DELETE') return abandon(req, res, id);
      if (part === 'complete' && method === 'POST') return complete(req, res, id);
      if (part !== undefined && method === 'PUT') return piece(req, res, id, part);
    }
    const groups = GROUP_EVENTS_PATH.exec(path);
    if (groups && method === 'GET') {
      if (!keeper) return fail(res, 404, 'this box keeps no groups');
      const r = await keeper.door(req, groups[1]);
      return send(res, r.status, r.body);
    }
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

  async function writer(req: http.IncomingMessage, verb: Verb): Promise<{ auth: Auth; account: Account }> {
    const p = parseAuth(req.headers.authorization);
    if (!p.ok) throw new HttpError(p.status, p.reason);
    // a key with no account here is refused before its signature is checked: strangers cost one lookup
    let account = db.accountOf(p.event.pubkey);
    if (!account && home) {
      // maybe a member who just joined: ask the home again (at most once a minute, whoever asks)
      await home.lookUp();
      account = db.accountOf(p.event.pubkey);
    }
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
    const { auth, account } = await writer(req, 'upload');
    if (auth.xs.length === 0) throw new HttpError(401, 'upload authorization needs an x tag');
    const len = req.headers['content-length'];
    if (!len || !/^\d+$/.test(len)) throw new HttpError(411, 'content-length required');
    const size = Number(len);
    if (size > maxRequest) throw tooBig();
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
   * Puts a received blob in place and records the owner: the account check, the quota check, the file move and the
   * database write in one transaction, so the bin sweeper or a removed account (even from the CLI, another
   * process) can't slip in between.
   */
  function finish(res: http.ServerResponse, got: Received, type: string, auth: Auth): void {
    if (!auth.xs.includes(got.sha256)) {
      store.discard(got.tmp);
      throw new HttpError(403, 'blob does not match the authorization x tag');
    }
    let placedNew = false;
    let r: ReturnType<Db['ownAsWriter']>;
    try {
      r = db.ownAsWriter(got.sha256, got.size, type, auth.pubkey, now(), pending, () => {
        placedNew = !store.has(got.sha256);
        store.commit(got);
      });
    } catch (err) {
      if (placedNew) store.remove(got.sha256); // no row, no file
      throw err;
    }
    if (!r.ok) {
      store.discard(got.tmp);
      throw new HttpError(r.status, r.reason);
    }
    json(res, r.isNew ? 201 : 200, descriptor(db.blob(got.sha256)!, db.uploadedAt(got.sha256, auth.pubkey) ?? now()));
  }

  async function receive(body: Readable, declared: number | null, rate?: MinRate): Promise<Received> {
    try {
      const got = await store.receive(body, maxRequest, rate);
      if (declared !== null && got.size !== declared) {
        store.discard(got.tmp);
        throw new HttpError(400, 'body length does not match content-length');
      }
      return got;
    } catch (err) {
      if (err instanceof TooLarge) throw tooBig();
      if (err instanceof Aborted) throw new HttpError(400, 'upload aborted');
      if (err instanceof TooSlow) throw new HttpError(408, 'upload too slow: under 16 KiB a second for a minute');
      throw err;
    }
  }

  // --- BUD-06

  async function preflight(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { auth, account } = await writer(req, 'upload');
    const sha = header(req, 'x-sha-256')?.toLowerCase();
    const len = header(req, 'x-content-length');
    if (!len || !/^\d+$/.test(len)) throw new HttpError(411, 'x-content-length required');
    if (!sha || !/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(400, 'x-sha-256 required');
    if (!auth.xs.includes(sha)) throw new HttpError(403, 'x-sha-256 is not in the authorization');
    const size = Number(len);
    if (size > maxRequest) throw tooBig();
    mustFit(account, [sha], size);
    end(res, 200);
  }

  // --- BUD-04

  async function mirror(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('connection', 'close'); // a refused mirror's body isn't read
    const { auth, account } = await writer(req, 'upload');
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
      const size = src.length ?? maxRequest;
      if (size > maxRequest) {
        src.body.destroy();
        throw tooBig();
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

  // --- uploads in pieces

  const piecesOf = (u: Upload) => Math.ceil(u.size / u.pieceSize);
  const pieceLength = (u: Upload, i: number) => (i < piecesOf(u) - 1 ? u.pieceSize : u.size - (piecesOf(u) - 1) * u.pieceSize);
  const statusOf = (u: Upload) => ({
    id: u.id, sha256: u.sha256, size: u.size, pieceSize: u.pieceSize, pieces: piecesOf(u), received: db.pieces(u.id),
    expiresAt: u.touched + UPLOAD_IDLE,
  });

  /** POST /uploads: {sha256, size, type}. Opens an upload in pieces, or answers with the one already open. */
  async function startUpload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('connection', 'close'); // a refused start's body isn't read
    const { auth, account } = await writer(req, 'upload');
    const shape = 'body must be {"sha256": "<hex>", "size": <bytes>, "type": "<mime type>" or null}';
    let body: any;
    try {
      body = JSON.parse((await readSmall(req, 4096, config.mirrorBodyTimeoutMs ?? 10_000)).toString('utf8'));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, shape);
    }
    if (!body || typeof body !== 'object') throw new HttpError(400, shape);
    res.removeHeader('connection'); // the body is read
    const sha = typeof body.sha256 === 'string' ? body.sha256.toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(400, 'sha256 must be 64 hex characters');
    const size = body.size;
    if (!Number.isSafeInteger(size) || size < 1) throw new HttpError(400, 'size must be a whole number of bytes, at least 1');
    if (body.type !== undefined && body.type !== null && typeof body.type !== 'string') throw new HttpError(400, 'type must be a string or null');
    if (!auth.xs.includes(sha)) throw new HttpError(403, 'sha256 is not in the authorization');
    if (size > largest) throw new HttpError(413, `files here are at most ${largest} bytes`);

    // already this account's: nothing to send (only then: anyone can know a hash)
    if (db.holds(account.pubkey, sha) && store.has(sha)) {
      const b = db.blob(sha)!;
      db.own(b.sha256, b.size, b.type, auth.pubkey, now());
      // an upload of it left open (it came another way meanwhile) would only hold quota back
      const stale = db.uploadOf(account.pubkey, sha, live());
      if (stale && !completing.has(stale.id)) {
        stopWrites(stale.id);
        db.dropUpload(stale.id);
        store.dropUpload(stale.id);
      }
      return json(res, 200, descriptor(b, db.uploadedAt(b.sha256, auth.pubkey) ?? now()));
    }
    sweepUploads(); // an expired upload of this blob would be in the way
    const open = db.uploadOf(account.pubkey, sha, live());
    if (open) {
      if (open.size !== size) {
        throw new HttpError(409, `an upload of this sha256 with another size (${open.size} bytes) is open; cancel it (DELETE /uploads/${open.id}) first`);
      }
      return json(res, 200, statusOf(open));
    }

    const at = now();
    const r = db.openUpload(auth.pubkey, { id: randomBytes(16).toString('hex'), sha256: sha, size, type: contentType(body.type), pieceSize: pieceBytes, created: at, touched: at }, (a) => {
      if (db.openFor(a.pubkey, live()).n >= maxOpenPer) {
        return { status: 429, reason: `you have ${maxOpenPer} uploads open here, the most at once; finish or cancel one first` };
      }
      if (db.openAll(live()).n >= maxOpen) return { status: 429, reason: 'this box has too many uploads open; try again later' };
      const why = db.refusal(a, sha, size, pending(a));
      if (why) return { status: 413, reason: why };
      try {
        diskRoom(size);
      } catch (err) {
        return { status: 507, reason: (err as Error).message };
      }
      return null;
    });
    if (!r.ok) throw new HttpError(r.status, r.reason);
    try {
      store.createUpload(r.upload.id, size);
    } catch (err) {
      db.dropUpload(r.upload.id);
      throw err;
    }
    json(res, 201, statusOf(r.upload));
  }

  /** The caller's account and its open upload `id`, or the one 404 for anything else. */
  async function mine(req: http.IncomingMessage, id: string): Promise<{ auth: Auth; account: Account; u: Upload }> {
    const { auth, account } = await writer(req, 'upload');
    const u = UPLOAD_ID.test(id) ? db.upload(id) : null;
    if (!u || u.account !== account.pubkey || u.touched <= live()) throw new HttpError(404, NO_UPLOAD);
    if (!auth.xs.includes(u.sha256)) throw new HttpError(401, 'authorization must name the upload\'s sha256 in an x tag');
    return { auth, account, u };
  }

  async function uploadStatus(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const { u } = await mine(req, id);
    json(res, 200, statusOf(u));
  }

  /** PUT /uploads/<id>/<index>: one piece, streamed into its place. Sending a piece again replaces it. */
  async function piece(req: http.IncomingMessage, res: http.ServerResponse, id: string, part: string): Promise<void> {
    res.setHeader('connection', 'close'); // a refused piece's body isn't read
    const { account, u } = await mine(req, id);
    if (!/^\d{1,9}$/.test(part)) throw new HttpError(400, 'the piece number must be a whole number');
    const index = Number(part);
    if (index >= piecesOf(u)) throw new HttpError(400, `this upload has pieces 0 to ${piecesOf(u) - 1}`);
    const expected = pieceLength(u, index);
    const len = req.headers['content-length'];
    if (!len || !/^\d+$/.test(len)) throw new HttpError(411, 'content-length required');
    if (Number(len) !== expected) throw new HttpError(400, `piece ${index} must be ${expected} bytes`);
    const claimed = header(req, 'x-piece-sha-256')?.toLowerCase() ?? null;
    if (claimed !== null && !/^[0-9a-f]{64}$/.test(claimed)) throw new HttpError(400, 'x-piece-sha-256 must be 64 hex characters');
    if (completing.has(u.id)) throw new HttpError(409, 'this upload is being completed');

    const slot = take(account, { blob: false });
    let got: { sha256: string; size: number };
    try {
      // the same piece sent again while the first copy is still arriving (the phone gave up on it): the new one wins
      const k = `${u.id}/${index}`;
      for (let w = writing.get(k); w; w = writing.get(k)) {
        w.abort();
        await w.done.catch(() => {});
      }
      if (completing.has(u.id)) throw new HttpError(409, 'this upload is being completed');
      if (!db.upload(u.id)) throw new HttpError(404, NO_UPLOAD);
      db.unmarkPiece(u.id, index); // its bytes are about to change
      const stop = new AbortController();
      const done = store.writePiece(u.id, index * u.pieceSize, req, expected, {
        windowMs: config.uploadWindowMs ?? 60_000, bytesPerSecond: config.minUploadBytesPerSecond ?? MIN_RATE, expected,
      }, stop.signal);
      const w = { abort: () => stop.abort(), done };
      writing.set(k, w);
      try {
        got = await done;
      } catch (err) {
        if (err instanceof TooLarge) throw new HttpError(400, `piece ${index} must be ${expected} bytes`);
        if (err instanceof Aborted) throw new HttpError(400, 'upload aborted');
        if (err instanceof TooSlow) throw new HttpError(408, 'upload too slow: under 16 KiB a second for a minute');
        throw err;
      } finally {
        if (writing.get(k) === w) writing.delete(k);
      }
    } finally {
      slot.release();
    }
    res.removeHeader('connection'); // the body is read: the connection can carry the next piece
    if (got.size !== expected) throw new HttpError(400, `piece ${index} must be ${expected} bytes`);
    if (claimed !== null && got.sha256 !== claimed) throw new HttpError(400, 'piece does not match x-piece-sha-256');
    if (!db.markPiece(u.id, index, expected, now())) throw new HttpError(404, NO_UPLOAD);
    json(res, 200, statusOf(db.upload(u.id)!));
  }

  /**
   * POST /uploads/<id>/complete: with every piece here, hashes the whole file and stores it as an upload would. A
   * second call while the first runs (the phone lost the answer) waits for the same answer.
   */
  async function complete(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const { auth, account, u } = await mine(req, id);
    let p = completing.get(u.id);
    if (!p) {
      p = completeNow(u, auth, account);
      completing.set(u.id, p);
      p.catch(() => {}).finally(() => completing.delete(u.id));
    }
    const r = await p;
    json(res, r.status, r.body);
  }

  async function completeNow(u: Upload, auth: Auth, account: Account): Promise<{ status: number; body: unknown }> {
    const have = db.pieceCount(u.id);
    if (have < piecesOf(u)) {
      throw new HttpError(400, `${piecesOf(u) - have} of ${piecesOf(u)} pieces are missing; ask for the status and send them`);
    }
    const discard = () => {
      stopWrites(u.id);
      db.dropUpload(u.id);
      store.dropUpload(u.id);
    };
    const slot = take(account, { blob: false });
    let sha: string;
    try {
      sha = await store.hashUpload(u.id, closing.signal);
    } catch (err) {
      if (closing.signal.aborted) throw new HttpError(503, 'this box is restarting; try again');
      throw err;
    } finally {
      slot.release();
    }
    if (sha !== u.sha256) {
      discard();
      throw new HttpError(409, 'the pieces do not make the promised sha256; the upload is discarded, start over');
    }
    let placedNew = false;
    let r: ReturnType<Db['ownAsWriter']>;
    try {
      r = db.ownAsWriter(u.sha256, u.size, u.type, auth.pubkey, now(), (a) => pending(a, u.id), () => {
        if (!db.dropUpload(u.id)) throw new HttpError(404, NO_UPLOAD); // taken away while it was hashed
        placedNew = !store.has(u.sha256);
        store.commit({ tmp: store.uploadPath(u.id), sha256: u.sha256, size: u.size });
      });
    } catch (err) {
      if (placedNew) store.remove(u.sha256); // no row, no file
      discard();
      throw err;
    }
    if (!r.ok) {
      discard();
      throw new HttpError(r.status, r.reason);
    }
    return { status: r.isNew ? 201 : 200, body: descriptor(db.blob(u.sha256)!, db.uploadedAt(u.sha256, auth.pubkey) ?? now()) };
  }

  /** DELETE /uploads/<id>: abandons it, and gives back what it held. */
  async function abandon(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const { u } = await mine(req, id);
    if (completing.has(u.id)) throw new HttpError(409, 'this upload is being completed');
    stopWrites(u.id);
    db.dropUpload(u.id);
    store.dropUpload(u.id);
    end(res, 204);
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
  home?.start();
  if (!opts.noKeeperStart) keeper?.start();
  if (!opts.noPeerStart) peers?.start();
  if (opts.towns === undefined) void towns?.load(); // after listening: `names` says "still loading" until it is in
  let closed: Promise<void> | null = null;
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;

  return {
    server,
    db,
    url: `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`,
    sweep,
    sweepUploads,
    serviceKey: key,
    home,
    keeper,
    towns,
    peers,
    close: async () => {
      // safe to call twice: the second call waits for the first
      closed ??= (async () => {
        await home?.stop();
        await keeper?.stop();
        await peers?.stop();
        closing.abort();
        clearInterval(uploadTimer);
        await new Promise<void>((resolve) => {
          clearInterval(timer);
          server.closeAllConnections();
          server.close(() => resolve());
        });
        // pieces and completions cut off above settle first, so none of them reaches a closed database
        await Promise.allSettled([...[...writing.values()].map((w) => w.done), ...completing.values()]);
        db.close();
      })();
      return closed;
    },
  };
}

function cors(res: http.ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'Authorization, *');
  res.setHeader('access-control-allow-methods', 'GET, HEAD, PUT, DELETE, POST');
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
