// Fixes from the 2026-11-21 security review. Each test here failed before its fix.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { auth, box, key, put, sha, tempDir, type Box } from './helpers.ts';

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
