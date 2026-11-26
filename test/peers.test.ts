// Copies between boxes (peers.ts): two real boxes on loopback that copy from each other, and a fake peer for bytes
// and answers that are wrong. The request signer for /peer is written from the contract (NIP-98 over the exact body,
// `u` naming /peer), not from src/home.ts.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { configFromEnv, parsePeers } from '../src/config.ts';
import { Db } from '../src/db.ts';
import { npub } from '../src/keys.ts';
import { isBlockedAddress } from '../src/mirror.ts';
import { statusLine, statusOf } from '../src/peers.ts';
import { serviceKey } from '../src/servicekey.ts';
import { removeBlobFile } from '../src/store.ts';
import { auth, box, cli, key, put, sha, tempDir, type Box, type Key } from './helpers.ts';

const DAY = 86400;
const CT = 'application/nostr+json+rpc';

const freePort = () => new Promise<number>((resolve) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => resolve(p));
  });
});

const file = (b: { dir: string }, x: string) => join(b.dir, 'blobs', x.slice(0, 2), x.slice(2, 4), x);
const del = (b: Box, k: Key, x: string) =>
  fetch(`${b.url}/${x}`, { method: 'DELETE', headers: { authorization: auth(k, { t: 'delete', x: [x], now: b.clock.now }) } });
const get = async (b: Box, x: string) => {
  const r = await fetch(`${b.url}/${x}`);
  return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
};

/** What a box holds, as plain rows: blobs, owners, holds, erases, quotas. Two boxes that agree have equal views. */
function view(db: Db) {
  return {
    blobs: db.sql.prepare('SELECT sha256, size, type, binned FROM blobs ORDER BY sha256').all(),
    owners: db.sql.prepare('SELECT sha256, key, uploaded FROM owners ORDER BY sha256, key').all(),
    holds: db.sql.prepare('SELECT sha256, key, held, at, uploaded FROM holds ORDER BY sha256, key').all(),
    erased: db.sql.prepare('SELECT sha256, at FROM erased ORDER BY sha256').all(),
    accounts: db.sql.prepare('SELECT pubkey, used, blobs FROM accounts ORDER BY pubkey').all(),
  };
}

/** Two boxes that are each other's peer, with one owner, one friend on both, and one clock. */
async function pair() {
  const owner = key(), friend = key();
  const dirs = [tempDir(), tempDir()];
  const keys = dirs.map((d) => serviceKey(d));
  const ports = [await freePort(), await freePort()];
  const clock = { now: Math.floor(Date.now() / 1000) };
  const peerOf = (i: number) => [{ name: i === 0 ? 'xumbrel' : 'ambrel', url: `http://127.0.0.1:${ports[i]}`, pubkey: keys[i].pk }];
  const up = async (i: number): Promise<Box> => {
    const b = await box({ port: ports[i], peers: peerOf(1 - i), peerIdleMs: 2000, now: () => clock.now }, { dir: dirs[i], owner, start: { noPeerStart: true } });
    b.clock = clock;
    b.run.db.putAccount(friend.pk, 10_000_000, clock.now);
    return b;
  };
  const boxes: (Box | null)[] = [await up(0), await up(1)];
  return {
    owner, friend, clock, keys, dirs,
    get a() { return boxes[0]!; },
    get b() { return boxes[1]!; },
    /** Stops a box without removing its data. */
    async down(i: number) {
      await boxes[i]!.run.close();
      boxes[i] = null;
    },
    async up(i: number) {
      boxes[i] = await up(i);
    },
    /** Both boxes read each other until neither has anything left to do. */
    async settle() {
      for (let n = 0; n < 3; n++) {
        for (const b of boxes) await b?.run.peers!.sync();
      }
    },
    async close() {
      for (const b of boxes) await b?.run.close();
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    },
  };
}

type Pair = Awaited<ReturnType<typeof pair>>;

describe('copies between two boxes', () => {
  let p: Pair;
  afterEach(() => p?.close());

  it('a file uploaded to one box is on the other, with the same owners and quota, served by hash', async () => {
    p = await pair();
    const x = randomBytes(300_000), y = randomBytes(5000);
    assert.equal((await put(p.a, p.friend, x, {}, { 'content-type': 'video/mp4' })).status, 201);
    assert.equal((await put(p.b, p.owner, y)).status, 201);
    await p.settle();
    for (const b of [p.a, p.b]) {
      const r = await get(b, sha(x));
      assert.equal(r.status, 200);
      assert.ok(r.body.equals(x));
      assert.equal((await get(b, sha(y))).status, 200);
    }
    assert.equal(p.b.run.db.blob(sha(x))!.type, 'video/mp4');
    assert.equal(p.b.run.db.account(p.friend.pk)!.used, 300_000);
    assert.equal(p.a.run.db.account(p.owner.pk)!.used, 5000);
    assert.equal(p.b.run.db.uploadedAt(sha(x), p.friend.pk), p.a.run.db.uploadedAt(sha(x), p.friend.pk));
    assert.deepEqual(view(p.a.run.db), view(p.b.run.db));
    // the friend may list and delete its copy on the box it never uploaded to
    const list = await fetch(`${p.b.url}/list/${p.friend.pk}`, { headers: { authorization: auth(p.friend, { t: 'list', now: p.clock.now }) } });
    assert.deepEqual(((await list.json()) as any).map((d: any) => d.sha256), [sha(x)]);
  });

  it('reading the same changes again changes nothing', async () => {
    p = await pair();
    await put(p.a, p.friend, randomBytes(4000));
    await p.settle();
    const before = view(p.b.run.db);
    // read everything again from the start
    p.b.run.db.savePeer(p.keys[0].pk, { cursor: 0 });
    await p.b.run.peers!.sync();
    p.a.run.db.savePeer(p.keys[1].pk, { cursor: 0 });
    await p.a.run.peers!.sync();
    assert.deepEqual(view(p.b.run.db), before);
    assert.deepEqual(view(p.a.run.db), before);
    // and taking in the very same change by hand
    const c = p.a.run.db.changesSince(0, 10).changes[0];
    assert.equal(p.b.run.db.applyPeer(c, p.keys[0].pk, 0), 'none');
    assert.deepEqual(view(p.b.run.db), before);
  });

  it('a delete goes to the bin on both, a restore comes back on both, an erase goes from both', async () => {
    p = await pair();
    const x = randomBytes(6000);
    await put(p.a, p.friend, x);
    await p.settle();
    p.clock.now += 60;
    assert.equal((await del(p.b, p.friend, sha(x))).status, 204);
    await p.settle();
    for (const b of [p.a, p.b]) {
      assert.equal(b.run.db.blob(sha(x))!.binned, p.clock.now);
      assert.equal((await get(b, sha(x))).status, 200); // the bin is still served
      assert.equal(b.run.db.account(p.friend.pk)!.used, 6000); // and still on the quota of who let go
    }
    p.clock.now += 60;
    assert.ok(p.a.run.db.restore(sha(x), p.clock.now, { fallback: p.owner.pk }));
    await p.settle();
    assert.equal(p.b.run.db.blob(sha(x))!.binned, null);
    assert.equal(p.b.run.db.uploadedAt(sha(x), p.friend.pk) !== null, true);
    p.clock.now += 60;
    assert.ok(p.b.run.db.eraseNow(sha(x), p.clock.now));
    removeBlobFile(p.dirs[1], sha(x));
    await p.settle();
    for (const b of [p.a, p.b]) {
      assert.equal(b.run.db.blob(sha(x)), null);
      assert.equal(existsSync(file(b, sha(x))), false);
      assert.equal(b.run.db.account(p.friend.pk)!.used, 0);
    }
    assert.deepEqual(view(p.a.run.db), view(p.b.run.db));
  });

  it('the bin sweep on one box erases on the other', async () => {
    p = await pair();
    const x = randomBytes(5000);
    await put(p.a, p.friend, x);
    await p.settle();
    await del(p.a, p.friend, sha(x));
    p.clock.now += 31 * DAY;
    assert.equal(p.a.run.sweep(), 1);
    await p.settle();
    assert.equal(p.b.run.db.blob(sha(x)), null);
    assert.equal(existsSync(file(p.b, sha(x))), false);
  });

  it('a peer that is down: errors on the admin page, then catches up', async () => {
    p = await pair();
    const x = randomBytes(8000);
    await p.down(1);
    await put(p.a, p.friend, x);
    await p.a.run.peers!.sync();
    const [s] = p.a.run.peers!.status();
    assert.match(s.error!, /could not reach it/);
    assert.match(statusLine(s), /^ambrel: not read yet \(could not reach it/);
    await p.up(1);
    await p.b.run.peers!.sync();
    assert.ok((await get(p.b, sha(x))).body.equals(x));
    await p.a.run.peers!.sync();
    const [s2] = p.a.run.peers!.status();
    assert.equal(s2.error, null);
    assert.equal(s2.blobs, 1);
    const [s3] = p.b.run.peers!.status();
    assert.deepEqual([s3.name, s3.blobs, s3.copied, s3.waiting, s3.behind], ['xumbrel', 1, 1, 0, 0]);
    assert.match(statusLine(s3), /^xumbrel: 1 of 1 copied, last \d\d:\d\d$/);
  });

  it('a file whose box went down before it was copied is fetched once the box is back', async () => {
    p = await pair();
    const x = randomBytes(8000);
    await put(p.a, p.friend, x);
    // b learns of x, but a goes down before the file comes over: b fetches from a and fails
    const c = p.a.run.db.changesSince(0, 10).changes[0];
    await p.down(0);
    assert.equal(p.b.run.db.applyPeer(c, p.keys[0].pk, 0), 'want');
    await p.b.run.peers!.sync();
    assert.equal(p.b.run.db.wantCount(), 1);
    assert.equal(p.b.run.peers!.status()[0].waiting, 1);
    await p.up(0);
    // no wait for the retry: the peer answering again makes what failed due now
    await p.b.run.peers!.sync();
    assert.equal(p.b.run.db.wantCount(), 0);
    assert.ok((await get(p.b, sha(x))).body.equals(x));
  });

  it('a delete and erase while the peer is offline: it goes from the peer when it is back, and does not come back', async () => {
    p = await pair();
    const x = randomBytes(7000);
    await put(p.a, p.friend, x);
    await p.settle();
    await p.down(1);
    p.clock.now += 60;
    assert.equal((await del(p.a, p.friend, sha(x))).status, 204);
    p.clock.now += 60;
    assert.ok(p.a.run.db.eraseNow(sha(x), p.clock.now));
    removeBlobFile(p.dirs[0], sha(x));
    await p.up(1);
    // a reads b first: b still has x, held from before the erase. That must not bring it back.
    await p.a.run.peers!.sync();
    assert.equal(p.a.run.db.blob(sha(x)), null);
    assert.equal(p.a.run.db.wantCount(), 0);
    await p.b.run.peers!.sync();
    assert.equal(p.b.run.db.blob(sha(x)), null);
    assert.equal(existsSync(file(p.b, sha(x))), false);
    await p.settle();
    assert.equal(p.a.run.db.blob(sha(x)), null);
    assert.deepEqual(view(p.a.run.db), view(p.b.run.db));
    // an upload after the erase is a new upload: it stays, on both
    p.clock.now += 60;
    assert.equal((await put(p.b, p.friend, x)).status, 201);
    await p.settle();
    assert.equal((await get(p.a, sha(x))).status, 200);
  });

  it('a file missing on a peer is never a delete', async () => {
    p = await pair();
    const x = randomBytes(5000);
    await put(p.a, p.friend, x);
    await p.settle();
    // the file vanishes from b's disk (a disk fault), with no let-go recorded
    rmSync(file(p.b, sha(x)));
    await p.settle();
    assert.equal((await get(p.a, sha(x))).status, 200);
    assert.equal(p.a.run.db.blob(sha(x))!.binned, null);
  });

  it('two boxes that both changed settle on the same state', async () => {
    p = await pair();
    const other = key();
    p.a.run.db.putAccount(other.pk, 10_000_000, p.clock.now);
    p.b.run.db.putAccount(other.pk, 10_000_000, p.clock.now);
    const x = randomBytes(5000), y = randomBytes(5000), z = randomBytes(5000);
    await put(p.a, p.friend, x);
    await put(p.a, p.friend, y);
    await put(p.a, p.friend, z);
    await p.settle();
    p.clock.now += 60;
    // apart: on a the friend lets go of x and y; on b another key takes x, and the friend takes y again later
    await del(p.a, p.friend, sha(x));
    await del(p.a, p.friend, sha(y));
    await put(p.b, other, x);
    p.clock.now += 1;
    await put(p.b, p.friend, y);
    // and the same second on both: a lets go of z, b's upload of z again is in the same second
    await del(p.a, p.friend, sha(z));
    await put(p.b, p.friend, z);
    await p.settle();
    assert.deepEqual(view(p.a.run.db), view(p.b.run.db));
    const db = p.a.run.db;
    assert.equal(db.uploadedAt(sha(x), other.pk) !== null, true); // other holds x
    assert.equal(db.uploadedAt(sha(x), p.friend.pk), null); // the friend let go of it
    assert.equal(db.uploadedAt(sha(y), p.friend.pk) !== null, true); // the later take wins
    assert.equal(db.blob(sha(z))!.binned !== null, true); // a tie: the let-go wins
  });

  it('three changes in a row reach a box that was away, in one read', async () => {
    p = await pair();
    await p.down(1);
    const xs = [randomBytes(4000), randomBytes(4000), randomBytes(4000)];
    for (const x of xs) await put(p.a, p.owner, x);
    await del(p.a, p.owner, sha(xs[1]));
    await p.up(1);
    await p.b.run.peers!.sync();
    assert.equal(p.b.run.db.blob(sha(xs[0]))!.binned, null);
    assert.equal(p.b.run.db.blob(sha(xs[1]))!.binned !== null, true);
    assert.equal(p.b.run.db.totals().blobs, 3);
  });

  it('copies a key that has no account on this box, and charges it once the account is added', async () => {
    p = await pair();
    const newcomer = key();
    p.a.run.db.putAccount(newcomer.pk, 10_000_000, p.clock.now);
    await put(p.a, newcomer, randomBytes(9000));
    await p.settle();
    assert.equal(p.b.run.db.totals().blobs, 1);
    p.b.run.db.putAccount(newcomer.pk, 10_000_000, p.clock.now);
    assert.equal(p.b.run.db.account(newcomer.pk)!.used, 9000);
  });

  it('shows on the admin page (manage peers) and the CLI', async () => {
    p = await pair();
    await put(p.a, p.owner, randomBytes(5000));
    await p.settle();
    const body = JSON.stringify({ method: 'peers', params: [] });
    const r = await fetch(`${p.b.url}/manage`, { method: 'POST', body, headers: { 'content-type': CT, authorization: sign(p.owner, body, 'https://storage.test/manage', p.clock.now) } });
    const j: any = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.result.peers.length, 1);
    const s = j.result.peers[0];
    assert.deepEqual([s.name, s.pubkey, s.blobs, s.copied, s.waiting, s.behind, s.error], ['xumbrel', p.keys[0].pk, 1, 1, 0, 0, null]);
    assert.match(cli(p.dirs[1], 'peers'), /^xumbrel: 1 of 1 copied, last \d\d:\d\d\n$/);
  });
});

// --- the /peer endpoint itself

function sign(k: { sk: Uint8Array; pk: string }, body: string, u: string, now: number): string {
  const tags = [['u', u], ['method', 'POST'], ['payload', createHash('sha256').update(body).digest('hex')]];
  const e: any = { pubkey: k.pk, created_at: now, kind: 27235, tags, content: '' };
  e.id = createHash('sha256').update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest('hex');
  e.sig = Buffer.from(schnorr.sign(Buffer.from(e.id, 'hex'), k.sk)).toString('hex');
  return 'Nostr ' + Buffer.from(JSON.stringify(e)).toString('base64');
}

describe('POST /peer', () => {
  const peer = key();
  let b: Box;
  after(() => b?.close());

  const ask = (k: Key, params: unknown[] = [0, 500], u = `${b.url}/peer`, now = b.clock.now) => {
    const body = JSON.stringify({ method: 'changes', params });
    return fetch(`${b.url}/peer`, { method: 'POST', body, headers: { 'content-type': CT, authorization: sign(k, body, u, now) } });
  };

  it('answers 404 on a box with no peers', async () => {
    const lone = await box();
    try {
      const body = JSON.stringify({ method: 'changes', params: [0] });
      const r = await fetch(`${lone.url}/peer`, { method: 'POST', body, headers: { 'content-type': CT, authorization: sign(peer, body, `${lone.url}/peer`, lone.clock.now) } });
      assert.equal(r.status, 404);
    } finally {
      await lone.close();
    }
  });

  it('answers a peer, with any address in u as long as it names /peer, and pages', async () => {
    b = await box({ peers: [{ name: 'p', url: 'http://127.0.0.1:1', pubkey: peer.pk }] }, { start: { noPeerStart: true } });
    for (let i = 0; i < 3; i++) await put(b, b.owner, randomBytes(100 + i));
    let r = await ask(peer, [0, 2], 'http://100.101.102.103:7480/peer');
    assert.equal(r.status, 200);
    let j = ((await r.json()) as any).result;
    assert.equal(j.changes.length, 2);
    assert.equal(j.more, true);
    assert.equal(j.blobs, 3);
    assert.deepEqual(Object.keys(j.changes[0]).sort(), ['created', 'erased', 'holds', 'seq', 'sha256', 'size', 'type']);
    assert.deepEqual(Object.keys(j.changes[0].holds[0]).sort(), ['at', 'held', 'key', 'uploaded']);
    r = await ask(peer, [j.next, 500]);
    j = ((await r.json()) as any).result;
    assert.equal(j.changes.length, 1);
    assert.equal(j.more, false);
    assert.equal(j.next, j.head);
  });

  it('refuses others: a key that is not a peer, another path in u, an old signature, a GET', async () => {
    let r = await ask(key());
    assert.equal(r.status, 401);
    assert.equal(((await r.json()) as any).error, 'this key is not a peer of this box');
    r = await ask(b.owner); // the box owner is not a peer either
    assert.equal(r.status, 401);
    r = await ask(peer, [0, 500], `${b.url}/manage`);
    assert.equal(r.status, 401);
    r = await ask(peer, [0, 500], `${b.url}/peer`, b.clock.now - 120);
    assert.equal(r.status, 401);
    r = await fetch(`${b.url}/peer`);
    assert.equal(r.status, 405);
    r = await ask(peer, [-1]);
    assert.ok(((await r.json()) as any).error);
  });
});

// --- a fake peer, for answers and bytes that are wrong

async function fakePeer(routes: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void) {
  const s = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => routes(req, res, Buffer.concat(parts).toString('utf8')));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(s.address() as { port: number }).port}`,
    close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }),
  };
}

describe('a peer that sends something wrong', () => {
  const pk = key();
  let b: Box | null = null;
  let f: Awaited<ReturnType<typeof fakePeer>> | null = null;
  afterEach(async () => {
    await b?.close();
    await f?.close();
    b = f = null;
  });

  const change = (x: Buffer, now: number, over: object = {}) => ({
    seq: 1, sha256: sha(x), size: x.length, type: 'image/jpeg', created: now, erased: null,
    holds: [{ key: key().pk, held: true, at: now, uploaded: now }], ...over,
  });

  it('bytes that are not what the hash says are not kept, and are tried again later', async () => {
    const x = randomBytes(3000);
    const now = Math.floor(Date.now() / 1000);
    let good = false;
    f = await fakePeer((req, res) => {
      if (req.url === '/peer') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: { changes: [change(x, now)], next: 1, head: 1, more: false, blobs: 1 } }));
      if (req.url === `/${sha(x)}`) return res.writeHead(200).end(good ? x : randomBytes(3000));
      res.writeHead(404).end();
    });
    b = await box({ peers: [{ name: 'f', url: f.url, pubkey: pk.pk }], peerIdleMs: 2000 }, { start: { noPeerStart: true } });
    await b.run.peers!.sync();
    assert.equal(b.run.db.blob(sha(x)), null);
    assert.equal(b.run.db.wantCount(), 1);
    assert.match(b.run.db.wants(Infinity, 1)[0].error!, /other bytes/);
    good = true;
    b.clock.now += 61;
    await b.run.peers!.sync();
    assert.equal(b.run.db.wantCount(), 0);
    assert.equal((await get(b, sha(x))).status, 200);
  });

  it('a malformed page is not taken in at all, and the place is kept', async () => {
    const x = randomBytes(10);
    const now = Math.floor(Date.now() / 1000);
    f = await fakePeer((req, res) => res.writeHead(200).end(JSON.stringify({
      result: { changes: [change(x, now), { ...change(x, now), sha256: 'nope' }], next: 2, head: 2, more: false, blobs: 2 },
    })));
    b = await box({ peers: [{ name: 'f', url: f.url, pubkey: pk.pk }] }, { start: { noPeerStart: true } });
    await b.run.peers!.sync();
    assert.equal(b.run.db.wantCount(), 0);
    assert.deepEqual(b.run.db.holdsOn(sha(x)), []);
    assert.equal(b.run.db.peerRows()[0].cursor, 0);
    assert.match(b.run.peers!.status()[0].error!, /malformed/);
  });

  it('a peer that does not know this box says so', async () => {
    f = await fakePeer((req, res) => res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'this key is not a peer of this box' })));
    b = await box({ peers: [{ name: 'f', url: f.url, pubkey: pk.pk }] }, { start: { noPeerStart: true } });
    await b.run.peers!.sync();
    assert.match(b.run.peers!.status()[0].error!, /add this box to its STORAGE_PEERS/);
  });

  it('a binned blob whose time is up on the peer is not copied', async () => {
    const x = randomBytes(10);
    const now = Math.floor(Date.now() / 1000);
    f = await fakePeer((req, res) => res.writeHead(200).end(JSON.stringify({
      result: { changes: [change(x, now, { holds: [{ key: key().pk, held: false, at: now - 40 * DAY, uploaded: now - 50 * DAY }] })], next: 1, head: 1, more: false, blobs: 1 },
    })));
    b = await box({ peers: [{ name: 'f', url: f.url, pubkey: pk.pk }] }, { start: { noPeerStart: true } });
    await b.run.peers!.sync();
    assert.equal(b.run.db.wantCount(), 0);
  });
});

describe('STORAGE_PEERS', () => {
  it('reads names, tailnet and https urls, npubs and hex keys', () => {
    const k1 = key().pk, k2 = key().pk;
    assert.deepEqual(parsePeers(`xumbrel http://100.101.102.103:7480/ ${npub(k1)}, https://storage2.example.com ${k2}`), [
      { name: 'xumbrel', url: 'http://100.101.102.103:7480', pubkey: k1 },
      { name: 'storage2.example.com', url: 'https://storage2.example.com', pubkey: k2 },
    ]);
    assert.deepEqual(parsePeers(''), []);
    assert.equal(configFromEnv({ STORAGE_PEERS: `a http://10.0.0.2:7480 ${k1}` }).peers![0].url, 'http://10.0.0.2:7480');
  });

  it('refuses what is not a peer', () => {
    const k = key().pk;
    for (const bad of [`ftp://x ${k}`, `http://u:p@x ${k}`, `http://x?q=1 ${k}`, 'http://x npub1nope', `http://x`, `a b http://x ${k}`, `http://x ${k}, http://y ${k}`]) {
      assert.throws(() => parsePeers(bad), /STORAGE_PEERS/, bad);
    }
  });

  it('leaves the /mirror address rules as they were: tailnet and private addresses stay blocked there', () => {
    for (const ip of ['100.64.0.1', '100.101.102.103', '10.0.0.2', '127.0.0.1', '192.168.1.5']) assert.equal(isBlockedAddress(ip), true, ip);
  });

  it('a box listed as its own peer is left out', async () => {
    const dir = tempDir();
    const self = serviceKey(dir);
    const lines: string[] = [];
    const b = await box({ peers: [{ name: 'me', url: 'http://127.0.0.1:1', pubkey: self.pk }], log: (l) => lines.push(l) }, { dir, start: { noPeerStart: true } });
    try {
      assert.equal(b.run.peers, null);
      assert.ok(lines.some((l) => /this box itself/.test(l)));
    } finally {
      await b.close();
    }
  });
});

describe('a 0.6.0 database', () => {
  it('gets holds and changes for what it already stores, so a new peer copies all of it, the bin included', () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'storage.db');
      let db = new Db(path);
      const owner = key();
      db.putAccount(owner.pk, null, 1);
      db.own(sha('a'), 100, 'image/jpeg', owner.pk, 5);
      db.own(sha('b'), 200, 'video/mp4', owner.pk, 6);
      db.disown(sha('b'), owner.pk, 7);
      db.sql.exec('DROP TABLE holds; DROP TABLE erased; DROP TABLE changes; DROP TABLE peers; DROP TABLE peer_wants; PRAGMA user_version = 8;');
      db.close();
      db = new Db(path);
      const { changes, head } = db.changesSince(0, 10);
      assert.equal(head, 2);
      assert.deepEqual(changes.map((c) => [c.sha256, c.size, c.type, c.holds.map((h) => [h.key, h.held, h.at])]), [
        [sha('a'), 100, 'image/jpeg', [[owner.pk, true, 5]]],
        [sha('b'), 200, 'video/mp4', [[owner.pk, false, 7]]],
      ]);
      assert.equal(Number(db.sql.prepare('PRAGMA user_version').get()!.user_version), 9);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('statusLine', () => {
  it('reads like the admin page', () => {
    const t = Math.floor(new Date(2026, 10, 26, 11, 40).getTime() / 1000);
    const s = { name: 'xumbrel', url: '', pubkey: '', blobs: 1204, copied: 1204, waiting: 0, behind: 0, lastOk: t, lastTry: t, error: null };
    assert.equal(statusLine(s), 'xumbrel: 1,204 of 1,204 copied, last 11:40');
    assert.equal(statusLine({ ...s, copied: 1200, waiting: 4, behind: 12 }), 'xumbrel: 1,200 of 1,204 copied, last 11:40, 12 changes still to read');
    assert.deepEqual(statusOf(new Db(':memory:')), []);
  });
});
