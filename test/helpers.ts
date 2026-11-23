import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/auth.ts';
import type { Config } from '../src/config.ts';
import { start, type Running } from '../src/server.ts';

export const DOMAIN = 'storage.test';

export const tempDir = () => mkdtempSync(join(tmpdir(), 'keykin-storage-test-'));

export interface Key {
  sk: Uint8Array;
  pk: string;
}

export function key(): Key {
  const sk = schnorr.utils.randomSecretKey();
  return { sk, pk: Buffer.from(schnorr.getPublicKey(sk)).toString('hex') };
}

export const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

export interface AuthOpts {
  t: string;
  x?: string[];
  server?: string[] | null;
  expiration?: number | null;
  createdAt?: number;
  now?: number;
  tamper?: boolean;
}

export function auth(k: Key, o: AuthOpts): string {
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const tags: string[][] = [['t', o.t]];
  for (const x of o.x ?? []) tags.push(['x', x]);
  for (const s of o.server === undefined ? [DOMAIN] : o.server ?? []) tags.push(['server', s]);
  if (o.expiration !== null) tags.push(['expiration', String(o.expiration ?? now + 600)]);
  const e: any = { pubkey: k.pk, created_at: o.createdAt ?? now - 1, kind: 24242, tags, content: `${o.t} blob` };
  e.id = eventId(e);
  e.sig = Buffer.from(schnorr.sign(Buffer.from(e.id, 'hex'), k.sk)).toString('hex');
  if (o.tamper) e.content += '!';
  return 'Nostr ' + Buffer.from(JSON.stringify(e)).toString('base64url');
}

export interface Box {
  run: Running;
  url: string;
  owner: Key;
  clock: { now: number };
  dir: string;
  close(): Promise<void>;
}

/** A server on a free loopback port, in a temp folder, with a settable clock. Close it in after(). */
export async function box(over: Partial<Config> = {}, opts: { dir?: string; owner?: Key } = {}): Promise<Box> {
  const dir = opts.dir ?? tempDir();
  const owner = opts.owner ?? key();
  const clock = { now: Math.floor(Date.now() / 1000) };
  const run = await start({
    dataDir: dir, host: '127.0.0.1', port: 0, publicUrl: `https://${DOMAIN}`, domains: [DOMAIN], owner: owner.pk,
    maxBlobBytes: 1024 * 1024, maxBlobsPerAccount: 200_000, binDays: 30, mirrorTimeoutMs: 5000, diskMarginBytes: 0, behindCloudflare: false, homeUrl: '', memberQuota: 5e9, homePollS: 300, now: () => clock.now, keeper: false, ...over,
  });
  return {
    run, url: run.url, owner, clock, dir,
    close: async () => {
      await run.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A plain HTTP server for /mirror to fetch from. Close it in after(). */
export async function origin(routes: Record<string, (res: http.ServerResponse) => void>): Promise<{ url: string; close(): Promise<void> }> {
  const s = http.createServer((req, res) => {
    const f = routes[req.url ?? ''];
    if (f) f(res);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }),
  };
}

export async function put(b: Box, k: Key, body: Uint8Array, extra: Partial<AuthOpts> = {}, headers: Record<string, string> = {}) {
  return fetch(`${b.url}/upload`, {
    method: 'PUT', body,
    headers: { authorization: auth(k, { t: 'upload', x: [sha(body)], now: b.clock.now, ...extra }), 'content-type': 'application/octet-stream', ...headers },
  });
}

/** Runs the CLI against a data folder and returns what it printed. Throws (with its output) if it fails. */
export function cli(dir: string, ...args: string[]): string;
export function cli(dir: string, env: Record<string, string>, ...args: string[]): string;
export function cli(dir: string, ...rest: unknown[]): string {
  const env = typeof rest[0] === 'object' ? rest.shift() as Record<string, string> : {};
  try {
    return execFileSync(process.execPath, ['src/cli.ts', ...rest as string[]], {
      env: { ...process.env, ...env, STORAGE_DIR: dir, NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: 20_000, stdio: 'pipe',
    });
  } catch (err: any) {
    throw new Error(`cli ${rest.join(' ')} failed: ${err.stdout ?? ''}${err.stderr ?? ''}`);
  }
}

export interface FakeHome {
  url: string;
  /** What the home answers next: a status and a body (string or JSON). */
  reply: () => { status: number; body: unknown };
  /** Requests that came in, and why any of them failed the home's checks. */
  calls: number;
  refused: string[];
  close(): Promise<void>;
}

/**
 * A home on a loopback port that checks each memberkeys request the way the real one does: POST /, the content
 * type, a kind 27235 event signed by `registered` with u = this url, method POST, payload = sha256 of the exact body,
 * created_at within 60 s of `clock`. Answers 401 when a check fails (and records why), else `reply()`.
 */
export async function fakeHome(registered: () => string, clock: () => number): Promise<FakeHome> {
  const { verifyEvent } = await import('./nip98.ts');
  const h: FakeHome = {
    url: '', calls: 0, refused: [],
    reply: () => ({ status: 200, body: { result: { owner: registered(), members: [], removed: [] } } }),
    close: async () => {},
  };
  const s = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      h.calls++;
      const body = Buffer.concat(parts).toString('utf8');
      const why = verifyEvent(req, body, `${h.url}/`, registered(), clock());
      const send = (status: number, b: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(typeof b === 'string' ? b : JSON.stringify(b));
      if (why === 'unregistered') return send(401, { error: "memberkeys is only for this relay's storage service" });
      if (why) {
        h.refused.push(why);
        return send(401, { error: why });
      }
      const r = h.reply();
      send(r.status, r.body);
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  h.url = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  h.close = () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  return h;
}
