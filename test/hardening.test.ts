// Fixes from the 2026-11-21 security review. Each test here failed before its fix.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { auth, box, cli, key, put, sha, tempDir, type Box } from './helpers.ts';

const DAY = 86400;

/** The 0.1.0 schema, to build a database the way a box running 0.1.0 left it. */
const SCHEMA_0_1 = `
  CREATE TABLE accounts (pubkey TEXT PRIMARY KEY, quota INTEGER, added INTEGER NOT NULL);
  CREATE TABLE keys (key TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(pubkey) ON DELETE CASCADE);
  CREATE TABLE blobs (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, type TEXT NOT NULL, created INTEGER NOT NULL, binned INTEGER, binned_by TEXT);
  CREATE TABLE owners (sha256 TEXT NOT NULL REFERENCES blobs(sha256) ON DELETE CASCADE, key TEXT NOT NULL, uploaded INTEGER NOT NULL, PRIMARY KEY (sha256, key));
  CREATE INDEX owners_by_key ON owners(key, uploaded, sha256);
  CREATE INDEX blobs_binned ON blobs(binned) WHERE binned IS NOT NULL;`;

describe('1. quota math is O(1)', () => {
  let b: Box;
  const friend = key(), owner = key();
  const N = 50_000;
  before(async () => {
    const dir = tempDir();
    const old = new DatabaseSync(join(dir, 'storage.db'));
    old.exec(SCHEMA_0_1);
    old.exec('BEGIN');
    const acc = old.prepare('INSERT INTO accounts VALUES (?, ?, 1)'), k = old.prepare('INSERT INTO keys VALUES (?, ?)');
    acc.run(owner.pk, null); k.run(owner.pk, owner.pk);
    acc.run(friend.pk, 10 ** 12); k.run(friend.pk, friend.pk);
    const bl = old.prepare("INSERT INTO blobs VALUES (?, 5000, 'application/octet-stream', 1, ?, ?)");
    const ow = old.prepare('INSERT INTO owners VALUES (?, ?, 1)');
    for (let i = 0; i < N; i++) {
      const s = randomBytes(32).toString('hex');
      if (i % 10 === 0) bl.run(s, Math.floor(Date.now() / 1000) - DAY, friend.pk); // in the bin, on the friend's quota
      else { bl.run(s, null, null); ow.run(s, friend.pk); }
    }
    old.exec('COMMIT');
    old.close();
    b = await box({}, { dir, owner });
  });
  after(() => b.close());

  it('counts existing blobs once on upgrade and answers HEAD /upload without summing them', async () => {
    const acc = b.run.db.accountOf(friend.pk)!;
    assert.equal(acc.blobs, N);
    assert.equal(acc.used, b.run.db.usage(friend.pk));
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const x = sha(String(i));
      const t = performance.now();
      const r = await fetch(`${b.url}/upload`, { method: 'HEAD', headers: { authorization: auth(friend, { t: 'upload', x: [x], now: b.clock.now }), 'x-sha-256': x, 'x-content-length': '10' } });
      times.push(performance.now() - t);
      assert.equal(r.status, 200);
    }
    times.sort((p, q) => p - q);
    assert.ok(times[3] < 40, `median HEAD /upload took ${times[3].toFixed(1)} ms`);
  });

  it('keeps the running totals equal to a full count through own, delete, bin, erase and remove', async () => {
    const a = key(), c = key();
    b.run.db.putAccount(a.pk, 10 ** 9, b.clock.now);
    b.run.db.putAccount(c.pk, 10 ** 9, b.clock.now);
    const check = () => {
      for (const k of [a, c, b.owner]) {
        const acc = b.run.db.accountOf(k.pk);
        if (acc) assert.equal(acc.used, b.run.db.usage(k.pk), 'used');
      }
    };
    const blobs = Array.from({ length: 6 }, (_, i) => randomBytes(100 * (i + 1)));
    const del = (k: typeof a, x: string) =>
      fetch(`${b.url}/${x}`, { method: 'DELETE', headers: { authorization: auth(k, { t: 'delete', x: [x], now: b.clock.now }) } });
    for (const x of blobs) { await put(b, a, x); check(); }
    for (const x of blobs.slice(0, 3)) { await put(b, c, x); check(); }
    await del(a, sha(blobs[0])); check(); // c still holds it
    await del(c, sha(blobs[0])); check(); // binned on c
    await put(b, a, blobs[0]); check(); // back out of the bin, now on a, off c
    await del(a, sha(blobs[4])); check(); // binned on a
    await put(b, c, blobs[4]); check(); // c takes it: off a, on c
    await del(a, sha(blobs[5])); check();
    b.clock.now += 31 * DAY;
    b.run.sweep(); check();
    b.run.db.removeAccount(a.pk, b.clock.now); check();
    b.run.db.putAccount(a.pk, 10 ** 9, b.clock.now); check(); // binned on a again, counted once more
    assert.equal(b.run.db.accountOf(a.pk)!.used, b.run.db.usage(a.pk));
  });

  it('accepts at most 16 x tags in one authorization', async () => {
    const body = randomBytes(10);
    const xs = [sha(body), ...Array.from({ length: 16 }, (_, i) => sha('pad' + i))];
    const r = await put(b, b.owner, body, { x: xs });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('x-reason')!, /x tags/);
    assert.equal((await put(b, b.owner, body, { x: xs.slice(0, 16) })).status, 201);
  });
});

describe('2. small blobs cost at least 4 KiB, and an account holds a capped number of blobs', () => {
  let b: Box;
  before(async () => { b = await box({ maxBlobsPerAccount: 3 }); });
  after(() => b.close());

  it('charges a tiny blob 4096 bytes', async () => {
    const friend = key();
    b.run.db.putAccount(friend.pk, 10_000, b.clock.now);
    assert.equal((await put(b, friend, randomBytes(10))).status, 201);
    assert.equal((await put(b, friend, randomBytes(10))).status, 201);
    assert.equal(b.run.db.accountOf(friend.pk)!.used, 8192);
    assert.equal(b.run.db.usage(friend.pk), 8192);
    assert.equal((await put(b, friend, randomBytes(10))).status, 413);
  });

  it('refuses a blob past the per-account blob cap', async () => {
    const friend = key();
    b.run.db.putAccount(friend.pk, 10 ** 9, b.clock.now);
    for (let i = 0; i < 3; i++) assert.equal((await put(b, friend, randomBytes(10))).status, 201);
    const r = await put(b, friend, randomBytes(10));
    assert.equal(r.status, 413);
    assert.match(r.headers.get('x-reason')!, /blobs/);
  });

  it('reads the cap from STORAGE_MAX_BLOBS, 200,000 by default', async () => {
    const { configFromEnv } = await import('../src/config.ts');
    assert.equal(configFromEnv({}).maxBlobsPerAccount, 200_000);
    assert.equal(configFromEnv({ STORAGE_MAX_BLOBS: '50' }).maxBlobsPerAccount, 50);
  });
});

describe('3. strangers cost no signature check, and signed requests are rate limited per address', () => {
  let b: Box, cf: Box;
  before(async () => {
    b = await box();
    cf = await box({ behindCloudflare: true, authBurst: 3, authPerSecond: 0.001 });
  });
  after(async () => { await b.close(); await cf.close(); });

  it('refuses an unknown key before checking its signature', async () => {
    const stranger = key(), body = randomBytes(10);
    const r = await put(b, stranger, body, { tamper: true });
    assert.equal(r.status, 403);
    assert.match(r.headers.get('x-reason')!, /may not write/);
    const x = sha(body);
    const pre = await fetch(`${b.url}/upload`, { method: 'HEAD', headers: { authorization: auth(stranger, { t: 'upload', x: [x], now: b.clock.now, tamper: true }), 'x-sha-256': x, 'x-content-length': '10' } });
    assert.equal(pre.status, 403);
    const del = await fetch(`${b.url}/${x}`, { method: 'DELETE', headers: { authorization: auth(stranger, { t: 'delete', x: [x], now: b.clock.now, tamper: true }) } });
    assert.equal(del.status, 404);
    const list = await fetch(`${b.url}/list/${b.owner.pk}`, { headers: { authorization: auth(stranger, { t: 'list', now: b.clock.now, tamper: true }) } });
    assert.equal(list.status, 403);
    // a known key with a bad signature is still a 401
    assert.equal((await put(b, b.owner, body, { tamper: true })).status, 401);
  });

  it('answers 429 to an address sending too many signed requests, by CF-Connecting-IP behind Cloudflare', async () => {
    const send = (ip: string) => fetch(`${cf.url}/list/${cf.owner.pk}`, { headers: { authorization: auth(cf.owner, { t: 'list', now: cf.clock.now }), 'cf-connecting-ip': ip } });
    for (let i = 0; i < 3; i++) assert.equal((await send('203.0.113.7')).status, 200);
    const r = await send('203.0.113.7');
    assert.equal(r.status, 429);
    assert.ok(r.headers.get('x-reason'));
    assert.equal((await send('203.0.113.8')).status, 200); // another address has its own allowance
    assert.equal((await fetch(`${cf.url}/`, { headers: { 'cf-connecting-ip': '203.0.113.7' } })).status, 200); // unsigned reads are not limited
  });

  it('ignores CF-Connecting-IP unless told it is behind Cloudflare', async () => {
    const other = await box({ authBurst: 2, authPerSecond: 0.001 });
    try {
      const send = (ip: string) => fetch(`${other.url}/list/${other.owner.pk}`, { headers: { authorization: auth(other.owner, { t: 'list', now: other.clock.now }), 'cf-connecting-ip': ip } });
      assert.equal((await send('203.0.113.1')).status, 200);
      assert.equal((await send('203.0.113.2')).status, 200);
      assert.equal((await send('203.0.113.3')).status, 429); // all from the one socket address
    } finally {
      await other.close();
    }
  });
});

describe('3b. the rate limit itself', () => {
  it('refills over time and remembers a bounded number of addresses', async () => {
    const { RateLimit } = await import('../src/limit.ts');
    const l = new RateLimit({ burst: 2, perSecond: 1, maxAddresses: 3 });
    assert.equal(l.take('a', 0), true);
    assert.equal(l.take('a', 0), true);
    assert.equal(l.take('a', 0), false);
    assert.equal(l.take('a', 1000), true);
    for (let i = 0; i < 100; i++) l.take(`10.0.0.${i}`, 2000);
    assert.equal(l.size, 3);
  });
});

describe('4. take-down: erase now, purge an account, short cache lifetime', () => {
  let b: Box;
  before(async () => { b = await box(); });
  after(() => b.close());
  const del = (k: typeof b.owner, x: string) =>
    fetch(`${b.url}/${x}`, { method: 'DELETE', headers: { authorization: auth(k, { t: 'delete', x: [x], now: b.clock.now }) } });
  const status = async (x: Uint8Array) => (await fetch(`${b.url}/${sha(x)}`)).status;

  it('serves blobs with a one-day cache lifetime, not immutable', async () => {
    const x = randomBytes(10);
    await put(b, b.owner, x);
    const cc = (await fetch(`${b.url}/${sha(x)}`)).headers.get('cache-control')!;
    assert.equal(cc, 'public, max-age=86400');
  });

  it('erase <sha256> removes the row and the file at once, owned or binned', async () => {
    const x = randomBytes(5000);
    await put(b, b.owner, x);
    assert.match(cli(b.dir, 'erase', sha(x)), /erased/);
    assert.equal(await status(x), 404);
    assert.equal(b.run.db.blob(sha(x)), null);
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(join(b.dir, 'blobs', sha(x).slice(0, 2), sha(x).slice(2, 4), sha(x))), false);
    assert.equal(b.run.db.accountOf(b.owner.pk)!.used, b.run.db.usage(b.owner.pk));
    assert.throws(() => cli(b.dir, 'erase', sha(x)), /not here/);
  });

  it('remove <npub> --purge erases what only that account holds, and leaves shared blobs', async () => {
    const friend = key();
    b.run.db.putAccount(friend.pk, 10 ** 9, b.clock.now);
    const alone = randomBytes(100), shared = randomBytes(100), binned = randomBytes(100);
    for (const x of [alone, shared, binned]) assert.equal((await put(b, friend, x)).status, 201);
    await put(b, b.owner, shared);
    assert.equal((await del(friend, sha(binned))).status, 204);
    const out = cli(b.dir, 'remove', friend.pk, '--purge');
    assert.match(out, /erased 2/);
    assert.equal(await status(alone), 404);
    assert.equal(await status(binned), 404);
    assert.equal(await status(shared), 200);
    assert.equal(b.run.db.accountOf(friend.pk), null);
    assert.equal(b.run.db.uploadedAt(sha(shared), friend.pk), null);
  });
});

describe('5. /mirror is for the owner only', () => {
  let b: Box;
  before(async () => { b = await box({ mirrorAllowPrivate: true }); });
  after(() => b.close());

  it('refuses a friend with 403 and says why, before fetching anything', async () => {
    const friend = key();
    b.run.db.putAccount(friend.pk, null, b.clock.now);
    let fetched = 0;
    const http = await import('node:http');
    const src = http.createServer((_q, s) => { fetched++; s.end('x'); });
    await new Promise<void>((r) => src.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(src.address() as { port: number }).port}/x`;
      const r = await fetch(`${b.url}/mirror`, { method: 'PUT', body: JSON.stringify({ url }), headers: { authorization: auth(friend, { t: 'upload', x: [sha('x')], now: b.clock.now }) } });
      assert.equal(r.status, 403);
      assert.match(r.headers.get('x-reason')!, /owner/);
      assert.equal(fetched, 0);
      const o = await fetch(`${b.url}/mirror`, { method: 'PUT', body: JSON.stringify({ url }), headers: { authorization: auth(b.owner, { t: 'upload', x: [sha('x')], now: b.clock.now }) } });
      assert.equal(o.status, 201);
    } finally {
      src.closeAllConnections();
      await new Promise((r) => src.close(r));
    }
  });
});

describe('6. tokens age out', () => {
  let b: Box;
  before(async () => { b = await box(); });
  after(() => b.close());
  const H = 3600;

  it('refuses an expiration more than 25 hours ahead', async () => {
    const r = await put(b, b.owner, randomBytes(10), { expiration: b.clock.now + 26 * H });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('x-reason')!, /expiration/);
    assert.equal((await put(b, b.owner, randomBytes(10), { expiration: b.clock.now + 24 * H })).status, 201);
  });

  it('refuses a created_at more than 25 hours old', async () => {
    const r = await put(b, b.owner, randomBytes(10), { createdAt: b.clock.now - 26 * H });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('x-reason')!, /old/);
    assert.equal((await put(b, b.owner, randomBytes(10), { createdAt: b.clock.now - 24 * H })).status, 201);
  });
});

describe('7. slow uploads and slow mirror bodies are cut off', () => {
  let b: Box;
  // a 200 ms window at 16 KiB/s: at least 3,276 bytes per window
  before(async () => { b = await box({ uploadWindowMs: 200, mirrorBodyTimeoutMs: 300 }); });
  after(() => b.close());
  const http = () => import('node:http');

  it('aborts an upload that trickles in under the minimum rate, and frees its slot', async () => {
    const body = randomBytes(100_000);
    const req = (await http()).request(`${b.url}/upload`, {
      method: 'PUT', headers: { authorization: auth(b.owner, { t: 'upload', x: [sha(body)], now: b.clock.now }), 'content-length': String(body.length) },
    });
    const answer = new Promise<number>((r) => { req.on('response', (m) => { m.resume(); r(m.statusCode!); }); req.on('error', () => r(-1)); });
    let i = 0;
    const drip = setInterval(() => { if (i < body.length) req.write(body.subarray(i, i += 100)); }, 50);
    const t = Date.now();
    const status = await answer;
    clearInterval(drip);
    req.destroy();
    assert.equal(status, 408);
    assert.ok(Date.now() - t < 2000);
    assert.equal(b.run.db.blob(sha(body)), null);
    // the slot is free again: four more uploads at once still fit
    const rs = await Promise.all(Array.from({ length: 4 }, () => put(b, b.owner, randomBytes(10))));
    assert.deepEqual(rs.map((r) => r.status), [201, 201, 201, 201]);
  });

  it('lets an upload through that keeps up, even across several windows', async () => {
    const body = randomBytes(60_000);
    const req = (await http()).request(`${b.url}/upload`, {
      method: 'PUT', headers: { authorization: auth(b.owner, { t: 'upload', x: [sha(body)], now: b.clock.now }), 'content-length': String(body.length) },
    });
    const answer = new Promise<number>((r) => { req.on('response', (m) => { m.resume(); r(m.statusCode!); }); req.on('error', () => r(-1)); });
    for (let i = 0; i < body.length; i += 6000) {
      req.write(body.subarray(i, i + 6000)); // 6,000 bytes per 100 ms: well over the minimum
      await new Promise((r) => setTimeout(r, 100));
    }
    req.end();
    assert.equal(await answer, 201);
  });

  it('gives the /mirror body a deadline', async () => {
    const req = (await http()).request(`${b.url}/mirror`, {
      method: 'PUT', headers: { authorization: auth(b.owner, { t: 'upload', x: [sha('m')], now: b.clock.now }), 'content-length': '100' },
    });
    const answer = new Promise<number>((r) => { req.on('response', (m) => { m.resume(); r(m.statusCode!); }); req.on('error', () => r(-1)); });
    req.write('{"url": "http');
    const status = await Promise.race([answer, new Promise<number>((r) => setTimeout(() => r(0), 3000))]);
    req.destroy();
    assert.equal(status, 408);
  });
});

describe('8. only images, video and audio are served inline', () => {
  let b: Box;
  before(async () => { b = await box(); });
  after(() => b.close());

  it('serves HTML, SVG and the rest as an octet-stream attachment, media as itself', async () => {
    const cases: [string, string, boolean][] = [
      ['text/html', 'application/octet-stream', true],
      ['image/svg+xml', 'application/octet-stream', true],
      ['application/pdf', 'application/octet-stream', true],
      ['application/xhtml+xml', 'application/octet-stream', true],
      ['image/png', 'image/png', false],
      ['video/mp4', 'video/mp4', false],
      ['audio/ogg', 'audio/ogg', false],
    ];
    for (const [sent, served, attachment] of cases) {
      const body = randomBytes(20);
      const up = await put(b, b.owner, body, {}, { 'content-type': sent });
      assert.equal(((await up.json()) as any).type, sent); // the descriptor keeps what was sent
      const g = await fetch(`${b.url}/${sha(body)}`);
      assert.equal(g.headers.get('content-type'), served, sent);
      assert.equal(/^attachment/.test(g.headers.get('content-disposition') ?? ''), attachment, sent);
      await g.arrayBuffer();
    }
  });
});

describe('9. a malformed request line is a quiet 400', () => {
  let b: Box;
  before(async () => { b = await box(); });
  after(() => b.close());

  it('answers 400 and logs nothing', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const net = await import('node:net');
    const port = Number(new URL(b.url).port);
    for (const line of ['GET // HTTP/1.1', 'GET http://[::1 HTTP/1.1', 'GET /ÿ HTTP/1.1']) {
      const answer = await new Promise<string>((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(`${line}\r\nHost: x\r\nConnection: close\r\n\r\n`));
        let got = '';
        s.on('data', (c) => { got += c; });
        s.on('close', () => resolve(got));
        s.on('error', () => resolve(got));
      });
      assert.match(answer, /^HTTP\/1\.1 400/, line);
    }
    assert.equal(logged.mock.callCount(), 0);
  });
});

describe('10. the account check and the ownership write are one transaction', () => {
  let b: Box;
  before(async () => { b = await box(); });
  after(() => b.close());

  it('never leaves a removed account owning a blob, even when the CLI removes it mid-check', async () => {
    const { Db } = await import('../src/db.ts');
    const friend = key();
    b.run.db.putAccount(friend.pk, null, b.clock.now);
    const cliDb = new Db(join(b.dir, 'storage.db'));
    cliDb.sql.exec('PRAGMA busy_timeout = 0'); // like another process: fails fast while the server holds the write lock
    let armed = false, removed = false;
    const db = b.run.db as any;
    const accountOf = db.accountOf.bind(db);
    db.accountOf = (k: string) => {
      const r = accountOf(k);
      if (armed && !removed && k === friend.pk) {
        armed = false;
        const tryRemove = () => {
          try { cliDb.removeAccount(friend.pk, b.clock.now); removed = true; } catch { setTimeout(tryRemove, 5); }
        };
        tryRemove(); // right after the server's check
      }
      return r;
    };
    try {
      const body = randomBytes(1000);
      const req = (await import('node:http')).request(`${b.url}/upload`, {
        method: 'PUT', headers: { authorization: auth(friend, { t: 'upload', x: [sha(body)], now: b.clock.now }), 'content-length': '1000' },
      });
      const res = new Promise<number>((r) => req.on('response', (m) => { m.resume(); r(m.statusCode!); }));
      req.write(body.subarray(0, 500));
      await new Promise((r) => setTimeout(r, 50));
      armed = true;
      req.end(body.subarray(500));
      await res;
      while (!removed) await new Promise((r) => setTimeout(r, 5));
      assert.equal(b.run.db.accountOf(friend.pk), null);
      assert.equal(b.run.db.uploadedAt(sha(body), friend.pk), null, 'a removed account still owns the blob');
    } finally {
      db.accountOf = accountOf;
      cliDb.close();
    }
  });
});

describe('11. numeric settings are checked', () => {
  it('refuses a value that is not a positive number, naming the setting', async () => {
    const { configFromEnv } = await import('../src/config.ts');
    for (const name of ['STORAGE_MAX_BLOB_MB', 'STORAGE_MAX_REQUEST_MB', 'STORAGE_PIECE_MB', 'STORAGE_BIN_DAYS', 'STORAGE_MIRROR_TIMEOUT_S', 'STORAGE_MAX_BLOBS', 'STORAGE_PORT']) {
      for (const bad of ['256M', '0', '-5', 'Infinity', 'NaN', '1e400', 'ten']) {
        assert.throws(() => configFromEnv({ [name]: bad }), new RegExp(name), `${name}=${bad}`);
      }
    }
    assert.throws(() => configFromEnv({ STORAGE_PORT: '70000' }), /STORAGE_PORT/);
    assert.throws(() => configFromEnv({ STORAGE_MAX_BLOBS: '10.5' }), /STORAGE_MAX_BLOBS/);
    const c = configFromEnv({ STORAGE_MAX_BLOB_MB: '', STORAGE_BIN_DAYS: ' 7 ', STORAGE_PORT: '8080' });
    assert.equal(c.maxBlobBytes, 16 * 1024 * 1024 * 1024);
    assert.equal(c.maxRequestBytes, 256 * 1024 * 1024);
    assert.equal(c.pieceBytes, 8 * 1024 * 1024);
    assert.throws(() => configFromEnv({ STORAGE_PIECE_MB: '65' }), /STORAGE_PIECE_MB/);
    assert.throws(() => configFromEnv({ STORAGE_PIECE_MB: '1.5' }), /STORAGE_PIECE_MB/);
    assert.equal(configFromEnv({ STORAGE_MAX_BLOB_MB: '100' }).maxRequestBytes, 100 * 1024 * 1024);
    assert.equal(c.binDays, 7);
    assert.equal(c.port, 8080);
  });

  it('does not start with a bad setting, and says which', async () => {
    const { spawnSync } = await import('node:child_process');
    const dir = tempDir();
    const r = spawnSync(process.execPath, ['src/main.ts'], {
      env: { ...process.env, STORAGE_DIR: dir, STORAGE_ADDR: '127.0.0.1', STORAGE_PORT: '47999', STORAGE_MAX_BLOB_MB: '256M', NODE_NO_WARNINGS: '1' },
      encoding: 'utf8', timeout: 10_000,
    });
    (await import('node:fs')).rmSync(dir, { recursive: true, force: true });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /STORAGE_MAX_BLOB_MB/);
    assert.doesNotMatch(r.stderr, /at configFromEnv/); // a plain line, not a stack
  });
});

describe('12. the mirror guard', () => {
  it('blocks IPv4-translated IPv6 (::ffff:0:0:0/96)', async () => {
    const { isBlockedAddress } = await import('../src/mirror.ts');
    for (const ip of ['::ffff:0:7f00:1', '::ffff:0:a00:1', '::ffff:0:0:0', '::ffff:0:ffff:ffff']) assert.equal(isBlockedAddress(ip), true, ip);
  });
});
