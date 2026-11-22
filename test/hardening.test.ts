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
