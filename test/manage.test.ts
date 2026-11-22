// The management surface, POST /manage. The request signer here is written from the contract (NIP-98 kind 27235
// over the exact url, method and body), not from src/auth.ts.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import type { Config } from '../src/config.ts';
import { Db } from '../src/db.ts';
import { serviceKey } from '../src/servicekey.ts';
import { auth, box, DOMAIN, fakeHome, key, put, sha, tempDir, type Box, type FakeHome, type Key } from './helpers.ts';

const DAY = 86400;
const URL_ = `https://${DOMAIN}/manage`;
const CT = 'application/nostr+json+rpc';

// --- the signer, from the contract

interface SignOpts {
  u?: string;
  method?: string;
  payload?: string;
  createdAt?: number;
  kind?: number;
  /** Sign with this key's secret but claim `k`'s pubkey: a right id with a wrong signature. */
  wrongSig?: boolean;
}

function sign(k: Key, body: string, now: number, o: SignOpts = {}): string {
  const tags = [['u', o.u ?? URL_], ['method', o.method ?? 'POST'], ['payload', o.payload ?? createHash('sha256').update(body).digest('hex')]];
  const e: any = { pubkey: k.pk, created_at: o.createdAt ?? now, kind: o.kind ?? 27235, tags, content: '' };
  e.id = createHash('sha256').update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest('hex');
  e.sig = Buffer.from(schnorr.sign(Buffer.from(e.id, 'hex'), o.wrongSig ? key().sk : k.sk)).toString('hex');
  return 'Nostr ' + Buffer.from(JSON.stringify(e)).toString('base64');
}

/** Sends one call. `k` null sends it unsigned. Returns the status and the JSON reply. */
async function call(b: Box, k: Key | null, method: string, params: unknown[] = [], o: SignOpts & { body?: string; headers?: Record<string, string> } = {}) {
  const body = o.body ?? JSON.stringify({ method, params });
  const headers: Record<string, string> = { 'content-type': CT, ...o.headers };
  if (k) headers.authorization = sign(k, body, b.clock.now, o);
  const r = await fetch(`${b.url}/manage`, { method: 'POST', body, headers });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, headers: r.headers };
}

const blobFile = (b: Box, x: string) => join(b.dir, 'blobs', x.slice(0, 2), x.slice(2, 4), x);
const del = (b: Box, k: Key, x: string) =>
  fetch(`${b.url}/${x}`, { method: 'DELETE', headers: { authorization: auth(k, { t: 'delete', x: [x], now: b.clock.now }) } });

// --- a box that follows a fake home, for the home's owner and admins

interface Setup {
  b: Box;
  home: FakeHome;
  /** Sets what the home answers. `admins` undefined leaves the field out. */
  list(o: { members?: Key[]; admins?: Key[]; owner?: string }): void;
  close(): Promise<void>;
}

async function setup(over: Partial<Config> = {}): Promise<Setup> {
  const dir = tempDir();
  const sk = serviceKey(dir);
  const owner = key();
  const clock = { now: Math.floor(Date.now() / 1000) };
  const home = await fakeHome(() => sk.pk, () => clock.now);
  const list = (o: { members?: Key[]; admins?: Key[]; owner?: string }) => {
    const result: any = { owner: o.owner ?? owner.pk, members: (o.members ?? []).map((m) => m.pk), removed: [] };
    if (o.admins) result.admins = o.admins.map((a) => a.pk);
    home.reply = () => ({ status: 200, body: { result } });
  };
  list({});
  const b = await box({ homeUrl: home.url, memberQuota: 1e9, homePollS: 3600, log: () => {}, now: () => clock.now, ...over }, { dir, owner });
  b.clock = clock;
  await b.run.home!.sync();
  return { b, home, list, close: async () => { await b.close(); await home.close(); } };
}

describe('info', () => {
  let b: Box;
  before(async () => { b = await box(); });
  after(() => b.close());

  it('answers unsigned, signed by anyone, and by GET /manage/info', async () => {
    const want = { result: { pubkey: b.run.serviceKey.pk, home: null } };
    assert.deepEqual((await call(b, null, 'info')).json, want);
    assert.deepEqual((await call(b, key(), 'info')).json, want);
    assert.deepEqual((await call(b, key(), 'info', [], { wrongSig: true })).json, want); // no signature needed, none checked
    const g = await fetch(`${b.url}/manage/info`);
    assert.equal(g.status, 200);
    assert.deepEqual(await g.json(), want);
    assert.equal(g.headers.get('access-control-allow-origin'), '*');
  });

  it('names the home it follows', async () => {
    const s = await setup();
    try {
      assert.deepEqual((await call(s.b, null, 'info')).json, { result: { pubkey: s.b.run.serviceKey.pk, home: s.home.url } });
    } finally {
      await s.close();
    }
  });

  it('answers before the box is set up, and refuses the rest with 503', async () => {
    const u = await box({ publicUrl: '', owner: '', domains: [] });
    try {
      assert.equal((await call(u, null, 'info')).status, 200);
      const r = await call(u, u.owner, 'usage');
      assert.equal(r.status, 503);
      assert.match(r.json.error, /not set up/);
    } finally {
      await u.close();
    }
  });
});

describe('each method as the box owner', () => {
  let b: Box;
  const friend = key();
  const kept = randomBytes(5000), binned = randomBytes(6000), tiny = randomBytes(10);
  before(async () => {
    b = await box();
    b.run.db.putAccount(friend.pk, 1_000_000, b.clock.now);
    for (const x of [kept, binned, tiny]) assert.equal((await put(b, friend, x)).status, 201);
    assert.equal((await put(b, b.owner, kept)).status, 200);
    b.clock.now += 10;
    assert.equal((await del(b, friend, sha(binned))).status, 204);
  });
  after(() => b.close());

  it('usage: disk, totals and every account with its charged use', async () => {
    const r = await call(b, b.owner, 'usage');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/json');
    const u = r.json.result;
    assert.ok(u.disk.used > 0 && u.disk.free > 0);
    assert.deepEqual(u.total, { bytes: 5000 + 6000 + 10, blobs: 3 });
    const byKey = Object.fromEntries(u.accounts.map((a: any) => [a.pubkey, a]));
    assert.deepEqual(byKey[b.owner.pk], { pubkey: b.owner.pk, used: 5000, blobs: 1, quota: null, member: false, hand: true });
    // binned bytes stay on the friend's quota, and a tiny blob costs 4 KiB
    assert.deepEqual(byKey[friend.pk], { pubkey: friend.pk, used: 5000 + 6000 + 4096, blobs: 3, quota: 1_000_000, member: false, hand: true });
  });

  it('bin: what is binned, charged to whom, and when it is erased', async () => {
    const r = await call(b, b.owner, 'bin');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.result, {
      items: [{ sha256: sha(binned), size: 6000, type: 'application/octet-stream', charged: friend.pk, binnedAt: b.clock.now, erasesAt: b.clock.now + 30 * DAY }],
      more: false,
      parked: [],
    });
  });

  it('restore: back to the account it is charged to, at no extra charge', async () => {
    const before = b.run.db.account(friend.pk)!;
    const r = await call(b, b.owner, 'restore', [[sha(binned), sha(binned).toUpperCase(), sha('not here')]]);
    assert.deepEqual(r.json, { result: { restored: 1 } });
    assert.equal(b.run.db.blob(sha(binned))!.binned, null);
    assert.notEqual(b.run.db.uploadedAt(sha(binned), friend.pk), null);
    const now = b.run.db.account(friend.pk)!;
    assert.equal(now.used, before.used);
    assert.equal(now.blobs, before.blobs);
    assert.equal(now.used, b.run.db.usage(friend.pk));
    assert.deepEqual((await call(b, b.owner, 'bin')).json.result.items, []);
  });

  it('restore of a blob whose account is gone goes to the box owner', async () => {
    const gone = key(), x = randomBytes(5000);
    b.run.db.putAccount(gone.pk, 1_000_000, b.clock.now);
    await put(b, gone, x);
    await del(b, gone, sha(x));
    b.run.db.removeAccount(gone.pk, b.clock.now);
    assert.equal((await call(b, b.owner, 'bin')).json.result.items[0].charged, null);
    assert.deepEqual((await call(b, b.owner, 'restore', [[sha(x)]])).json, { result: { restored: 1 } });
    assert.notEqual(b.run.db.uploadedAt(sha(x), b.owner.pk), null);
    assert.equal(b.run.db.account(b.owner.pk)!.used, b.run.db.usage(b.owner.pk));
  });

  it('erase: row and file gone now, off every account it was charged to, out of the totals', async () => {
    const before = (await call(b, b.owner, 'usage')).json.result;
    assert.ok(existsSync(blobFile(b, sha(kept))));
    const r = await call(b, b.owner, 'erase', [[sha(kept), sha('not here')]]);
    assert.deepEqual(r.json, { result: { erased: 1 } });
    assert.equal(b.run.db.blob(sha(kept)), null);
    assert.equal(existsSync(blobFile(b, sha(kept))), false);
    assert.equal((await fetch(`${b.url}/${sha(kept)}`)).status, 404);
    const after = (await call(b, b.owner, 'usage')).json.result;
    assert.deepEqual(after.total, { bytes: before.total.bytes - 5000, blobs: before.total.blobs - 1 });
    const acc = (u: any, k: Key) => u.accounts.find((a: any) => a.pubkey === k.pk);
    assert.equal(acc(after, friend).used, acc(before, friend).used - 5000);
    assert.equal(acc(after, b.owner).used, acc(before, b.owner).used - 5000);
    assert.equal(acc(after, friend).used, b.run.db.usage(friend.pk));
  });

  it('an unknown method is an error reply after the signature', async () => {
    assert.deepEqual(await call(b, b.owner, 'nope').then((r) => [r.status, r.json]), [200, { error: 'unknown method' }]);
    assert.equal((await call(b, key(), 'nope')).status, 401);
  });
});

describe('the signature', () => {
  let b: Box;
  before(async () => { b = await box(); });
  after(() => b.close());

  const refused = async (o: SignOpts, why: RegExp) => {
    const r = await call(b, b.owner, 'usage', [], o);
    assert.equal(r.status, 401);
    assert.match(r.json.error, why);
  };

  it('must be for this url and no other', async () => {
    await refused({ u: 'https://other.test/manage' }, /another url/);
    await refused({ u: `${URL_}/` }, /another url/);
    await refused({ u: `https://${DOMAIN}/upload` }, /another url/);
    // a slash left on the base is all right
    assert.equal((await call(b, b.owner, 'usage', [], { u: `https://${DOMAIN}//manage` })).status, 200);
  });

  it('must carry the hash of the exact body', async () => {
    await refused({ payload: createHash('sha256').update('{}').digest('hex') }, /payload/);
    const body = JSON.stringify({ method: 'usage', params: [] });
    const r = await fetch(`${b.url}/manage`, {
      method: 'POST', body: body + ' ', headers: { 'content-type': CT, authorization: sign(b.owner, body, b.clock.now) },
    });
    assert.equal(r.status, 401);
  });

  it('must be from within a minute of now, either way', async () => {
    await refused({ createdAt: b.clock.now - 61 }, /more than a minute old/);
    await refused({ createdAt: b.clock.now + 61 }, /future/);
    assert.equal((await call(b, b.owner, 'usage', [], { createdAt: b.clock.now - 60 })).status, 200);
    assert.equal((await call(b, b.owner, 'usage', [], { createdAt: b.clock.now + 60 })).status, 200);
  });

  it('must be kind 27235 with method POST', async () => {
    await refused({ kind: 24242 }, /kind 27235/);
    await refused({ method: 'GET' }, /not for POST/);
  });

  it('must be signed by the key it names, and be there at all', async () => {
    await refused({ wrongSig: true }, /signature is wrong/);
    const r = await call(b, null, 'usage');
    assert.equal(r.status, 401);
    assert.match(r.json.error, /authorization required/);
  });

  it('from a stranger is refused before its signature is checked', async () => {
    const stranger = key();
    for (const o of [{}, { wrongSig: true }, { u: 'https://other.test/manage', wrongSig: true }]) {
      const r = await call(b, stranger, 'usage', [], o);
      assert.equal(r.status, 401);
      assert.equal(r.json.error, 'this key may not manage this box');
    }
  });

  it('a plain friend with an account may not manage', async () => {
    const friend = key();
    b.run.db.putAccount(friend.pk, 1e9, b.clock.now);
    for (const m of ['usage', 'bin', 'restore', 'erase']) {
      const r = await call(b, friend, m, m === 'restore' || m === 'erase' ? [[]] : []);
      assert.equal(r.status, 401);
      assert.equal(r.json.error, 'this key may not manage this box');
    }
  });
});

describe('the request', () => {
  let b: Box;
  before(async () => { b = await box({ authBurst: 3, authPerSecond: 0.001 }); });
  after(() => b.close());

  it('answers the CORS preflight like the Blossom routes, Authorization allowed', async () => {
    const r = await fetch(`${b.url}/manage`, {
      method: 'OPTIONS', headers: { origin: 'https://page.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.match(r.headers.get('access-control-allow-headers')!, /Authorization/);
    assert.match(r.headers.get('access-control-allow-methods')!, /POST/);
    const blossom = await fetch(`${b.url}/upload`, { method: 'OPTIONS' });
    for (const h of ['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods', 'access-control-max-age']) {
      assert.equal(r.headers.get(h), blossom.headers.get(h));
    }
  });

  it('wants the content type, a JSON call, POST, and a body of at most 64 KiB', async () => {
    let r = await call(b, null, 'info', [], { headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 415);
    assert.match(r.json.error, /application\/nostr\+json\+rpc/);
    r = await call(b, null, '', [], { body: 'not json' });
    assert.equal(r.status, 400);
    r = await call(b, null, '', [], { body: '{"method":"info","params":{}}' });
    assert.equal(r.status, 400);
    assert.equal((await fetch(`${b.url}/manage`)).status, 405);
    const big = JSON.stringify({ method: 'info', params: [], pad: 'x'.repeat(64 * 1024) });
    r = await call(b, null, 'info', [], { body: big });
    assert.equal(r.status, 413);
    assert.match(r.json.error, /64 KiB/);
    const fits = JSON.stringify({ method: 'info', params: [], pad: '' });
    r = await call(b, null, 'info', [], { body: fits + ' '.repeat(64 * 1024 - fits.length) });
    assert.equal(r.status, 200);
  });

  it('is limited per address when signed, with a JSON 429', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await call(b, b.owner, 'usage')).status, 200);
    const r = await call(b, b.owner, 'usage');
    assert.equal(r.status, 429);
    assert.match(r.json.error, /too many signed requests/);
    assert.equal((await call(b, null, 'info')).status, 200); // unsigned info is not limited
  });
});

describe('hashes', () => {
  let b: Box;
  before(async () => { b = await box(); });
  after(() => b.close());

  it('at most 500 per call, each a sha256, or nothing is done', async () => {
    const x = randomBytes(5000);
    await put(b, b.owner, x);
    await del(b, b.owner, sha(x));
    const many = Array.from({ length: 501 }, (_, i) => sha(String(i)));
    assert.deepEqual((await call(b, b.owner, 'restore', [many])).json, { error: 'at most 500 hashes per call' });
    assert.deepEqual((await call(b, b.owner, 'erase', [many])).json, { error: 'at most 500 hashes per call' });
    for (const bad of ['abc', 'g'.repeat(64), 42, null]) {
      const r = await call(b, b.owner, 'restore', [[sha(x), bad]]);
      assert.equal(r.status, 200);
      assert.match(r.json.error, /not a sha256/);
    }
    assert.match((await call(b, b.owner, 'erase', [[sha(x), 'abc']])).json.error, /not a sha256/);
    assert.match((await call(b, b.owner, 'restore', [sha(x)])).json.error, /params must be/);
    assert.notEqual(b.run.db.blob(sha(x))!.binned, null); // nothing was done
    assert.deepEqual((await call(b, b.owner, 'restore', [many.slice(0, 500)])).json, { result: { restored: 0 } });
  });
});

describe('the bin listing', () => {
  let b: Box;
  before(async () => { b = await box(); });
  after(() => b.close());

  it('stops at 5,000 items, newest first, and says there is more', async () => {
    const db = b.run.db;
    db.tx(() => {
      for (let i = 0; i < 5001; i++) {
        const x = sha(`blob ${i}`);
        db.own(x, 100, 'image/png', b.owner.pk, 1000 + i);
        db.disown(x, b.owner.pk, 1000 + i);
      }
    });
    const r = (await call(b, b.owner, 'bin')).json.result;
    assert.equal(r.items.length, 5000);
    assert.equal(r.more, true);
    assert.equal(r.items[0].sha256, sha('blob 5000'));
    assert.equal(r.items[4999].sha256, sha('blob 1'));
    assert.equal(r.items[0].charged, b.owner.pk);
  });
});

describe("the home's owner and admins", () => {
  let s: Setup;
  const admin = key(), member = key(), homeOwner = key();
  before(async () => {
    s = await setup();
    s.list({ members: [member], admins: [admin], owner: homeOwner.pk });
    assert.equal((await s.b.run.home!.sync()).ok, true);
  });
  after(() => s.close());
  afterEach(() => assert.deepEqual(s.home.refused, []));

  it('an admin may see usage and the bin and restore, but not erase', async () => {
    const x = randomBytes(5000);
    await put(s.b, member, x);
    await del(s.b, member, sha(x));
    assert.equal((await call(s.b, admin, 'usage')).status, 200);
    assert.equal((await call(s.b, admin, 'bin')).json.result.items[0].charged, member.pk);
    assert.deepEqual((await call(s.b, admin, 'restore', [[sha(x)]])).json, { result: { restored: 1 } });
    const r = await call(s.b, admin, 'erase', [[sha(x)]]);
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'only the owner of this box may erase');
    assert.notEqual(s.b.run.db.blob(sha(x)), null);
    assert.equal(existsSync(blobFile(s.b, sha(x))), true);
  });

  it("an admin's bad signature is still refused", async () => {
    assert.equal((await call(s.b, admin, 'usage', [], { wrongSig: true })).status, 401);
  });

  it('a member of the home may not manage', async () => {
    const r = await call(s.b, member, 'usage');
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'this key may not manage this box');
  });

  it("the home's owner is an owner here: it may erase", async () => {
    const x = randomBytes(5000);
    await put(s.b, member, x);
    assert.deepEqual((await call(s.b, homeOwner, 'erase', [[sha(x)]])).json, { result: { erased: 1 } });
    assert.equal(existsSync(blobFile(s.b, sha(x))), false);
  });

  it('admins are kept while the home is unreachable or answers with an error', async () => {
    s.home.reply = () => ({ status: 500, body: 'down' });
    assert.equal((await s.b.run.home!.sync()).ok, false);
    s.home.reply = () => ({ status: 200, body: { result: { owner: homeOwner.pk, members: [], removed: [], admins: 'nope' } } });
    const bad = await s.b.run.home!.sync();
    assert.equal(!bad.ok && bad.kind, 'malformed');
    assert.equal((await call(s.b, admin, 'usage')).status, 200);
    assert.equal((await call(s.b, homeOwner, 'usage')).status, 200);
  });

  it('a new admin is looked up on a miss', async () => {
    const late = key();
    s.list({ members: [member], admins: [admin, late], owner: homeOwner.pk });
    s.b.clock.now += 61;
    assert.equal((await call(s.b, late, 'usage')).status, 200);
  });

  it('a reply without admins means no admins, and members still follow it', async () => {
    const joiner = key();
    s.list({ members: [member, joiner], owner: homeOwner.pk });
    assert.equal((await s.b.run.home!.sync()).ok, true);
    assert.equal(s.b.run.db.account(joiner.pk)?.member, 1);
    s.b.clock.now += 61; // past the lookup interval, so the miss asks the home again and it still says none
    const r = await call(s.b, admin, 'usage');
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'this key may not manage this box');
  });
});

describe('a home unreachable from the start of a restart', () => {
  it('still knows its admins from the database', async () => {
    const s = await setup();
    const admin = key();
    try {
      s.list({ admins: [admin] });
      await s.b.run.home!.sync();
      const dir = s.b.dir, owner = s.b.owner, homeUrl = s.home.url;
      await s.b.run.close();
      await s.home.close(); // nothing listens there now
      const b = await box({ homeUrl, homePollS: 3600, homeTimeoutMs: 2000, log: () => {} }, { dir, owner });
      s.b = b;
      await b.run.home!.sync();
      assert.equal(b.run.db.homeState().errorKind, 'unreachable');
      assert.equal((await call(b, admin, 'usage')).status, 200);
    } finally {
      await s.b.close();
      await s.home.close();
    }
  });
});

describe('parked files of a removed member', () => {
  let s: Setup;
  const m = key();
  const alone = randomBytes(5000), small = randomBytes(10), shared = randomBytes(7000);
  before(async () => {
    s = await setup();
    s.list({ members: [m] });
    await s.b.run.home!.sync();
    for (const x of [alone, small, shared]) assert.equal((await put(s.b, m, x)).status, 201);
    await put(s.b, s.b.owner, shared);
    s.home.reply = () => ({ status: 200, body: { result: { owner: s.b.owner.pk, members: [], removed: [{ pubkey: m.pk, removedAt: s.b.clock.now, reason: 'removed' }] } } });
    await s.b.run.home!.sync();
  });
  after(() => s.close());

  it('are listed with what comes back on return, shared files included', async () => {
    const r = (await call(s.b, s.b.owner, 'bin')).json.result;
    assert.deepEqual(r.parked, [{ pubkey: m.pk, removedAt: s.b.clock.now, reason: 'removed', bytes: 5000 + 4096 + 7000, blobs: 3, erasesAt: s.b.clock.now + 30 * DAY }]);
    assert.equal(r.items.length, 2); // the shared one is not in the bin
    assert.ok(r.items.every((i: any) => i.charged === null)); // the account is gone, so nobody is charged
  });

  it('go down when one is erased, and drop off once the bin has erased them', async () => {
    assert.deepEqual((await call(s.b, s.b.owner, 'erase', [[sha(small)]])).json, { result: { erased: 1 } });
    assert.deepEqual((await call(s.b, s.b.owner, 'bin')).json.result.parked.map((p: any) => [p.bytes, p.blobs]), [[5000 + 7000, 2]]);
    s.b.clock.now += 31 * DAY;
    s.b.run.sweep();
    const r = (await call(s.b, s.b.owner, 'bin')).json.result;
    assert.deepEqual(r.parked, []);
    assert.deepEqual(r.items, []);
    assert.equal(s.b.run.db.sql.prepare('SELECT blobs FROM home_removed WHERE pubkey = ?').get(m.pk)!.blobs, 1); // the shared one
  });
});

describe('upgrading a 0.2.0 database', () => {
  it('counts the totals, the parked files and the home owner once', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'storage.db');
      let db = new Db(file);
      const m = key();
      db.joinMember(m.pk, 1e9, 1);
      for (let i = 0; i < 3; i++) db.own(sha(`p${i}`), 1000 * (i + 1), 'text/plain', m.pk, 1);
      db.own(sha('kept'), 50_000, 'text/plain', key().pk, 1);
      db.leaveMember({ pubkey: m.pk, removedAt: 5, deletesAt: null, reason: 'removed', noticed: 5 }, 5);
      db.saveHomeState({ list: JSON.stringify({ owner: m.pk, members: [], removed: [] }), homeOwner: null });
      // back to how 0.2.0 left it
      db.sql.exec(`DROP TRIGGER totals_in; DROP TRIGGER totals_out; DROP TRIGGER parked_out; DROP TABLE totals;
        ALTER TABLE home_removed DROP COLUMN bytes; ALTER TABLE home_removed DROP COLUMN blobs;
        ALTER TABLE home_state DROP COLUMN home_owner; ALTER TABLE home_state DROP COLUMN admins; PRAGMA user_version = 3;`);
      db.close();
      db = new Db(file);
      assert.deepEqual(db.totals(), { bytes: 1000 + 2000 + 3000 + 50_000, blobs: 4 });
      assert.deepEqual(db.parked(0).map((p) => [p.pubkey, p.bytes, p.blobs]), [[m.pk, 4096 * 3, 3]]);
      assert.deepEqual(db.homeRoles(), { owner: m.pk, admins: [] });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
