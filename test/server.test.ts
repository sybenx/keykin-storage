import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { parseRange } from '../src/server.ts';
import { auth, box, DOMAIN, key, origin, put, sha, type Box } from './helpers.ts';

const DAY = 86400;

describe('upload and get (BUD-01, 02)', () => {
  let b: Box;
  before(async () => { b = await box(); });
  after(() => b.close());

  it('stores a blob, answers 201 then 200, serves it back', async () => {
    const body = randomBytes(5000);
    const r1 = await put(b, b.owner, body);
    assert.equal(r1.status, 201);
    const d = await r1.json() as any;
    assert.equal(d.sha256, sha(body));
    assert.equal(d.size, 5000);
    assert.equal(d.url, `https://${DOMAIN}/${sha(body)}.bin`);
    assert.equal((await put(b, b.owner, body)).status, 200);

    const g = await fetch(`${b.url}/${sha(body)}.png`); // extension ignored
    assert.equal(g.status, 200);
    assert.deepEqual(Buffer.from(await g.arrayBuffer()), body);
    assert.equal(g.headers.get('content-type'), 'application/octet-stream');
    assert.equal(g.headers.get('access-control-allow-origin'), '*');
    assert.match(g.headers.get('content-security-policy')!, /sandbox/);

    const h = await fetch(`${b.url}/${sha(body)}`, { method: 'HEAD' });
    assert.equal(h.status, 200);
    assert.equal(h.headers.get('content-length'), '5000');
    assert.equal(h.headers.get('accept-ranges'), 'bytes');
  });

  it('serves ranges', async () => {
    const body = randomBytes(1000);
    await put(b, b.owner, body);
    const r = await fetch(`${b.url}/${sha(body)}`, { headers: { range: 'bytes=10-19' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 10-19/1000');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), body.subarray(10, 20));
    const s = await fetch(`${b.url}/${sha(body)}`, { headers: { range: 'bytes=-5' } });
    assert.deepEqual(Buffer.from(await s.arrayBuffer()), body.subarray(995));
    const bad = await fetch(`${b.url}/${sha(body)}`, { headers: { range: 'bytes=2000-' } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), 'bytes */1000');
  });

  it('keeps a sane content type and drops a bad one', async () => {
    const a = randomBytes(100), c = randomBytes(100);
    await put(b, b.owner, a, {}, { 'content-type': 'image/png; charset=x' });
    await put(b, b.owner, c, {}, { 'content-type': 'text/html<script>' });
    assert.equal((await fetch(`${b.url}/${sha(a)}`)).headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${b.url}/${sha(c)}`)).headers.get('content-type'), 'application/octet-stream');
  });

  it('404s what it does not have', async () => {
    assert.equal((await fetch(`${b.url}/${sha('nope')}`)).status, 404);
    assert.equal((await fetch(`${b.url}/media`, { method: 'PUT' })).status, 404);
  });

  it('answers CORS preflight', async () => {
    const r = await fetch(`${b.url}/upload`, { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.match(r.headers.get('access-control-allow-headers')!, /Authorization/);
    assert.match(r.headers.get('access-control-allow-methods')!, /DELETE/);
  });
});

describe('who may write (BUD-11)', () => {
  let b: Box;
  before(async () => { b = await box(); });
  after(() => b.close());
  const body = randomBytes(64);

  const refused = async (extra: Parameters<typeof put>[3], status: number, k = b.owner) => {
    const r = await put(b, k, body, extra);
    assert.equal(r.status, status, `${r.status} ${r.headers.get('x-reason')}`);
    assert.ok(r.headers.get('x-reason'));
  };

  it('refuses a stranger', () => refused({}, 403, key()));
  it('refuses a bad signature', () => refused({ tamper: true }, 401));
  it('refuses an expired token', () => refused({ expiration: b.clock.now - 1 }, 401));
  it('refuses a token with no expiration', () => refused({ expiration: null }, 401));
  it('refuses a token from the future', () => refused({ createdAt: b.clock.now + 3600 }, 401));
  it('refuses the wrong verb', () => refused({ t: 'delete' }, 401));
  it('refuses a token with no server tag', () => refused({ server: null }, 401));
  it('refuses a token for another server', () => refused({ server: ['other.example'] }, 401));
  it('refuses a token with no x tag', () => refused({ x: [] }, 401));
  it('refuses a body that is not the x tag, and keeps nothing', async () => {
    await refused({ x: [sha('something else')] }, 403);
    assert.equal((await fetch(`${b.url}/${sha(body)}`)).status, 404);
  });
  it('refuses a body that is not x-sha-256', async () => {
    const other = sha('other');
    const r = await fetch(`${b.url}/upload`, {
      method: 'PUT', body,
      headers: { authorization: auth(b.owner, { t: 'upload', x: [sha(body), other], now: b.clock.now }), 'x-sha-256': other },
    });
    assert.equal(r.status, 409);
  });
  it('refuses a blob over the size cap', async () => {
    assert.equal((await put(b, b.owner, randomBytes(1024 * 1024 + 1))).status, 413);
  });
});

describe('quotas', () => {
  let b: Box;
  before(async () => { b = await box(); });
  after(() => b.close());

  it('holds a friend to their quota, charges each account once, and not the owner', async () => {
    const friend = key(), other = key();
    b.run.db.putAccount(friend.pk, 30_000, b.clock.now);
    b.run.db.putAccount(other.pk, 30_000, b.clock.now);
    const a = randomBytes(20_000), c = randomBytes(20_000);
    assert.equal((await put(b, friend, a)).status, 201);
    assert.equal((await put(b, friend, a)).status, 200); // already theirs: free
    assert.equal((await put(b, friend, c)).status, 413);
    assert.equal(b.run.db.usage(friend.pk), 20_000);
    assert.equal((await put(b, other, a)).status, 200); // same bytes, other account: charged to them too
    assert.equal(b.run.db.usage(other.pk), 20_000);
    assert.equal((await put(b, b.owner, randomBytes(900_000))).status, 201);
  });

  it('answers the preflight the way the upload would (BUD-06)', async () => {
    const friend = key();
    b.run.db.putAccount(friend.pk, 10_000, b.clock.now);
    const pre = (k = friend, size = 5000, x = sha('p')) => fetch(`${b.url}/upload`, {
      method: 'HEAD',
      headers: { authorization: auth(k, { t: 'upload', x: [x], now: b.clock.now }), 'x-sha-256': x, 'x-content-length': String(size) },
    });
    assert.equal((await pre()).status, 200);
    assert.equal((await pre(friend, 15_000)).status, 413);
    assert.equal((await pre(key())).status, 403);
    const noLen = await fetch(`${b.url}/upload`, { method: 'HEAD', headers: { authorization: auth(friend, { t: 'upload', x: [sha('p')], now: b.clock.now }), 'x-sha-256': sha('p') } });
    assert.equal(noLen.status, 411);
  });
});

describe('delete, the bin and the vault probe (BUD-12, vaults §6.4)', () => {
  let b: Box;
  let src: Awaited<ReturnType<typeof origin>>;
  const blob = randomBytes(3000);
  before(async () => {
    b = await box({ mirrorAllowPrivate: true });
    src = await origin({ '/blob': (res) => res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(blob) });
  });
  after(async () => { await b.close(); await src.close(); });

  const del = (k: typeof b.owner, x: string) =>
    fetch(`${b.url}/${x}`, { method: 'DELETE', headers: { authorization: auth(k, { t: 'delete', x: [x], now: b.clock.now }) } });
  const mirror = (k: typeof b.owner, url: string, x = sha(blob)) =>
    fetch(`${b.url}/mirror`, { method: 'PUT', body: JSON.stringify({ url }), headers: { authorization: auth(k, { t: 'upload', x: [x], now: b.clock.now }) } });
  const got = async () => (await fetch(`${b.url}/${sha(blob)}`)).status;

  it('passes the probe: one key deleting leaves the other key\'s copy', async () => {
    const A = key(), B = key();
    b.run.db.putAccount(A.pk, null, b.clock.now);
    b.run.db.putAccount(B.pk, null, b.clock.now);
    assert.equal((await put(b, A, blob)).status, 201);
    assert.equal((await mirror(B, `${src.url}/blob`)).status, 200);
    assert.equal((await del(B, sha(blob))).status, 204);
    assert.equal(await got(), 200);
    assert.equal((await mirror(B, `${src.url}/blob`)).status, 200);
    assert.equal((await del(A, sha(blob))).status, 204);
    assert.equal(await got(), 200);
    assert.equal((await del(B, sha(blob))).status, 204);
    // nobody owns it now: in the bin, still served, erased after 30 days
    assert.equal(await got(), 200);
    assert.equal(b.run.db.binned().length, 1);
    assert.equal((await del(B, sha(blob))).status, 404);
  });

  it('takes a blob back out of the bin on upload, erases it after 30 days otherwise', async () => {
    const x = randomBytes(100);
    await put(b, b.owner, x);
    assert.equal((await del(b.owner, sha(x))).status, 204);
    b.clock.now += 10 * DAY;
    assert.equal((await put(b, b.owner, x)).status, 200);
    assert.equal(b.run.db.blob(sha(x))!.binned, null);
    assert.equal((await del(b.owner, sha(x))).status, 204);
    b.clock.now += 29 * DAY;
    assert.equal(b.run.sweep(), 1); // the probe blob, binned 39 days ago
    assert.equal((await fetch(`${b.url}/${sha(x)}`)).status, 200);
    b.clock.now += 2 * DAY;
    assert.equal(b.run.sweep(), 1);
    assert.equal((await fetch(`${b.url}/${sha(x)}`)).status, 404);
  });

  it('refuses a delete that does not name the blob', async () => {
    const x = randomBytes(10);
    await put(b, b.owner, x);
    const r = await fetch(`${b.url}/${sha(x)}`, { method: 'DELETE', headers: { authorization: auth(b.owner, { t: 'delete', x: [sha('other')], now: b.clock.now }) } });
    assert.equal(r.status, 401);
  });
});

describe('mirror (BUD-04)', () => {
  let b: Box, open: Box;
  let src: Awaited<ReturnType<typeof origin>>;
  const blob = randomBytes(2048);
  before(async () => {
    b = await box();
    open = await box({ mirrorAllowPrivate: true });
    src = await origin({
      '/blob': (res) => res.writeHead(200, { 'content-type': 'image/webp' }).end(blob),
      '/hop': (res) => res.writeHead(302, { location: '/blob' }).end(),
      '/loop': (res) => res.writeHead(302, { location: '/loop' }).end(),
      '/wrong': (res) => res.writeHead(200).end(randomBytes(2048)),
      '/big': (res) => res.writeHead(200).end(randomBytes(1024 * 1024 + 10)),
    });
  });
  after(async () => { await b.close(); await open.close(); await src.close(); });

  const mirror = (on: Box, path: string, x = sha(blob)) =>
    fetch(`${on.url}/mirror`, { method: 'PUT', body: JSON.stringify({ url: src.url + path }), headers: { authorization: auth(on.owner, { t: 'upload', x: [x], now: on.clock.now }) } });

  it('refuses to fetch from loopback or private addresses', async () => {
    const r = await mirror(b, '/blob');
    assert.equal(r.status, 400);
    assert.match(r.headers.get('x-reason')!, /private/);
    for (const url of ['http://localhost/x', 'http://[::1]/x', 'http://169.254.169.254/x', 'http://100.100.100.100/x', 'file:///etc/passwd']) {
      const s = await fetch(`${b.url}/mirror`, { method: 'PUT', body: JSON.stringify({ url }), headers: { authorization: auth(b.owner, { t: 'upload', x: [sha(blob)], now: b.clock.now }) } });
      assert.equal(s.status, 400, url);
    }
  });

  it('fetches, follows a redirect, keeps the source type', async () => {
    const r = await mirror(open, '/hop');
    assert.equal(r.status, 201);
    const d = await r.json() as any;
    assert.equal(d.type, 'image/webp');
    assert.equal(d.url.endsWith('.webp'), true);
  });

  it('refuses bytes that are not the x tag, redirect loops and blobs over the cap', async () => {
    assert.equal((await mirror(open, '/wrong', sha('x'))).status, 409);
    assert.equal((await mirror(open, '/loop', sha('y'))).status, 502);
    assert.equal((await mirror(open, '/big', sha('z'))).status, 413);
  });
});

describe('list (BUD-12)', () => {
  let b: Box;
  before(async () => { b = await box(); });
  after(() => b.close());

  it('lists only your own, newest first, in pages', async () => {
    const shas: string[] = [];
    for (let i = 0; i < 5; i++) {
      const x = randomBytes(10);
      await put(b, b.owner, x);
      shas.push(sha(x));
      b.clock.now += 1;
    }
    const list = (k = b.owner, q = '') => fetch(`${b.url}/list/${b.owner.pk}${q}`, { headers: { authorization: auth(k, { t: 'list', now: b.clock.now }) } });
    const all = await (await list()).json() as any;
    assert.deepEqual(all.map((d: any) => d.sha256), [...shas].reverse());
    const p1 = await (await list(b.owner, '?limit=2')).json() as any;
    const p2 = await (await list(b.owner, `?limit=2&cursor=${p1[1].sha256}`)).json() as any;
    assert.deepEqual([...p1, ...p2].map((d: any) => d.sha256), [...shas].reverse().slice(0, 4));
    assert.equal((await list(key())).status, 403);
  });
});

describe('parseRange', () => {
  it('reads one range', () => {
    assert.deepEqual(parseRange('bytes=0-0', 10), [0, 0]);
    assert.deepEqual(parseRange('bytes=5-', 10), [5, 9]);
    assert.deepEqual(parseRange('bytes=5-100', 10), [5, 9]);
    assert.deepEqual(parseRange('bytes=-3', 10), [7, 9]);
    assert.equal(parseRange('bytes=10-', 10), 'bad');
    assert.equal(parseRange('bytes=0-1,3-4', 10), null);
    assert.equal(parseRange(undefined, 10), null);
  });
});

describe('review fixes (2026-11-21)', () => {
  let b: Box;
  let src: Awaited<ReturnType<typeof origin>>;
  const served = randomBytes(700);
  before(async () => {
    b = await box({ mirrorAllowPrivate: true });
    src = await origin({ '/b': (res) => res.writeHead(200).end(served) });
  });
  after(async () => { await b.close(); await src.close(); });

  const del = (k: typeof b.owner, x: string) =>
    fetch(`${b.url}/${x}`, { method: 'DELETE', headers: { authorization: auth(k, { t: 'delete', x: [x], now: b.clock.now }) } });
  const mirror = (k: typeof b.owner, path: string, xs: string[]) =>
    fetch(`${b.url}/mirror`, { method: 'PUT', body: JSON.stringify({ url: src.url + path }), headers: { authorization: auth(k, { t: 'upload', x: xs, now: b.clock.now }) } });

  it('keeps what a friend binned on their quota, so delete-and-upload cannot fill the disk', async () => {
    const friend = key();
    b.run.db.putAccount(friend.pk, 10_000, b.clock.now);
    const one = randomBytes(9000), two = randomBytes(9000);
    assert.equal((await put(b, friend, one)).status, 201);
    assert.equal((await del(friend, sha(one))).status, 204);
    assert.equal(b.run.db.usage(friend.pk), 9000);
    assert.equal((await put(b, friend, two)).status, 413);
    assert.equal((await put(b, friend, one)).status, 200); // its own binned blob comes back at no cost
    assert.equal(b.run.db.usage(friend.pk), 9000);
  });

  it('does not let an account claim a blob it never had by mirroring its hash', async () => {
    const thief = key();
    b.run.db.putAccount(thief.pk, null, b.clock.now);
    const mine = randomBytes(300);
    await put(b, b.owner, mine);
    // url serves other bytes: fetched and refused, no ownership taken
    assert.equal((await mirror(thief, '/b', [sha(mine)])).status, 409);
    assert.equal((await del(b.owner, sha(mine))).status, 204);
    assert.notEqual(b.run.db.blob(sha(mine))!.binned, null);
  });

  it('with several x tags, stores what the url serves', async () => {
    const other = randomBytes(50);
    await put(b, b.owner, other);
    const r = await mirror(b.owner, '/b', [sha(other), sha(served)]);
    assert.equal(r.status, 201);
    assert.equal(((await r.json()) as any).sha256, sha(served));
  });

  it('refuses a key whose account went away while its body was coming in', async () => {
    const friend = key();
    b.run.db.putAccount(friend.pk, null, b.clock.now);
    const body = randomBytes(1000);
    const req = (await import('node:http')).request(`${b.url}/upload`, {
      method: 'PUT', headers: { authorization: auth(friend, { t: 'upload', x: [sha(body)], now: b.clock.now }), 'content-length': '1000' },
    });
    const res = new Promise<number>((r) => req.on('response', (m) => { m.resume(); r(m.statusCode!); }));
    req.write(body.subarray(0, 500));
    await new Promise((r) => setTimeout(r, 50));
    b.run.db.removeAccount(friend.pk, b.clock.now);
    req.end(body.subarray(500));
    assert.equal(await res, 403);
    assert.equal(b.run.db.blob(sha(body)), null);
  });

  it('caps uploads in flight per account', async () => {
    const http = await import('node:http');
    const open = [] as import('node:http').ClientRequest[];
    const answers: Promise<number>[] = [];
    for (let i = 0; i < 5; i++) {
      const body = randomBytes(100);
      const req = http.request(`${b.url}/upload`, {
        method: 'PUT', headers: { authorization: auth(b.owner, { t: 'upload', x: [sha(body)], now: b.clock.now }), 'content-length': '100' },
      });
      answers.push(new Promise((r) => { req.on('response', (m) => { m.resume(); r(m.statusCode!); }); req.on('error', () => r(-1)); }));
      req.write(body.subarray(0, 10));
      req.flushHeaders();
      open.push(req);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(await answers[4], 429);
    for (const r of open) r.destroy();
    await Promise.all(answers.slice(0, 4));
  });
});

describe('the mirror guard', () => {
  it('blocks IPv4-compatible IPv6 and the usual private ranges', async () => {
    const { isBlockedAddress } = await import('../src/mirror.ts');
    for (const ip of ['::7f00:1', '::127.0.0.1', '::1', '::', '127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.169.254', '192.168.1.1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
    for (const ip of ['1.1.1.1', '2606:4700:4700::1111']) assert.equal(isBlockedAddress(ip), false, ip);
  });
});
