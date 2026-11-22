// Accounts that follow a home's member list, against a fake home on a loopback port.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import type { Config } from '../src/config.ts';
import { npub } from '../src/keys.ts';
import { serviceKey, SERVICE_KEY_FILE } from '../src/servicekey.ts';
import { auth, box, cli, fakeHome, key, put, sha, tempDir, type Box, type FakeHome, type Key } from './helpers.ts';

const DAY = 86400;
const QUOTA = 50_000;

interface Setup {
  b: Box;
  home: FakeHome;
  lines: string[];
  /** Sets what the home answers: its members and removals (owner defaults to the box owner). */
  list(members: Key[], removed?: { k: Key; at: number; reason?: string }[], owner?: string): void;
  close(): Promise<void>;
}

async function setup(over: Partial<Config> = {}, opts: { dir?: string; owner?: Key; registered?: () => string } = {}): Promise<Setup> {
  const dir = opts.dir ?? tempDir();
  const sk = serviceKey(dir); // made before the box starts, so the fake home can "register" it
  const owner = opts.owner ?? key();
  const clock = { now: Math.floor(Date.now() / 1000) };
  const home = await fakeHome(opts.registered ?? (() => sk.pk), () => clock.now);
  const lines: string[] = [];
  const list = (members: Key[], removed: { k: Key; at: number; reason?: string }[] = [], o = owner.pk) => {
    home.reply = () => ({ status: 200, body: { result: {
      owner: o, members: members.map((m) => m.pk).sort(),
      removed: removed.map((r) => ({ pubkey: r.k.pk, removedAt: r.at, deletesAt: r.at + 30 * DAY, reason: r.reason ?? 'removed' })),
    } } });
  };
  list([]);
  const b = await box({ homeUrl: home.url, memberQuota: QUOTA, homePollS: 3600, log: (l) => lines.push(l), now: () => clock.now, ...over }, { dir, owner });
  b.clock = clock;
  const s: Setup = { b, home, lines, list, close: async () => { await s.b.close(); await home.close(); } };
  await b.run.home!.sync(); // let the sync at start settle
  return s;
}

const del = (b: Box, k: Key, x: string) =>
  fetch(`${b.url}/${x}`, { method: 'DELETE', headers: { authorization: auth(k, { t: 'delete', x: [x], now: b.clock.now }) } });
const served = async (b: Box, x: Uint8Array) => (await fetch(`${b.url}/${sha(x)}`)).status;

describe('members join, leave and come back', () => {
  let s: Setup;
  const m = key();
  const mine = randomBytes(5000), shared = randomBytes(5000);
  before(async () => { s = await setup(); });
  after(() => s.close());
  afterEach(() => assert.deepEqual(s.home.refused, [], 'every request passed the home\'s checks'));

  it('a member becomes an account with the member quota, marked as from the home', async () => {
    s.list([m]);
    const r = await s.b.run.home!.sync();
    assert.deepEqual(r, { ok: true, joined: 1, left: 0, held: 0 });
    const acc = s.b.run.db.account(m.pk)!;
    assert.equal(acc.quota, QUOTA);
    assert.equal(acc.hand, 0);
    assert.equal(acc.member, 1);
    assert.equal((await put(s.b, m, mine)).status, 201);
    assert.equal((await put(s.b, m, shared)).status, 201);
    assert.equal((await put(s.b, s.b.owner, shared)).status, 200);
    assert.equal((await put(s.b, m, randomBytes(QUOTA))).status, 413);
  });

  it('a removed member can no longer write, and what only it held goes to the bin from removedAt', async () => {
    const at = s.b.clock.now - 2 * DAY;
    s.list([], [{ k: m, at }]);
    const r = await s.b.run.home!.sync();
    assert.deepEqual(r, { ok: true, joined: 0, left: 1, held: 0 });
    assert.equal(s.b.run.db.account(m.pk), null);
    assert.equal((await put(s.b, m, randomBytes(10))).status, 403);
    assert.equal(s.b.run.db.blob(sha(mine))!.binned, at);
    assert.equal(s.b.run.db.blob(sha(shared))!.binned, null); // the owner still holds it
    assert.equal(await served(s.b, mine), 200); // binned blobs are still served
    assert.equal(s.b.run.db.removals()[0].pubkey, m.pk);
  });

  it('a member who comes back before the bin erases gets their blobs back under their name', async () => {
    const before = s.b.run.db.removals()[0];
    s.list([m], [{ k: m, at: before.removedAt }]); // within 14 days the home lists both: members wins
    const r = await s.b.run.home!.sync();
    assert.equal(r.ok && r.joined, 1);
    assert.equal(s.b.run.db.blob(sha(mine))!.binned, null);
    assert.notEqual(s.b.run.db.uploadedAt(sha(mine), m.pk), null);
    assert.notEqual(s.b.run.db.uploadedAt(sha(shared), m.pk), null);
    const acc = s.b.run.db.account(m.pk)!;
    assert.equal(acc.used, s.b.run.db.usage(m.pk));
    assert.equal(acc.blobs, 2);
    assert.equal(s.b.run.db.removals().length, 0);
    assert.equal((await put(s.b, m, randomBytes(10))).status, 201);
  });

  it('after the bin has erased them, a member who comes back starts empty', async () => {
    s.list([], [{ k: m, at: s.b.clock.now }]);
    await s.b.run.home!.sync();
    s.b.clock.now += 31 * DAY;
    s.b.run.sweep();
    assert.equal(await served(s.b, mine), 404);
    s.list([m]);
    await s.b.run.home!.sync();
    assert.equal(s.b.run.db.account(m.pk)!.blobs, 1); // only the shared blob, which the owner kept
  });

  it('records a removal the first time it is seen, and does nothing when it drops off the list', async () => {
    const at = s.b.clock.now - 3600;
    s.list([], [{ k: m, at }]);
    await s.b.run.home!.sync();
    s.list([]); // 14 days later the home stops listing the removal
    const r = await s.b.run.home!.sync();
    assert.deepEqual(r, { ok: true, joined: 0, left: 0, held: 0 });
    assert.equal(s.b.run.db.account(m.pk), null);
    assert.equal(s.b.run.db.removals()[0].removedAt, at);
  });

  it('a member missing from both lists is removed, with the bin starting when it was noticed', async () => {
    const v = key(), x = randomBytes(5000);
    s.list([v]);
    await s.b.run.home!.sync();
    await put(s.b, v, x);
    s.b.clock.now += 10;
    s.list([key()]); // v is in neither list (someone else joined, so the list isn't empty)
    const r = await s.b.run.home!.sync();
    assert.equal(r.ok && r.left, 1);
    assert.equal(s.b.run.db.account(v.pk), null);
    assert.equal(s.b.run.db.blob(sha(x))!.binned, s.b.clock.now);
  });
});

describe('the reason for a removal', () => {
  let s: Setup;
  before(async () => { s = await setup(); });
  after(() => s.close());

  it('"erased" erases now what only that account holds, with no bin; shared blobs stay', async () => {
    const m = key(), alone = randomBytes(5000), shared = randomBytes(5000), binned = randomBytes(5000);
    s.list([m]);
    await s.b.run.home!.sync();
    for (const x of [alone, shared, binned]) assert.equal((await put(s.b, m, x)).status, 201);
    await put(s.b, s.b.owner, shared);
    assert.equal((await del(s.b, m, sha(binned))).status, 204);
    s.list([], [{ k: m, at: s.b.clock.now, reason: 'erased' }]);
    await s.b.run.home!.sync();
    assert.equal(s.b.run.db.account(m.pk), null);
    for (const x of [alone, binned]) {
      assert.equal(s.b.run.db.blob(sha(x)), null);
      assert.equal(existsSync(join(s.b.dir, 'blobs', sha(x).slice(0, 2), sha(x).slice(2, 4), sha(x))), false);
    }
    assert.equal(await served(s.b, shared), 200);
    assert.equal(s.b.run.db.removals().find((r) => r.pubkey === m.pk)!.reason, 'erased');
  });

  it('an unknown reason is a plain removal: to the bin', async () => {
    const m = key(), x = randomBytes(5000);
    s.list([m]);
    await s.b.run.home!.sync();
    await put(s.b, m, x);
    s.list([], [{ k: m, at: s.b.clock.now, reason: 'something-new' }]);
    await s.b.run.home!.sync();
    assert.equal(s.b.run.db.blob(sha(x))!.binned, s.b.clock.now);
    assert.equal(s.b.run.db.removals().find((r) => r.pubkey === m.pk)!.reason, 'removed');
  });
});

describe('a home that fails keeps the last good list', () => {
  let s: Setup;
  const m = key();
  before(async () => {
    s = await setup();
    s.list([m]);
    await s.b.run.home!.sync();
  });
  after(() => s.close());

  const stillMember = async () => {
    assert.equal(s.b.run.db.account(m.pk)?.member, 1);
    assert.equal((await put(s.b, m, randomBytes(10))).status, 201);
  };
  const answer = (status: number, body: unknown) => { s.home.reply = () => ({ status, body }); };
  const status = () => cli(s.b.dir, { STORAGE_HOME_URL: 'https://home.test', STORAGE_OWNER: s.b.owner.pk }, 'home', 'status');

  for (const [name, status_, body, kind] of [
    ['an error reply', 200, { error: 'database is down' }, 'error'],
    ['a reply that is not JSON', 200, '<html>oops</html>', 'malformed'],
    ['a reply with a bad member', 200, { result: { owner: 'x'.repeat(64), members: ['nope'], removed: [] } }, 'malformed'],
    ['a reply with no result', 200, { result: null }, 'malformed'],
    ['a 500', 500, 'down', 'error'],
  ] as const) {
    it(`on ${name}`, async () => {
      answer(status_, body);
      const r = await s.b.run.home!.sync();
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.kind, kind);
      await stillMember();
    });
  }

  it('when the home is unreachable', async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as { port: number }).port;
    await new Promise((r) => dead.close(r)); // nothing listens there now
    const { Home, httpHome } = await import('../src/home.ts');
    const h = new Home(s.b.run.db, httpHome(`http://127.0.0.1:${port}`, s.b.run.serviceKey, { timeoutMs: 2000, now: () => s.b.clock.now }), {
      owner: s.b.owner.pk, memberQuota: QUOTA, pollS: 3600, now: () => s.b.clock.now, log: () => {}, removeFile: () => {},
    });
    const r = await h.sync();
    assert.equal(!r.ok && r.kind, 'unreachable');
    await stillMember();
    assert.match(status(), /could not reach the home/);
  });

  it('when the home does not answer in time', async () => {
    const slow = http.createServer(() => {}); // never answers
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    try {
      const { Home, httpHome } = await import('../src/home.ts');
      const h = new Home(s.b.run.db, httpHome(`http://127.0.0.1:${(slow.address() as { port: number }).port}`, s.b.run.serviceKey, { timeoutMs: 200, now: () => s.b.clock.now }), {
        owner: s.b.owner.pk, memberQuota: QUOTA, pollS: 3600, now: () => s.b.clock.now, log: () => {}, removeFile: () => {},
      });
      const r = await h.sync();
      assert.equal(!r.ok && r.kind, 'unreachable');
      await stillMember();
    } finally {
      slow.closeAllConnections();
      await new Promise((r) => slow.close(r));
    }
  });

  it('when the home refuses the signature, and status says the clock is the likely cause', async () => {
    answer(401, { error: 'auth: created_at too far from now' });
    const r = await s.b.run.home!.sync();
    assert.equal(!r.ok && r.kind, 'refused');
    await stillMember();
    assert.match(status(), /clock/);
  });

  it('when the home says too many requests, and then waits before asking again', async () => {
    answer(429, { error: 'rate limited' });
    const r = await s.b.run.home!.sync();
    assert.equal(!r.ok && r.kind, 'rate-limited');
    await stillMember();
    const calls = s.home.calls;
    s.b.clock.now += 70; // past the miss interval, but still backing off
    await put(s.b, key(), randomBytes(10));
    assert.equal(s.home.calls, calls);
    assert.equal(s.lines.filter((l) => /asked too often/.test(l)).length, 1);
    s.b.clock.now += 120;
    s.list([m]);
    await put(s.b, key(), randomBytes(10));
    assert.equal(s.home.calls, calls + 1);
  });

  it('never follows a redirect', async () => {
    let followed = 0;
    const target = http.createServer((_q, res) => { followed++; res.end('{}'); });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    try {
      const port = (target.address() as { port: number }).port;
      const redirector = http.createServer((_q, res) => res.writeHead(302, { location: `http://127.0.0.1:${port}/` }).end());
      await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
      const { Home, httpHome } = await import('../src/home.ts');
      const h = new Home(s.b.run.db, httpHome(`http://127.0.0.1:${(redirector.address() as { port: number }).port}`, s.b.run.serviceKey, { timeoutMs: 2000, now: () => s.b.clock.now }), {
        owner: s.b.owner.pk, memberQuota: QUOTA, pollS: 3600, now: () => s.b.clock.now, log: () => {}, removeFile: () => {},
      });
      const r = await h.sync();
      redirector.closeAllConnections();
      await new Promise((r) => redirector.close(r));
      assert.equal(!r.ok && r.kind, 'error');
      assert.match(!r.ok ? r.message : '', /redirect/);
      assert.equal(followed, 0);
      await stillMember();
    } finally {
      target.closeAllConnections();
      await new Promise((r) => target.close(r));
    }
  });

  it('refuses a reply over 1 MiB', async () => {
    answer(200, JSON.stringify({ result: { owner: s.b.owner.pk, members: [], removed: [] }, pad: 'x'.repeat(1024 * 1024) }));
    const r = await s.b.run.home!.sync();
    assert.equal(!r.ok && r.kind, 'malformed');
    await stillMember();
  });
});

describe('a home that does not know this storage yet', () => {
  let s: Setup;
  before(async () => { s = await setup({}, { registered: () => key().pk }); });
  after(() => s.close());

  it('keeps the last good list and says so in plain words', async () => {
    const r = await s.b.run.home!.sync();
    assert.equal(!r.ok && r.kind, 'unknown-storage');
    const out = cli(s.b.dir, { STORAGE_HOME_URL: 'https://home.test', STORAGE_OWNER: s.b.owner.pk }, 'home', 'status');
    assert.match(out, /the home does not know this storage yet/);
    assert.match(out, new RegExp(s.b.run.serviceKey.pk));
  });
});

describe('looking up an unknown key', () => {
  let s: Setup;
  before(async () => { s = await setup(); });
  after(() => s.close());

  it('lets a member who just joined write at once', async () => {
    const m = key();
    s.list([m]);
    assert.equal((await put(s.b, m, randomBytes(10))).status, 201);
  });

  it('asks the home at most once a minute, however many strangers try', async () => {
    s.b.clock.now += 61;
    const calls = s.home.calls;
    const rs = await Promise.all(Array.from({ length: 5 }, () => put(s.b, key(), randomBytes(10))));
    assert.deepEqual(rs.map((r) => r.status), [403, 403, 403, 403, 403]);
    assert.equal(s.home.calls, calls + 1);
    for (let i = 0; i < 5; i++) await put(s.b, key(), randomBytes(10), { tamper: true });
    assert.equal(s.home.calls, calls + 1);
    s.b.clock.now += 61;
    await put(s.b, key(), randomBytes(10));
    assert.equal(s.home.calls, calls + 2);
  });
});

describe('a sudden large removal is held', () => {
  let s: Setup;
  const ms = Array.from({ length: 6 }, () => key());
  before(async () => {
    s = await setup();
    s.list(ms);
    await s.b.run.home!.sync();
  });
  after(() => s.close());

  it('holds removing more than half of 4 or more members, logs one line, and applies on home apply', async () => {
    const at = s.b.clock.now - 60;
    s.list(ms.slice(0, 2), ms.slice(2).map((k) => ({ k, at })));
    const r = await s.b.run.home!.sync();
    assert.deepEqual(r, { ok: true, joined: 0, left: 0, held: 4 });
    await s.b.run.home!.sync(); // still held, no second log line
    assert.equal(s.lines.filter((l) => /holding the removal of 4 of 6/.test(l)).length, 1);
    for (const k of ms) assert.equal((await put(s.b, k, randomBytes(10))).status, 201);
    const env = { STORAGE_HOME_URL: 'https://home.test', STORAGE_OWNER: s.b.owner.pk, STORAGE_MEMBER_QUOTA: String(QUOTA) };
    assert.match(cli(s.b.dir, env, 'home', 'status'), /held: +4 removals/);
    assert.match(cli(s.b.dir, env, 'home', 'apply'), /0 joined, 4 left; 2 members/);
    for (const k of ms.slice(2)) assert.equal(s.b.run.db.account(k.pk), null);
    for (const k of ms.slice(0, 2)) assert.equal(s.b.run.db.account(k.pk)?.member, 1);
    assert.equal(s.b.run.db.homeState().held, null);
  });

  it('holds an empty-looking list even for a short one', async () => {
    const r = await (async () => { s.list([]); return s.b.run.home!.sync(); })();
    assert.deepEqual(r, { ok: true, joined: 0, left: 0, held: 2 });
    assert.equal(s.b.run.db.members().length, 2);
  });

  it('lets a small explicit removal through', async () => {
    s.list(ms.slice(0, 1), [{ k: ms[1], at: s.b.clock.now }]);
    const r = await s.b.run.home!.sync();
    assert.deepEqual(r, { ok: true, joined: 0, left: 1, held: 0 });
  });
});

describe('accounts added by hand', () => {
  let s: Setup;
  const handMember = key(), handOnly = key(), memberOnly = key();
  let dir: string, owner: Key;
  before(async () => {
    s = await setup();
    dir = s.b.dir;
    owner = s.b.owner;
    s.b.run.db.putAccount(handMember.pk, 77_777, s.b.clock.now);
    s.b.run.db.putAccount(handOnly.pk, 88_888, s.b.clock.now);
  });
  after(() => s.close());

  it('keep their own quota when they are also members, and keep working when removed from the home', async () => {
    s.list([handMember, memberOnly]);
    await s.b.run.home!.sync();
    assert.equal(s.b.run.db.account(handMember.pk)!.quota, 77_777);
    assert.equal(s.b.run.db.account(handMember.pk)!.member, 1);
    assert.equal(s.b.run.db.account(handOnly.pk)!.member, 0);
    s.list([memberOnly], [{ k: handMember, at: s.b.clock.now }]);
    await s.b.run.home!.sync();
    const acc = s.b.run.db.account(handMember.pk)!;
    assert.equal(acc.quota, 77_777);
    assert.equal(acc.member, 0);
    assert.equal((await put(s.b, handMember, randomBytes(10))).status, 201);
    assert.equal(s.b.run.db.account(handOnly.pk)!.quota, 88_888);
  });

  it('with the home setting gone, hand-made accounts work, members cannot write, and nothing is deleted', async () => {
    assert.equal((await put(s.b, memberOnly, randomBytes(10))).status, 201);
    const calls = s.home.calls;
    await s.b.run.close(); // stop it, keep its folder
    const b = await box({ homeUrl: '' }, { dir, owner });
    try {
      assert.equal(b.run.home, null);
      assert.equal((await put(b, handOnly, randomBytes(10))).status, 201);
      assert.equal((await put(b, handMember, randomBytes(10))).status, 201);
      assert.equal((await put(b, memberOnly, randomBytes(10))).status, 403);
      assert.notEqual(b.run.db.account(memberOnly.pk), null); // still there for when the home comes back
      assert.equal(s.home.calls, calls);
    } finally {
      await b.run.close(); // keep the folder: s.close() removes it
      s.b = await box({ homeUrl: s.home.url, memberQuota: QUOTA, homePollS: 3600 }, { dir, owner });
    }
  });
});

describe("the home's owner", () => {
  it('is unlimited when it is this box owner, and a member when it is someone else', async () => {
    const s = await setup();
    try {
      s.list([]);
      await s.b.run.home!.sync();
      assert.equal(s.b.run.db.account(s.b.owner.pk)!.quota, null);
      assert.equal(s.b.run.db.account(s.b.owner.pk)!.member, 0);
      const other = key();
      s.list([], [], other.pk);
      await s.b.run.home!.sync();
      assert.equal(s.b.run.db.account(other.pk)!.quota, QUOTA);
      assert.equal((await put(s.b, other, randomBytes(10))).status, 201);
    } finally {
      await s.close();
    }
  });
});

describe('the service key', () => {
  it('is made once with 0600 permissions, shown by home key as hex and npub, never logged', async (t) => {
    const printed: string[] = [];
    t.mock.method(console, 'log', (...a: unknown[]) => printed.push(a.join(' ')));
    const s = await setup();
    try {
      const file = join(s.b.dir, SERVICE_KEY_FILE);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      const secret = readFileSync(file, 'utf8').trim();
      assert.equal(serviceKey(s.b.dir).pk, s.b.run.serviceKey.pk); // the same key on every start
      const out = cli(s.b.dir, 'home', 'key');
      assert.match(out, new RegExp(s.b.run.serviceKey.pk));
      assert.ok(out.includes(npub(s.b.run.serviceKey.pk)));
      assert.ok(!out.includes(secret));
      assert.ok(![...printed, ...s.lines].some((l) => l.includes(secret)));
    } finally {
      await s.close();
    }
  });

  it("signs requests the home accepts, and a wrong body's hash is refused by the home", async () => {
    const s = await setup();
    try {
      s.list([]);
      assert.equal((await s.b.run.home!.sync()).ok, true);
      assert.deepEqual(s.home.refused, []);
      const { signRequest, REQUEST_BODY } = await import('../src/home.ts');
      const r = await fetch(`${s.home.url}/`, {
        method: 'POST', body: REQUEST_BODY + ' ',
        headers: { 'content-type': 'application/nostr+json+rpc', authorization: signRequest(`${s.home.url}/`, REQUEST_BODY, s.b.run.serviceKey, s.b.clock.now) },
      });
      assert.equal(r.status, 401);
      assert.deepEqual(s.home.refused, ['payload hash is wrong']);
    } finally {
      await s.close();
    }
  });
});

describe('home settings', () => {
  it('want an https url, a size for the member quota and a positive poll interval', async () => {
    const { configFromEnv } = await import('../src/config.ts');
    assert.equal(configFromEnv({}).homeUrl, '');
    assert.equal(configFromEnv({ STORAGE_HOME_URL: 'https://home.example/' }).homeUrl, 'https://home.example');
    assert.throws(() => configFromEnv({ STORAGE_HOME_URL: 'http://home.example' }), /STORAGE_HOME_URL/);
    assert.throws(() => configFromEnv({ STORAGE_HOME_URL: 'https://u:p@home.example' }), /STORAGE_HOME_URL/);
    assert.equal(configFromEnv({ STORAGE_MEMBER_QUOTA: '5G' }).memberQuota, 5e9);
    assert.throws(() => configFromEnv({ STORAGE_MEMBER_QUOTA: 'lots' }), /STORAGE_MEMBER_QUOTA/);
    assert.equal(configFromEnv({}).homePollS, 300);
    assert.throws(() => configFromEnv({ STORAGE_HOME_POLL_S: '5m' }), /STORAGE_HOME_POLL_S/);
  });
});
