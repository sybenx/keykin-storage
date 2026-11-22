// Uploads in pieces (POST /uploads and the rest), written from the contract in the README as a phone would use it.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, rmSync, truncateSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Config } from '../src/config.ts';
import { serviceKey } from '../src/servicekey.ts';
import { auth, box, fakeHome, key, put, sha, tempDir, type Box, type Key } from './helpers.ts';

const HOUR = 3600;
const PIECE = 1000;

const tok = (b: Box, k: Key, x: string, createdAt?: number) =>
  auth(k, { t: 'upload', x: [x], now: b.clock.now, ...(createdAt !== undefined ? { createdAt } : {}) });

/** The phone's side of the contract. `x` is the sha256 of the whole file; any valid token naming it works. */
const client = (b: Box, k: Key) => ({
  start: (x: string, size: number, type: string | null = 'video/mp4') => fetch(`${b.url}/uploads`, {
    method: 'POST', body: JSON.stringify({ sha256: x, size, type }),
    headers: { authorization: tok(b, k, x), 'content-type': 'application/json' },
  }),
  piece: (id: string, x: string, i: number, bytes: Uint8Array, headers: Record<string, string> = {}) =>
    fetch(`${b.url}/uploads/${id}/${i}`, { method: 'PUT', body: bytes, headers: { authorization: tok(b, k, x), ...headers } }),
  status: (id: string, x: string) => fetch(`${b.url}/uploads/${id}`, { headers: { authorization: tok(b, k, x) } }),
  complete: (id: string, x: string) => fetch(`${b.url}/uploads/${id}/complete`, { method: 'POST', headers: { authorization: tok(b, k, x) } }),
  cancel: (id: string, x: string) => fetch(`${b.url}/uploads/${id}`, { method: 'DELETE', headers: { authorization: tok(b, k, x) } }),
});

/** A file cut into pieces of `size` bytes, the last one the remainder. */
const cut = (file: Buffer, size = PIECE) => {
  const out: Buffer[] = [];
  for (let i = 0; i < file.length; i += size) out.push(file.subarray(i, i + size));
  return out;
};

/** Starts an upload and checks it opened. */
async function open(b: Box, k: Key, file: Buffer, type: string | null = 'video/mp4') {
  const r = await client(b, k).start(sha(file), file.length, type);
  assert.equal(r.status, 201, `${r.status} ${r.headers.get('x-reason')}`);
  return await r.json() as { id: string; sha256: string; size: number; pieceSize: number; pieces: number; received: number[]; expiresAt: number };
}

/** Sends every piece in `order` (default all, in order) and checks each. */
async function send(b: Box, k: Key, id: string, file: Buffer, order?: number[], size = PIECE) {
  const pieces = cut(file, size);
  for (const i of order ?? pieces.map((_, n) => n)) {
    const r = await client(b, k).piece(id, sha(file), i, pieces[i]);
    assert.equal(r.status, 200, `piece ${i}: ${r.status} ${r.headers.get('x-reason')}`);
  }
}

/** A piece whose body starts and then stalls, as on a phone whose connection dropped. `drop()` cuts it. */
function stalled(b: Box, k: Key, id: string, x: string, i: number, length: number) {
  const req = http.request(`${b.url}/uploads/${id}/${i}`, { method: 'PUT', headers: { authorization: tok(b, k, x), 'content-length': String(length) } });
  const status = new Promise<number | 'cut'>((resolve) => {
    req.on('response', (res) => { res.resume(); resolve(res.statusCode!); });
    req.on('error', () => resolve('cut'));
  });
  req.write(randomBytes(Math.min(10, length - 1)));
  return { status, drop: () => req.destroy() };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reason = (r: Response) => r.headers.get('x-reason');

describe('uploads in pieces: the happy paths', () => {
  let b: Box;
  before(async () => { b = await box({ pieceBytes: PIECE, authBurst: 1000 }); }); // many signed calls from one address
  after(() => b.close());

  it('takes a file in order, stores it like an upload, and the id is gone after', async () => {
    const file = randomBytes(5 * PIECE + 500);
    const s = await open(b, b.owner, file);
    assert.match(s.id, /^[0-9a-f]{32}$/);
    assert.deepEqual({ ...s, id: '', expiresAt: 0 }, { id: '', sha256: sha(file), size: file.length, pieceSize: PIECE, pieces: 6, received: [], expiresAt: 0 });
    assert.equal(s.expiresAt, b.clock.now + 24 * HOUR);
    await send(b, b.owner, s.id, file);
    const c = await client(b, b.owner).complete(s.id, sha(file));
    assert.equal(c.status, 201);
    const d = await c.json() as any;
    assert.equal(d.sha256, sha(file));
    assert.equal(d.size, file.length);
    assert.equal(d.type, 'video/mp4');
    assert.equal(d.url, `https://storage.test/${sha(file)}.mp4`);
    const g = await fetch(`${b.url}/${sha(file)}`);
    assert.equal(g.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(Buffer.from(await g.arrayBuffer()), file);
    assert.equal((await client(b, b.owner).status(s.id, sha(file))).status, 404);
    assert.deepEqual(readdirSync(join(b.dir, 'pieces')), []);
  });

  it('takes pieces out of order and a piece sent twice, and answers what it has after each', async () => {
    const file = randomBytes(4 * PIECE + 1);
    const s = await open(b, b.owner, file, null);
    const p = cut(file);
    const got = async (i: number, bytes = p[i]) => {
      const r = await client(b, b.owner).piece(s.id, sha(file), i, bytes);
      assert.equal(r.status, 200);
      return (await r.json() as any).received;
    };
    assert.deepEqual(await got(4), [4]);
    assert.deepEqual(await got(2), [2, 4]);
    assert.deepEqual(await got(2, randomBytes(PIECE)), [2, 4]); // wrong bytes, then the right ones again: replaced
    assert.deepEqual(await got(2), [2, 4]);
    assert.deepEqual(await got(0), [0, 2, 4]);
    assert.deepEqual(await got(3), [0, 2, 3, 4]);
    assert.deepEqual(await got(1), [0, 1, 2, 3, 4]);
    const c = await client(b, b.owner).complete(s.id, sha(file));
    assert.equal(c.status, 201);
    assert.equal((await c.json() as any).type, 'application/octet-stream');
    assert.deepEqual(Buffer.from(await (await fetch(`${b.url}/${sha(file)}`)).arrayBuffer()), file);
  });

  it('a file of one short piece works too', async () => {
    const file = randomBytes(10);
    const s = await open(b, b.owner, file);
    assert.equal(s.pieces, 1);
    await send(b, b.owner, s.id, file);
    assert.equal((await client(b, b.owner).complete(s.id, sha(file))).status, 201);
  });

  it('a second start of the same file returns the open upload, with what it has', async () => {
    const file = randomBytes(3 * PIECE);
    const s = await open(b, b.owner, file);
    await send(b, b.owner, s.id, file, [1]);
    const again = await client(b, b.owner).start(sha(file), file.length);
    assert.equal(again.status, 200);
    const a = await again.json() as any;
    assert.equal(a.id, s.id);
    assert.deepEqual(a.received, [1]);
    const other = await client(b, b.owner).start(sha(file), file.length + 1);
    assert.equal(other.status, 409);
    assert.match(reason(other)!, new RegExp(s.id));
    assert.equal((await client(b, b.owner).cancel(s.id, sha(file))).status, 204);
  });

  it('a file this account already holds: 200 with its descriptor, nothing to send', async () => {
    const file = randomBytes(2500);
    assert.equal((await put(b, b.owner, file)).status, 201);
    const r = await client(b, b.owner).start(sha(file), file.length);
    assert.equal(r.status, 200);
    const d = await r.json() as any;
    assert.equal(d.sha256, sha(file));
    assert.equal(d.url, `https://storage.test/${sha(file)}.bin`);
    assert.equal(d.id, undefined);
  });

  it('an upload left open of a file that came another way meanwhile is let go, with what it held', async () => {
    const friend = key();
    b.run.db.putAccount(friend.pk, 10_000, b.clock.now);
    const file = randomBytes(5000);
    const s = await open(b, friend, file);
    assert.equal((await put(b, friend, file)).status, 201);
    assert.equal((await client(b, friend).start(sha(file), file.length)).status, 200);
    assert.equal((await client(b, friend).status(s.id, sha(file))).status, 404);
    assert.equal((await put(b, friend, randomBytes(4500))).status, 201); // 5000 + 4500: the open upload holds nothing now
  });

  it('a file someone else holds still has to be sent (anyone can know a hash)', async () => {
    const friend = key();
    b.run.db.putAccount(friend.pk, 10 ** 9, b.clock.now);
    const file = randomBytes(1500);
    assert.equal((await put(b, b.owner, file)).status, 201);
    const s = await open(b, friend, file);
    await send(b, friend, s.id, file);
    const c = await client(b, friend).complete(s.id, sha(file));
    assert.equal(c.status, 200); // the blob was here already: like a normal upload of it
    assert.equal(b.run.db.holds(friend.pk, sha(file)), true);
  });

  it('takes a fresh token for the same file mid-way, and refuses one for another file', async () => {
    const file = randomBytes(2 * PIECE);
    const s = await open(b, b.owner, file);
    const p = cut(file);
    const later = auth(b.owner, { t: 'upload', x: [sha(file)], now: b.clock.now, createdAt: b.clock.now - 10 });
    const r = await fetch(`${b.url}/uploads/${s.id}/0`, { method: 'PUT', body: p[0], headers: { authorization: later } });
    assert.equal(r.status, 200);
    const wrong = await fetch(`${b.url}/uploads/${s.id}/1`, { method: 'PUT', body: p[1], headers: { authorization: tok(b, b.owner, sha('another file')) } });
    assert.equal(wrong.status, 401);
    const many = auth(b.owner, { t: 'upload', x: [sha('another file'), sha(file)], now: b.clock.now });
    assert.equal((await fetch(`${b.url}/uploads/${s.id}/1`, { method: 'PUT', body: p[1], headers: { authorization: many } })).status, 200);
    assert.equal((await client(b, b.owner).complete(s.id, sha(file))).status, 201);
  });

  it('checks a piece against x-piece-sha-256 when sent', async () => {
    const file = randomBytes(2 * PIECE);
    const s = await open(b, b.owner, file);
    const p = cut(file);
    const bad = await client(b, b.owner).piece(s.id, sha(file), 0, p[0], { 'x-piece-sha-256': sha(p[1]) });
    assert.equal(bad.status, 400);
    assert.equal(reason(bad), 'piece does not match x-piece-sha-256');
    assert.deepEqual((await (await client(b, b.owner).status(s.id, sha(file))).json() as any).received, []);
    assert.equal((await client(b, b.owner).piece(s.id, sha(file), 0, p[0], { 'x-piece-sha-256': sha(p[0]) })).status, 200);
    assert.equal((await client(b, b.owner).cancel(s.id, sha(file))).status, 204);
  });

  it('answers CORS preflight on its paths', async () => {
    for (const path of ['/uploads', '/uploads/abc/0', '/uploads/abc/complete']) {
      const r = await fetch(`${b.url}${path}`, { method: 'OPTIONS' });
      assert.equal(r.status, 204);
      assert.equal(r.headers.get('access-control-allow-origin'), '*');
      assert.match(r.headers.get('access-control-allow-methods')!, /POST/);
    }
  });
});

describe('uploads in pieces: what goes wrong', () => {
  let b: Box;
  before(async () => { b = await box({ pieceBytes: PIECE, authBurst: 1000 }); }); // many signed calls from one address
  after(() => b.close());

  it('refuses a piece of the wrong size, a piece number out of range, and a body that is not the contract', async () => {
    const file = randomBytes(2 * PIECE + 300);
    const s = await open(b, b.owner, file);
    const c = client(b, b.owner);
    const short = await c.piece(s.id, sha(file), 0, randomBytes(PIECE - 1));
    assert.equal(short.status, 400);
    assert.equal(reason(short), `piece 0 must be ${PIECE} bytes`);
    assert.equal((await c.piece(s.id, sha(file), 2, randomBytes(PIECE))).status, 400); // the last is the remainder
    assert.equal(reason(await c.piece(s.id, sha(file), 3, randomBytes(300))), 'this upload has pieces 0 to 2');
    assert.equal((await c.piece(s.id, sha(file), 'x' as any, randomBytes(300))).status, 400);
    assert.deepEqual((await (await c.status(s.id, sha(file))).json() as any).received, []);

    const post = (body: string, x = sha(file)) => fetch(`${b.url}/uploads`, { method: 'POST', body, headers: { authorization: tok(b, b.owner, x) } });
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post(JSON.stringify({ sha256: 'abc', size: 10 }))).status, 400);
    assert.equal((await post(JSON.stringify({ sha256: sha(file), size: 0 }))).status, 400);
    assert.equal((await post(JSON.stringify({ sha256: sha(file), size: 1.5 }))).status, 400);
    assert.equal((await post(JSON.stringify({ sha256: sha(file), size: 10, type: 5 }))).status, 400);
    assert.equal((await post(JSON.stringify({ sha256: sha(file), size: 10 }), sha('other'))).status, 403);
    const big = await post(JSON.stringify({ sha256: sha('big'), size: 1024 * 1024 + 1 }), sha('big'));
    assert.equal(big.status, 413);
    assert.equal(reason(big), `files here are at most ${1024 * 1024} bytes`);
    await c.cancel(s.id, sha(file));
  });

  it('says which pieces are missing at complete, then completes once they are sent', async () => {
    const file = randomBytes(3 * PIECE);
    const s = await open(b, b.owner, file);
    await send(b, b.owner, s.id, file, [0, 2]);
    const early = await client(b, b.owner).complete(s.id, sha(file));
    assert.equal(early.status, 400);
    assert.equal(reason(early), '1 of 3 pieces are missing; ask for the status and send them');
    await send(b, b.owner, s.id, file, [1]);
    assert.equal((await client(b, b.owner).complete(s.id, sha(file))).status, 201);
  });

  it('resumes after a drop: the cut piece is not counted, the status says what to send', async () => {
    const file = randomBytes(4 * PIECE);
    const s = await open(b, b.owner, file);
    await send(b, b.owner, s.id, file, [0, 1]);
    const cutOff = stalled(b, b.owner, s.id, sha(file), 2, PIECE);
    await wait(200);
    cutOff.drop();
    assert.equal(await cutOff.status, 'cut');
    await wait(100);
    // the phone comes back: asks, then sends only what is missing
    const st = await (await client(b, b.owner).status(s.id, sha(file))).json() as any;
    assert.deepEqual(st.received, [0, 1]);
    const missing = [...Array(st.pieces).keys()].filter((i) => !st.received.includes(i));
    assert.deepEqual(missing, [2, 3]);
    await send(b, b.owner, s.id, file, missing);
    assert.equal((await client(b, b.owner).complete(s.id, sha(file))).status, 201);
    assert.deepEqual(Buffer.from(await (await fetch(`${b.url}/${sha(file)}`)).arrayBuffer()), file);
  });

  it('a piece sent again while the first copy is still arriving replaces it', async () => {
    const file = randomBytes(2 * PIECE);
    const s = await open(b, b.owner, file);
    const first = stalled(b, b.owner, s.id, sha(file), 0, PIECE);
    await wait(200);
    await send(b, b.owner, s.id, file, [0, 1]);
    assert.equal(await first.status, 400); // stopped for the new copy
    first.drop();
    assert.equal((await client(b, b.owner).complete(s.id, sha(file))).status, 201);
  });

  it('discards the whole upload when the pieces do not make the promised hash, and gives the quota back', async () => {
    const friend = key();
    b.run.db.putAccount(friend.pk, 10_000, b.clock.now);
    const promised = randomBytes(6000), sent = randomBytes(6000);
    const s = await open(b, friend, promised);
    for (const [i, p] of cut(sent).entries()) assert.equal((await client(b, friend).piece(s.id, sha(promised), i, p)).status, 200);
    const c = await client(b, friend).complete(s.id, sha(promised));
    assert.equal(c.status, 409);
    assert.equal(reason(c), 'the pieces do not make the promised sha256; the upload is discarded, start over');
    assert.equal((await client(b, friend).status(s.id, sha(promised))).status, 404);
    assert.equal((await fetch(`${b.url}/${sha(promised)}`)).status, 404);
    assert.equal((await fetch(`${b.url}/${sha(sent)}`)).status, 404);
    assert.equal((await put(b, friend, randomBytes(9000))).status, 201); // the 6000 held back are free again
    assert.deepEqual(readdirSync(join(b.dir, 'pieces')), []);
  });

  it('gives the same 404 for an unknown id, someone else\'s, an expired one and a malformed one', async () => {
    const friend = key(), stranger = key();
    b.run.db.putAccount(friend.pk, 10 ** 9, b.clock.now);
    const file = randomBytes(2 * PIECE);
    const s = await open(b, b.owner, file);
    const x = sha(file);
    const answers = async (k: Key, id: string) => {
      const c = client(b, k);
      const rs = [await c.status(id, x), await c.piece(id, x, 0, cut(file)[0]), await c.complete(id, x), await c.cancel(id, x)];
      return Promise.all(rs.map(async (r) => `${r.status} ${reason(r)} ${await r.text()}`));
    };
    const notFound = Array(4).fill('404 no such upload no such upload\n');
    assert.deepEqual(await answers(friend, s.id), notFound);
    assert.deepEqual(await answers(b.owner, randomBytes(16).toString('hex')), notFound);
    assert.deepEqual(await answers(b.owner, 'not-an-id'), notFound);
    // a key with no account here is refused before anything about the id, the same for every id
    const st = await answers(stranger, s.id);
    assert.deepEqual(st, await answers(stranger, randomBytes(16).toString('hex')));
    assert.match(st[0], /^403 this key may not write here/);
    // still the owner's, untouched
    assert.deepEqual((await (await client(b, b.owner).status(s.id, x)).json() as any).received, []);
    b.clock.now += 24 * HOUR + 1;
    assert.deepEqual(await answers(b.owner, s.id), notFound);
  });
});

describe('uploads in pieces: holding back quota and disk', () => {
  let b: Box;
  before(async () => { b = await box({ pieceBytes: PIECE, authBurst: 1000 }); }); // many signed calls from one address
  after(() => b.close());

  it('holds the whole size back from the quota at start, and gives it back on cancel', async () => {
    const friend = key();
    b.run.db.putAccount(friend.pk, 10_000, b.clock.now);
    const file = randomBytes(7000);
    const s = await open(b, friend, file);
    assert.equal((await put(b, friend, randomBytes(4000))).status, 413);
    assert.equal((await client(b, friend).start(sha('other'), 4000)).status, 413);
    assert.equal((await client(b, friend).cancel(s.id, sha(file))).status, 204);
    assert.equal((await client(b, friend).status(s.id, sha(file))).status, 404);
    assert.equal((await put(b, friend, randomBytes(4000))).status, 201);
  });

  it('charges the account at complete, once', async () => {
    const friend = key();
    b.run.db.putAccount(friend.pk, 12_000, b.clock.now);
    const file = randomBytes(7000);
    const s = await open(b, friend, file);
    await send(b, friend, s.id, file);
    assert.equal((await client(b, friend).complete(s.id, sha(file))).status, 201);
    assert.equal((await put(b, friend, randomBytes(4096))).status, 201); // 7000 + 4096 of 12,000
    assert.equal((await put(b, friend, randomBytes(1000))).status, 413); // each blob costs at least 4096
  });

  it('holds the whole size back from the disk margin', async () => {
    const tight = await box({ pieceBytes: PIECE, diskMarginBytes: 10 ** 15 });
    try {
      const r = await client(tight, tight.owner).start(sha('x'), 5000);
      assert.equal(r.status, 507);
    } finally {
      await tight.close();
    }
  });

  it('gives the reservation back when the upload expires, and the sweep takes the file', async () => {
    const friend = key();
    b.run.db.putAccount(friend.pk, 10_000, b.clock.now);
    const file = randomBytes(3 * PIECE);
    const s = await open(b, friend, file);
    b.clock.now += 23 * HOUR;
    await send(b, friend, s.id, file, [0]); // a new piece: a new day
    b.clock.now += 23 * HOUR;
    assert.equal(b.run.sweepUploads(), 0);
    assert.equal((await client(b, friend).status(s.id, sha(file))).status, 200);
    assert.equal((await put(b, friend, randomBytes(8000))).status, 413);
    b.clock.now += HOUR + 1;
    assert.equal((await put(b, friend, randomBytes(8000))).status, 201); // held back no longer, even before the sweep
    assert.equal(b.run.sweepUploads(), 1);
    assert.equal((await client(b, friend).status(s.id, sha(file))).status, 404);
    assert.deepEqual(readdirSync(join(b.dir, 'pieces')), []);
  });
});

describe('uploads in pieces: limits', () => {
  it('at most 2 open per account and the cap on the box', async () => {
    const b = await box({ pieceBytes: PIECE, maxOpenUploads: 3 });
    try {
      const friend = key();
      b.run.db.putAccount(friend.pk, 10 ** 9, b.clock.now);
      await open(b, b.owner, randomBytes(100));
      const second = randomBytes(100);
      const s2 = await open(b, b.owner, second);
      const third = await client(b, b.owner).start(sha('third'), 100);
      assert.equal(third.status, 429);
      assert.equal(reason(third), 'you have 2 uploads open here, the most at once; finish or cancel one first');
      await open(b, friend, randomBytes(100));
      const full = await client(b, friend).start(sha('fourth'), 100);
      assert.equal(full.status, 429);
      assert.equal(reason(full), 'this box has too many uploads open; try again later');
      await client(b, b.owner).cancel(s2.id, sha(second));
      await open(b, friend, randomBytes(100));
    } finally {
      await b.close();
    }
  });

  it('pieces count toward the uploads one account may have in flight', async () => {
    const b = await box({ pieceBytes: PIECE });
    try {
      const file = randomBytes(6 * PIECE);
      const s = await open(b, b.owner, file);
      const hanging = [0, 1, 2, 3].map((i) => stalled(b, b.owner, s.id, sha(file), i, PIECE));
      await wait(500);
      const fifth = await client(b, b.owner).piece(s.id, sha(file), 4, cut(file)[4]);
      assert.equal(fifth.status, 429);
      assert.equal((await put(b, b.owner, randomBytes(10))).status, 429); // and the single-request upload shares them
      for (const h of hanging) h.drop();
      await Promise.all(hanging.map((h) => h.status));
      await wait(100);
      await send(b, b.owner, s.id, file);
      assert.equal((await client(b, b.owner).complete(s.id, sha(file))).status, 201);
    } finally {
      await b.close();
    }
  });

  it('every call is a signed request for the per-address limit', async () => {
    const b = await box({ pieceBytes: PIECE, authBurst: 3, authPerSecond: 0.001 });
    try {
      const file = randomBytes(PIECE);
      const s = await open(b, b.owner, file);
      assert.equal((await client(b, b.owner).status(s.id, sha(file))).status, 200);
      assert.equal((await client(b, b.owner).piece(s.id, sha(file), 0, file)).status, 200);
      assert.equal((await client(b, b.owner).complete(s.id, sha(file))).status, 429);
    } finally {
      await b.close();
    }
  });

  it('keeps one request small when the blob cap is big: big files come in pieces', async () => {
    const b = await box({ pieceBytes: PIECE, maxBlobBytes: 100_000, maxRequestBytes: 5000 });
    try {
      const file = randomBytes(20_000);
      const r = await put(b, b.owner, file);
      assert.equal(r.status, 413);
      assert.equal(reason(r), 'one request here carries at most 5000 bytes; send bigger files in pieces (POST /uploads)');
      const s = await open(b, b.owner, file);
      await send(b, b.owner, s.id, file);
      assert.equal((await client(b, b.owner).complete(s.id, sha(file))).status, 201);
    } finally {
      await b.close();
    }
  });
});

describe('uploads in pieces: a big completion', () => {
  const MiB = 1024 * 1024;
  let b: Box;
  before(async () => { b = await box({ pieceBytes: MiB, maxBlobBytes: 128 * MiB, authBurst: 1000, authPerSecond: 1000 }); });
  after(() => b.close());

  it('hashes the whole file without holding up other requests', async () => {
    const small = randomBytes(100);
    assert.equal((await put(b, b.owner, small)).status, 201);
    const file = randomBytes(96 * MiB);
    const s = await open(b, b.owner, file);
    assert.equal(s.pieces, 96);
    const pieces = cut(file, MiB);
    for (let i = 0; i < pieces.length; i += 4) {
      await Promise.all([i, i + 1, i + 2, i + 3].map(async (n) => {
        const r = await client(b, b.owner).piece(s.id, sha(file), n, pieces[n]);
        assert.equal(r.status, 200);
      }));
    }
    let done = false;
    const c = client(b, b.owner).complete(s.id, sha(file)).finally(() => { done = true; });
    let answered = 0;
    while (!done) {
      const g = await fetch(`${b.url}/${sha(small)}`);
      assert.equal(g.status, 200);
      await g.arrayBuffer();
      if (!done) answered++;
    }
    assert.equal((await c).status, 201);
    assert.ok(answered >= 3, `only ${answered} small GETs were answered while the completion ran`);
    const h = await fetch(`${b.url}/${sha(file)}`, { method: 'HEAD' });
    assert.equal(h.headers.get('content-length'), String(file.length));
  });

  it('a second complete while the first runs gets the same answer', async () => {
    const file = randomBytes(32 * MiB);
    const s = await open(b, b.owner, file);
    await send(b, b.owner, s.id, file, undefined, MiB);
    const [one, two] = await Promise.all([client(b, b.owner).complete(s.id, sha(file)), client(b, b.owner).complete(s.id, sha(file))]);
    assert.equal(one.status, 201);
    assert.equal(two.status, 201);
    assert.deepEqual(await one.json(), await two.json());
    // and the phone that lost both answers asks again: done, nothing to send
    const again = await client(b, b.owner).start(sha(file), file.length);
    assert.equal(again.status, 200);
    assert.equal((await again.json() as any).sha256, sha(file));
  });
});

describe('uploads in pieces: a restart in the middle', () => {
  it('keeps the upload and the pieces received, and finishes after', async () => {
    const dir = tempDir();
    const owner = key();
    const over: Partial<Config> = { pieceBytes: PIECE };
    let b = await box(over, { dir, owner });
    try {
      const file = randomBytes(4 * PIECE + 7), lost = randomBytes(2 * PIECE);
      const s = await open(b, owner, file);
      await send(b, owner, s.id, file, [0, 3]);
      const l = await open(b, owner, lost);
      await b.run.close();
      truncateSync(join(dir, 'pieces', l.id), 5); // a file that is not the right length can't be finished
      b = await box(over, { dir, owner });
      const st = await client(b, owner).status(s.id, sha(file));
      assert.equal(st.status, 200);
      assert.deepEqual((await st.json() as any).received, [0, 3]);
      assert.equal((await client(b, owner).status(l.id, sha(lost))).status, 404);
      await send(b, owner, s.id, file, [1, 2, 4]);
      assert.equal((await client(b, owner).complete(s.id, sha(file))).status, 201);
      assert.deepEqual(Buffer.from(await (await fetch(`${b.url}/${sha(file)}`)).arrayBuffer()), file);
      assert.deepEqual(readdirSync(join(dir, 'pieces')), []);
    } finally {
      await b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('uploads in pieces: a member removed mid-upload', () => {
  it('discards their open upload when the member list sync removes them', async () => {
    const dir = tempDir();
    const sk = serviceKey(dir);
    const owner = key(), m = key();
    const clock = { now: Math.floor(Date.now() / 1000) };
    const home = await fakeHome(() => sk.pk, () => clock.now);
    let members = [m.pk];
    let removed: { pubkey: string; removedAt: number; deletesAt: null; reason: string }[] = [];
    home.reply = () => ({ status: 200, body: { result: { owner: owner.pk, members, removed } } });
    const b = await box({ pieceBytes: PIECE, homeUrl: home.url, memberQuota: 50_000, homePollS: 3600, log: () => {}, now: () => clock.now }, { dir, owner });
    b.clock = clock;
    try {
      await b.run.home!.sync();
      const file = randomBytes(3 * PIECE);
      const s = await open(b, m, file);
      await send(b, m, s.id, file, [0, 1]);
      members = [];
      removed = [{ pubkey: m.pk, removedAt: clock.now, deletesAt: null, reason: 'removed' }];
      await b.run.home!.sync();
      assert.equal((await client(b, m).status(s.id, sha(file))).status, 403); // no account here now
      b.run.sweepUploads();
      assert.deepEqual(readdirSync(join(dir, 'pieces')), []);
      // back on the list: a new, empty upload, not the old one
      members = [m.pk];
      removed = [];
      await b.run.home!.sync();
      assert.equal((await client(b, m).status(s.id, sha(file))).status, 404);
      const again = await open(b, m, file);
      assert.notEqual(again.id, s.id);
      assert.deepEqual(again.received, []);
    } finally {
      await b.close();
      await home.close();
    }
  });
});
