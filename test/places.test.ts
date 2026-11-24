// Photo places, POST /places (LOCATION-CONTRACT.md 3 and 7.1). The request signer here is written from the contract
// (NIP-98 kind 27235 over the exact url, method and body), not from src/auth.ts.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import type { Config } from '../src/config.ts';
import { configFromEnv, DEFAULT_TOWNS } from '../src/config.ts';
import { Db } from '../src/db.ts';
import { serviceKey } from '../src/servicekey.ts';
import { Towns } from '../src/towns.ts';
import { auth, box, DOMAIN, fakeHome, key, sha, tempDir, type Box, type FakeHome, type Key } from './helpers.ts';

const URL_ = `https://${DOMAIN}/places`;
const CT = 'application/nostr+json+rpc';
const NOT_ON_BOX = JSON.stringify({ error: 'this key is not on this box' });
export const FIXTURE = join(import.meta.dirname, 'fixtures', 'towns-small.tsv.gz');

interface SignOpts {
  u?: string;
  method?: string;
  payload?: string;
  createdAt?: number;
  wrongSig?: boolean;
}

function sign(k: Key, body: string, now: number, o: SignOpts = {}): string {
  const tags = [['u', o.u ?? URL_], ['method', o.method ?? 'POST'], ['payload', o.payload ?? createHash('sha256').update(body).digest('hex')]];
  const e: any = { pubkey: k.pk, created_at: o.createdAt ?? now, kind: 27235, tags, content: '' };
  e.id = createHash('sha256').update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest('hex');
  e.sig = Buffer.from(schnorr.sign(Buffer.from(e.id, 'hex'), o.wrongSig ? key().sk : k.sk)).toString('hex');
  return 'Nostr ' + Buffer.from(JSON.stringify(e)).toString('base64');
}

async function call(b: Box, k: Key | null, method: string, params: unknown[] = [], o: SignOpts & { body?: string; headers?: Record<string, string>; httpMethod?: string; path?: string } = {}) {
  const body = o.body ?? JSON.stringify({ method, params });
  const headers: Record<string, string> = { 'content-type': CT, ...o.headers };
  if (k) headers.authorization = sign(k, body, b.clock.now, o);
  const m = o.httpMethod ?? 'POST';
  const r = await fetch(`${b.url}${o.path ?? '/places'}`, { method: m, body: m === 'GET' || m === 'HEAD' ? undefined : body, headers });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}

const hex = () => randomBytes(32).toString('hex');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

// --- a box that follows a fake home

interface Setup {
  b: Box;
  home: FakeHome;
  logs: string[];
  list(o: { members?: Key[]; owner?: string; removed?: { k: Key; reason: 'removed' | 'erased' }[] }): void;
  close(): Promise<void>;
}

async function setup(over: Partial<Config> = {}): Promise<Setup> {
  const dir = tempDir();
  const sk = serviceKey(dir);
  const owner = key();
  const clock = { now: Math.floor(Date.now() / 1000) };
  const home = await fakeHome(() => sk.pk, () => clock.now);
  const logs: string[] = [];
  const list: Setup['list'] = (o) => {
    const result = {
      owner: o.owner ?? owner.pk, members: (o.members ?? []).map((m) => m.pk),
      removed: (o.removed ?? []).map((r) => ({ pubkey: r.k.pk, removedAt: clock.now, reason: r.reason })),
    };
    home.reply = () => ({ status: 200, body: { result } });
  };
  list({});
  const b = await box({ homeUrl: home.url, memberQuota: 1e9, homePollS: 3600, log: (l) => logs.push(l), now: () => clock.now, ...over }, { dir, owner });
  b.clock = clock;
  await b.run.home!.sync();
  return { b, home, logs, list, close: async () => { await b.close(); await home.close(); } };
}

describe('1. members', () => {
  let s: Setup;
  const m1 = key(), m2 = key(), homeOwner = key(), friend = key(), stranger = key();
  before(async () => {
    s = await setup();
    s.list({ members: [m1, m2], owner: homeOwner.pk });
    await s.b.run.home!.sync();
    s.b.run.db.putAccount(friend.pk, 1e9, s.b.clock.now); // by hand, not a member of the home
    s.list({ members: [m1], owner: homeOwner.pk, removed: [{ k: m2, reason: 'removed' }] });
    await s.b.run.home!.sync();
  });
  after(() => s.close());

  it('says who is on the box: members, the home owner and the box owner; not removed members, hand-added friends or strangers', async () => {
    const r = await call(s.b, m1, 'members', [[m1.pk, homeOwner.pk, s.b.owner.pk, m2.pk, friend.pk, stranger.pk]]);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('content-type'), 'application/json');
    assert.deepEqual(r.json, { result: { [m1.pk]: true, [homeOwner.pk]: true, [s.b.owner.pk]: true, [m2.pk]: false, [friend.pk]: false, [stranger.pk]: false } });
    // the home owner and the box owner may ask too
    assert.equal((await call(s.b, homeOwner, 'members', [[m1.pk]])).json.result[m1.pk], true);
    assert.equal((await call(s.b, s.b.owner, 'members', [[m2.pk]])).json.result[m2.pk], false);
  });

  it('takes 1 to 500 lowercase 64-hex keys', async () => {
    const many = Array.from({ length: 500 }, hex);
    const r = await call(s.b, m1, 'members', [many]);
    assert.equal(Object.keys(r.json.result).length, 500);
    const err = { error: 'members takes an array of 1 to 500 pubkeys, as 64-character hex' };
    for (const params of [[[...many, hex()]], [[]], [[m1.pk.toUpperCase()]], [[m1.pk.slice(1)]], [[42]], [m1.pk], [], [[m1.pk], [m1.pk]]]) {
      const bad = await call(s.b, m1, 'members', params);
      assert.equal(bad.status, 200);
      assert.deepEqual(bad.json, err, JSON.stringify(params).slice(0, 80));
    }
  });

  it('with no home set, only STORAGE_OWNER is on the box', async () => {
    const b = await box({ log: () => {} });
    try {
      const f = key();
      b.run.db.putAccount(f.pk, 1e9, b.clock.now);
      assert.deepEqual((await call(b, b.owner, 'members', [[b.owner.pk, f.pk]])).json, { result: { [b.owner.pk]: true, [f.pk]: false } });
      const r = await call(b, f, 'members', [[f.pk]]);
      assert.deepEqual([r.status, r.text], [401, NOT_ON_BOX]);
    } finally {
      await b.close();
    }
  });
});

describe('2. who may call', () => {
  let s: Setup;
  const m = key(), removed = key(), friend = key();
  before(async () => {
    s = await setup();
    s.list({ members: [m, removed] });
    await s.b.run.home!.sync();
    s.list({ members: [m], removed: [{ k: removed, reason: 'removed' }] });
    await s.b.run.home!.sync();
    s.b.run.db.putAccount(friend.pk, 1e9, s.b.clock.now);
  });
  after(() => s.close());

  it('a key not on the box gets 401 with the same words for every method', async () => {
    const calls: [string, unknown[]][] = [
      ['members', [[m.pk]]], ['put', [b64(randomBytes(100))]], ['get', [[sha('x')]]], ['drop', [[sha('x')]]],
      ['names', [{ points: [[1, 2]] }]], ['nope', []], ['members', ['bad params']],
    ];
    for (const k of [friend, removed, key()]) {
      for (const [method, params] of calls) {
        const r = await call(s.b, k, method, params);
        assert.deepEqual([r.status, r.text], [401, NOT_ON_BOX], method);
        assert.equal(r.headers.get('content-type'), 'application/json');
      }
    }
    assert.deepEqual((await call(s.b, m, 'nope')).json, { error: 'unknown method' });
  });

  it('a key the home has just added is let in after one lookup; a second unknown key within the minute causes none', async () => {
    const late = key(), other = key();
    s.list({ members: [m, late] });
    s.b.clock.now += 61; // past the lookup interval
    const calls = s.home.calls;
    const r = await call(s.b, late, 'members', [[late.pk]]);
    assert.deepEqual(r.json, { result: { [late.pk]: true } });
    assert.equal(s.home.calls, calls + 1);
    const o = await call(s.b, other, 'members', [[other.pk]]);
    assert.equal(o.status, 401);
    assert.equal(s.home.calls, calls + 1);
    assert.deepEqual(s.home.refused, []);
  });
});

describe('3. the request and its signature', () => {
  let b: Box;
  before(async () => { b = await box({ authBurst: 40, authPerSecond: 0.001, log: () => {} }); });
  after(() => b.close());

  const refused = async (o: SignOpts, why: string) => {
    const r = await call(b, b.owner, 'members', [[b.owner.pk]], o);
    assert.deepEqual([r.status, r.json], [401, { error: why }]);
  };

  it('wrong u, wrong payload, stale created_at, wrong method: 401 with the reason', async () => {
    await refused({ u: `https://${DOMAIN}/manage` }, 'authorization is for another url');
    await refused({ u: `${URL_}/` }, 'authorization is for another url');
    await refused({ payload: sha('{}') }, 'authorization payload does not match the body');
    await refused({ createdAt: b.clock.now - 61 }, 'authorization is more than a minute old: sign a new one');
    await refused({ createdAt: b.clock.now + 61 }, "authorization is from the future: check this device's clock");
    await refused({ method: 'GET' }, 'authorization is not for POST');
    await refused({ wrongSig: true }, 'authorization signature is wrong');
    const none = await call(b, null, 'members', [[b.owner.pk]]);
    assert.deepEqual([none.status, none.json], [401, { error: 'authorization required' }]);
    // a slash left on the base url is all right, as for /manage
    assert.equal((await call(b, b.owner, 'members', [[b.owner.pk]], { u: `https://${DOMAIN}//places` })).status, 200);
  });

  it('refuses the method, type, size and shape before the signature, each as JSON', async () => {
    let r = await call(b, null, 'members', [], { httpMethod: 'GET' });
    assert.deepEqual([r.status, r.json], [405, { error: 'use POST' }]);
    r = await call(b, b.owner, 'members', [], { headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 415);
    const big = JSON.stringify({ method: 'members', params: [], pad: 'x'.repeat(256 * 1024) });
    r = await call(b, null, 'members', [], { body: big });
    assert.deepEqual([r.status, r.json], [413, { error: 'body is over 256 KiB' }]);
    r = await call(b, b.owner, '', [], { body: 'not json' });
    assert.deepEqual([r.status, r.json], [400, { error: 'body must be {"method": "...", "params": [...]}' }]);
    r = await call(b, b.owner, '', [], { body: '{"method":"members","params":{}}' });
    assert.equal(r.status, 400);
  });

  it('answers 503 before the signature on a box not set up', async () => {
    const u = await box({ publicUrl: '', owner: '', domains: [], log: () => {} });
    try {
      const r = await call(u, key(), 'members', [[hex()]], { wrongSig: true });
      assert.equal(r.status, 503);
      assert.match(r.json.error, /not set up/);
    } finally {
      await u.close();
    }
  });

  it('over the per-address limit: 429 before the signature', async () => {
    const tight = await box({ authBurst: 2, authPerSecond: 0.001, log: () => {} });
    try {
      for (let i = 0; i < 2; i++) assert.equal((await call(tight, tight.owner, 'members', [[hex()]])).status, 200);
      const r = await call(tight, tight.owner, 'members', [[hex()]], { wrongSig: true });
      assert.equal(r.status, 429);
      assert.match(r.json.error, /too many signed requests/);
    } finally {
      await tight.close();
    }
  });
});

describe('4. put, get and drop', () => {
  let s: Setup;
  const m1 = key(), m2 = key();
  before(async () => {
    s = await setup({ maxPlaceNotes: 3 });
    s.list({ members: [m1, m2] });
    await s.b.run.home!.sync();
  });
  after(() => s.close());

  it('round trip: put answers the sha of the bytes, get gives them back to any member, drop takes them away', async () => {
    const note = randomBytes(1000);
    const r = await call(s.b, m1, 'put', [b64(note)]);
    assert.deepEqual(r.json, { result: { sha: sha(note) } });
    const g = await call(s.b, m2, 'get', [[sha(note), sha('not here')]]);
    assert.deepEqual(g.json, { result: { [sha(note)]: b64(note) } });
    assert.deepEqual((await call(s.b, s.b.owner, 'get', [[sha(note).toUpperCase()]])).json, { result: { [sha(note)]: b64(note) } });
    // another account's note: nothing dropped, still there
    assert.deepEqual((await call(s.b, m2, 'drop', [[sha(note)]])).json, { result: { dropped: 0 } });
    assert.equal(Object.keys((await call(s.b, m2, 'get', [[sha(note)]])).json.result).length, 1);
    assert.deepEqual((await call(s.b, m1, 'drop', [[sha(note), sha('not here')]])).json, { result: { dropped: 1 } });
    assert.deepEqual((await call(s.b, m2, 'get', [[sha(note)]])).json, { result: {} });
  });

  it('storing the same note twice gives the same answer and changes nothing', async () => {
    const note = randomBytes(300);
    const first = await call(s.b, m1, 'put', [b64(note)]);
    const count = s.b.run.db.noteCount(m1.pk);
    const again = await call(s.b, m1, 'put', [b64(note).replace(/=+$/, '')]); // padding is optional
    assert.deepEqual(again.json, first.json);
    assert.equal(s.b.run.db.noteCount(m1.pk), count);
    // someone else storing it too changes nothing either
    assert.deepEqual((await call(s.b, m2, 'put', [b64(note)])).json, first.json);
    assert.equal(s.b.run.db.noteCount(m2.pk), 0);
    await call(s.b, m1, 'drop', [[sha(note)]]);
  });

  it('65,536 bytes are taken, 65,537 are not; neither are empty notes or anything that is not base64', async () => {
    const max = randomBytes(65536);
    assert.deepEqual((await call(s.b, m2, 'put', [b64(max)])).json, { result: { sha: sha(max) } });
    const err = { error: 'put takes one sealed place note, at most 65536 bytes, as base64' };
    for (const params of [[b64(randomBytes(65537))], [''], ['not base64!'], ['QQ='], ['QR=='], [42], [], [b64(max), b64(max)], [[b64(max)]]]) {
      assert.deepEqual((await call(s.b, m2, 'put', params)).json, err, JSON.stringify(params).slice(0, 40));
    }
    await call(s.b, m2, 'drop', [[sha(max)]]);
  });

  it('an account keeps at most the cap of notes (3 here); a note already here still answers', async () => {
    const notes = [randomBytes(10), randomBytes(11), randomBytes(12)];
    for (const n of notes) assert.deepEqual((await call(s.b, m2, 'put', [b64(n)])).json, { result: { sha: sha(n) } });
    assert.deepEqual((await call(s.b, m2, 'put', [b64(randomBytes(13))])).json, { error: 'too many place notes stored for you' });
    assert.deepEqual((await call(s.b, m2, 'put', [b64(notes[0])])).json, { result: { sha: sha(notes[0]) } });
    // someone else's cap is their own
    const other = randomBytes(14);
    assert.deepEqual((await call(s.b, m1, 'put', [b64(other)])).json, { result: { sha: sha(other) } });
    await call(s.b, m2, 'drop', [notes.map(sha)]);
    await call(s.b, m1, 'drop', [[sha(other)]]);
  });

  it('get and drop take 1 to 100 sha256 hashes', async () => {
    const many = Array.from({ length: 100 }, (_, i) => sha(String(i)));
    assert.deepEqual((await call(s.b, m1, 'get', [many])).json, { result: {} });
    assert.deepEqual((await call(s.b, m1, 'drop', [many])).json, { result: { dropped: 0 } });
    for (const params of [[[...many, sha('x')]], [[]], [['abc']], [sha('x')], []]) {
      assert.deepEqual((await call(s.b, m1, 'get', params)).json, { error: 'get takes an array of 1 to 100 sha256 hashes' });
      assert.deepEqual((await call(s.b, m1, 'drop', params)).json, { error: 'drop takes an array of 1 to 100 sha256 hashes' });
    }
  });

  it('a full disk refuses a note with 507', async () => {
    const b = await box({ diskMarginBytes: Number.MAX_SAFE_INTEGER, log: () => {} });
    try {
      const r = await call(b, b.owner, 'put', [b64(randomBytes(10))]);
      assert.deepEqual([r.status, r.json], [507, { error: 'this box is out of disk space' }]);
    } finally {
      await b.close();
    }
  });
});

describe('5. notes are not blobs', () => {
  let s: Setup;
  const m = key();
  const note = randomBytes(5000);
  before(async () => {
    s = await setup();
    s.list({ members: [m] });
    await s.b.run.home!.sync();
    assert.equal((await call(s.b, m, 'put', [b64(note)])).status, 200);
  });
  after(() => s.close());

  it('are never served by GET /<sha256>, listed, or counted in /manage usage', async () => {
    assert.equal((await fetch(`${s.b.url}/${sha(note)}`)).status, 404);
    assert.equal((await fetch(`${s.b.url}/${sha(note)}.bin`, { method: 'HEAD' })).status, 404);
    const list = await fetch(`${s.b.url}/list/${m.pk}`, { headers: { authorization: auth(m, { t: 'list', now: s.b.clock.now }) } });
    assert.deepEqual(await list.json(), []);
    const body = JSON.stringify({ method: 'usage', params: [] });
    const u = await fetch(`${s.b.url}/manage`, {
      method: 'POST', body,
      headers: { 'content-type': CT, authorization: sign(s.b.owner, body, s.b.clock.now, { u: `https://${DOMAIN}/manage` }) },
    });
    const usage = ((await u.json()) as any).result;
    assert.deepEqual(usage.total, { bytes: 0, blobs: 0 });
    assert.ok(usage.accounts.every((a: any) => a.used === 0 && a.blobs === 0));
  });
});

describe('6. notes go with their account', () => {
  let s: Setup;
  const a = key(), e = key(), stays = key();
  before(async () => {
    s = await setup();
    s.list({ members: [a, e, stays] });
    await s.b.run.home!.sync();
  });
  after(() => s.close());

  const put = async (k: Key) => {
    const n = randomBytes(64);
    assert.equal((await call(s.b, k, 'put', [b64(n)])).status, 200);
    return sha(n);
  };

  it('a member removed through the member list takes their notes along; so does one who erased their account', async () => {
    const [na, ne, ns] = [await put(a), await put(e), await put(stays)];
    s.list({ members: [e, stays], removed: [{ k: a, reason: 'removed' }] });
    assert.equal((await s.b.run.home!.sync()).ok, true);
    assert.equal(s.b.run.db.noteCount(a.pk), 0);
    assert.deepEqual(Object.keys((await call(s.b, stays, 'get', [[na, ne, ns]])).json.result).sort(), [ne, ns].sort());
    s.list({ members: [stays], removed: [{ k: e, reason: 'erased' }] });
    assert.equal((await s.b.run.home!.sync()).ok, true);
    assert.deepEqual(Object.keys((await call(s.b, stays, 'get', [[na, ne, ns]])).json.result), [ns]);
  });
});

describe('7. names', () => {
  let b: Box;
  const logs: string[] = [];
  before(async () => {
    b = await box({ towns: FIXTURE, log: (l) => logs.push(l) });
    await b.run.towns!.load();
  });
  after(() => b.close());

  const names = async (points: number[][], k: Key = b.owner) => {
    const r = await call(b, k, 'names', [{ points }]);
    assert.equal(r.status, 200, r.text);
    return r.json.result;
  };

  it('the nearest town, from the point rounded to 2 decimals, with the list version', async () => {
    const r = await names([[38.5733, -109.5498]]);
    assert.equal(r.list, b.run.towns!.version);
    assert.match(r.list, /^sha256-[0-9a-f]{16}$/); // the fixture has no SOURCE next to it
    // 0.4 km: from 38.57, -109.55, not from the exact point (0 km)
    assert.deepEqual(r.names, [{ town: 'Moab', region: 'Utah', country: 'United States', cc: 'US', km: 0.4 }]);
    const two = await names([[51.18, -115.57], [40.74, -74.03]]);
    assert.deepEqual(two.names.map((n: any) => [n.town, n.region, n.cc]), [['Banff', 'Alberta', 'CA'], ['Hoboken', 'New Jersey', 'US']]);
  });

  it('nothing within 30 km gives null; 31 km away is too far', async () => {
    const r = await names([[0.28, 0], [0.26, 0], [-45, -150]]);
    assert.equal(r.names[0], null);
    assert.equal(r.names[1].town, 'Lonely');
    assert.equal(r.names[1].km, 28.9);
    assert.equal(r.names[2], null);
  });

  it('two towns at the same distance: the bigger one; 2 km apart: the nearer one', async () => {
    const r = await names([[10, 20], [10, 20.01]]);
    assert.equal(r.names[0].town, 'Bigton');
    assert.equal(r.names[1].town, 'Smallton');
  });

  it('near 70° N, and above 80° where 30 km spans several cells of longitude', async () => {
    const r = await names([[70.66, 24.3], [85, 14.9]]);
    assert.equal(r.names[0].town, 'Hammerfest');
    assert.ok(r.names[0].km > 20 && r.names[0].km < 25, String(r.names[0].km));
    assert.deepEqual(r.names[1], { town: 'Northpoint', region: '', country: 'Greenland', cc: 'GL', km: r.names[1].km });
    assert.ok(r.names[1].km > 20 && r.names[1].km < 30);
  });

  it('across the date line, both ways', async () => {
    const r = await names([[-16.8, -179.95], [-16.8, 179.99], [-16.8, 180], [-16.8, -180]]);
    assert.deepEqual(r.names.map((n: any) => n?.town), ['Eastend', 'Eastend', 'Eastend', 'Eastend']);
    assert.equal(r.names[0].km, 10.6);
  });

  it('takes 1 to 200 points of numbers in range', async () => {
    const ok = Array.from({ length: 200 }, (_, i) => [i % 90, i % 180]);
    assert.equal((await names(ok)).names.length, 200);
    assert.equal((await names([[90, 180], [-90, -180]])).names.length, 2);
    const err = { error: 'names takes {"points": [[lat, lon], ...]}, 1 to 200 points' };
    for (const params of [
      [{ points: [...ok, [0, 0]] }], [{ points: [] }], [{ points: [[90.01, 0]] }], [{ points: [[0, -180.5]] }], [{ points: [[-91, 0]] }],
      [{ points: [['1', 2]] }], [{ points: [[1]] }], [{ points: [[1, 2, 3]] }], [{ points: [null] }], [{}], [[[1, 2]]], [],
    ]) {
      assert.deepEqual((await call(b, b.owner, 'names', params)).json, err, JSON.stringify(params).slice(0, 60));
    }
  });

  it('the 31st call in a minute from one key gets 429, the next minute it works again', async () => {
    const t = key();
    const fresh = await box({ towns: FIXTURE, log: () => {} }, { owner: t });
    try {
      await fresh.run.towns!.load();
      for (let i = 0; i < 30; i++) assert.equal((await call(fresh, t, 'names', [{ points: [[1, 1]] }])).status, 200);
      const r = await call(fresh, t, 'names', [{ points: [[1, 1]] }]);
      assert.deepEqual([r.status, r.json], [429, { error: 'too many town lookups; wait a minute' }]);
      assert.equal((await call(fresh, t, 'members', [[t.pk]])).status, 200); // other methods are not held back
      fresh.clock.now += 60;
      assert.equal((await call(fresh, t, 'names', [{ points: [[1, 1]] }])).status, 200);
    } finally {
      await fresh.close();
    }
  });

  it('STORAGE_TOWNS=off: "this box has no town list"; so does a list that cannot be read', async () => {
    assert.equal(configFromEnv({ STORAGE_TOWNS: 'off' }).towns, 'off');
    assert.equal(configFromEnv({ STORAGE_TOWNS: ' OFF ' }).towns, 'off');
    assert.equal(configFromEnv({}).towns, DEFAULT_TOWNS);
    assert.equal(configFromEnv({ STORAGE_TOWNS: '/x/t.tsv.gz' }).towns, '/x/t.tsv.gz');
    const gone = tempDir();
    rmSync(gone, { recursive: true });
    for (const towns of ['off', join(gone, 'missing.tsv.gz')]) {
      const lines: string[] = [];
      const o = await box({ towns, log: (l) => lines.push(l) });
      try {
        await o.run.towns?.load();
        assert.deepEqual((await call(o, o.owner, 'names', [{ points: [[1, 1]] }])).json, { error: 'this box has no town list' });
        if (towns !== 'off') assert.ok(lines.some((l) => /could not read the town list/.test(l)));
      } finally {
        await o.close();
      }
    }
  });

  it('a call while the list is loading: "the town list is still loading"', async () => {
    const loading = new Towns(FIXTURE); // never loaded
    const o = await box({ towns: FIXTURE, log: () => {} }, { start: { towns: loading } });
    try {
      assert.deepEqual((await call(o, o.owner, 'names', [{ points: [[1, 1]] }])).json, { error: 'the town list is still loading' });
      await loading.load();
      assert.equal((await call(o, o.owner, 'names', [{ points: [[38.57, -109.55]] }])).json.result.names[0].town, 'Moab');
    } finally {
      await o.close();
    }
  });
});

describe('8. log lines', () => {
  it('name the method and counts, never coordinates, note bytes or keys', async () => {
    const s = await setup({ towns: FIXTURE });
    const m = key();
    try {
      s.list({ members: [m] });
      await s.b.run.home!.sync();
      await s.b.run.towns!.load();
      const note = randomBytes(3000);
      const from = s.logs.length;
      assert.equal((await call(s.b, m, 'names', [{ points: [[38.5733, -109.5498], [51.1784, -115.5708]] }])).status, 200);
      assert.equal((await call(s.b, m, 'put', [b64(note)])).status, 200);
      assert.equal((await call(s.b, m, 'get', [[sha(note)]])).status, 200);
      assert.equal((await call(s.b, m, 'members', [[m.pk]])).status, 200);
      assert.equal((await call(s.b, m, 'drop', [[sha(note)]])).status, 200);
      const lines = s.logs.slice(from);
      assert.deepEqual(lines, [
        'places: names 2 points, 2 named', 'places: put 1 note', 'places: get 1 asked, 1 found',
        'places: members 1 asked, 1 on the box', 'places: drop 1 asked, 1 dropped',
      ]);
      const all = lines.join('\n');
      for (const bad of ['38.5', '109.5', '38.57', '51.1', '115.5', 'Moab', b64(note).slice(0, 12), sha(note).slice(0, 12), m.pk.slice(0, 12)]) {
        assert.ok(!all.includes(bad), bad);
      }
    } finally {
      await s.close();
    }
  });
});

describe('9. a 0.5.0 database', () => {
  it('opens and migrates; open uploads and blobs are untouched', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'storage.db');
      let db = new Db(file);
      const owner = key();
      db.putAccount(owner.pk, null, 1);
      db.own(sha('a blob'), 1234, 'image/jpeg', owner.pk, 5);
      const r = db.openUpload(owner.pk, { id: 'f'.repeat(32), sha256: sha('big'), size: 9_000_000, type: 'video/mp4', pieceSize: 8 * 1024 * 1024, created: 7, touched: 8 }, () => null);
      assert.ok(r.ok);
      db.markPiece('f'.repeat(32), 0, 8 * 1024 * 1024, 9);
      // back to how 0.5.0 left it
      db.sql.exec('DROP TABLE place_notes; PRAGMA user_version = 7;');
      const blobsBefore = db.sql.prepare('SELECT * FROM blobs').all();
      const uploadsBefore = db.sql.prepare('SELECT * FROM uploads').all();
      const piecesBefore = db.sql.prepare('SELECT * FROM upload_pieces').all();
      db.close();
      db = new Db(file);
      assert.equal(Number(db.sql.prepare('PRAGMA user_version').get()!.user_version), 8);
      assert.ok(db.sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'place_notes'").get());
      assert.ok(db.sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'place_notes_account'").get());
      assert.deepEqual(db.sql.prepare('SELECT * FROM blobs').all(), blobsBefore);
      assert.deepEqual(db.sql.prepare('SELECT * FROM uploads').all(), uploadsBefore);
      assert.deepEqual(db.sql.prepare('SELECT * FROM upload_pieces').all(), piecesBefore);
      assert.equal(db.putNote(sha('n'), owner.pk, new Uint8Array([1, 2, 3]), 10), true);
      assert.deepEqual([...db.getNotes([sha('n')]).values()].map((b) => [...b]), [[1, 2, 3]]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
