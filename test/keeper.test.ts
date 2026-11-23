// The group keeper (src/keeper.ts) against a fake home that answers the group calls the way bothy's
// src/home-groups.ts does, and NIP-44 pinned to the vectors bothy checks against nostr-tools.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/auth.ts';
import { envelopePlain, parseEnvelope, type HomeRpc } from '../src/keeper.ts';
import { conversationKey, nip44Decrypt, nip44Encrypt } from '../src/nip44.ts';
import { start, type Running } from '../src/server.ts';
import { serviceKey } from '../src/servicekey.ts';
import { DOMAIN, key, tempDir, type Key } from './helpers.ts';

const hex = (k: Key) => Buffer.from(k.sk).toString('hex');

describe('nip44', () => {
  it('matches the vectors bothy pins from nostr-tools', () => {
    const conv = conversationKey('0000000000000000000000000000000000000000000000000000000000000001',
      'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5');
    assert.equal(Buffer.from(conv).toString('hex'), 'c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d');
    const nonce = Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex');
    assert.equal(nip44Encrypt('a', conv, nonce),
      'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb');
    assert.equal(nip44Decrypt(nip44Encrypt('hello group', conv), conv), 'hello group');
  });
});

/** One group on a fake home, with what the keeper did to it. */
function fakeGroupHome(boxPk: string, ana: Key, ben: Key, carol: Key) {
  const gid = 'ab'.repeat(16);
  const k1 = Uint8Array.from(randomBytes(32));
  const blobFor = (from: Key, to: string, epoch: number, k: Uint8Array) =>
    nip44Encrypt(envelopePlain(gid, epoch, k), conversationKey(hex(from), to));
  const state = {
    gid, k1,
    epoch: 1, version: 2, needsKey: false, keptSeq: 0,
    members: [ana.pk, ben.pk, carol.pk],
    // Ana made epoch 1 and sealed it to the box; Carol joined later and is owed it.
    owed: [{ pubkey: carol.pk, epochs: [1] }],
    events: [1, 2, 3].map((seq) => ({ seq, storedAt: 1000 + seq, event: { id: String(seq).repeat(64).slice(0, 64), kind: 1490, tags: [['h', gid]], content: 'sealed' } })),
    sealed: [] as any[], kept: [] as number[], changes: [] as any[],
    boxEnvelope: blobFor(ana, boxPk, 1, k1),
  };
  const rpc: HomeRpc = {
    async call(method, params) {
      switch (method) {
        case 'keepergroups':
          return [{
            gid, version: state.version, epoch: state.epoch, needsKey: state.needsKey, lastSeq: state.events.at(-1)!.seq,
            keptSeq: state.keptSeq, history: true, members: state.members.map((pubkey) => ({ pubkey, fromSeq: 1, joinEpoch: 1 })),
            owed: state.owed,
          }];
        case 'groupkeys':
          return (params[1] as number) < 1 ? [{ epoch: 1, from: ana.pk, blob: state.boxEnvelope }] : [];
        case 'groupseal':
          state.sealed.push(...(params[1] as any[]));
          state.owed = [];
          return { sealed: (params[1] as any[]).length };
        case 'groupsince':
          return state.events.filter((e) => e.seq > (params[1] as number));
        case 'groupkept':
          state.kept.push(params[1] as number);
          state.keptSeq = params[1] as number;
          return { kept: params[1] };
        case 'groupchange':
          state.changes.push(params);
          state.epoch++;
          state.version++;
          state.needsKey = false;
          return { version: state.version, epoch: state.epoch };
        case 'groupinfo':
          return { settings: { history: true }, members: state.members.map((pubkey) => ({ pubkey, fromSeq: 1 })) };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { state, rpc };
}

describe('the group keeper', () => {
  const dirs: string[] = [];
  const runs: Running[] = [];
  after(async () => {
    for (const r of runs) await r.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  async function boxWith(rpcFor: (boxPk: string) => HomeRpc) {
    const dir = tempDir();
    dirs.push(dir);
    const sk = serviceKey(dir);
    const clock = { now: Math.floor(Date.now() / 1000) };
    const run = await start({
      dataDir: dir, host: '127.0.0.1', port: 0, publicUrl: `https://${DOMAIN}`, domains: [DOMAIN], owner: key().pk,
      maxBlobBytes: 1024 * 1024, maxBlobsPerAccount: 200_000, binDays: 30, mirrorTimeoutMs: 5000, diskMarginBytes: 0,
      behindCloudflare: false, homeUrl: 'http://127.0.0.1:9', memberQuota: 5e9, homePollS: 300, now: () => clock.now,
    }, { homeRpc: rpcFor(sk.pk), noKeeperStart: true, homeSource: { fetch: async () => ({ owner: key().pk, members: [], removed: [], admins: [] }) } });
    runs.push(run);
    return { run, sk, clock };
  }

  it('opens its envelope, seals the earlier key to a new member, backs up and reports what it kept', async () => {
    const ana = key(), ben = key(), carol = key();
    let fake!: ReturnType<typeof fakeGroupHome>;
    const { run, sk } = await boxWith((pk) => (fake = fakeGroupHome(pk, ana, ben, carol)).rpc);
    await run.keeper!.cycle();
    const { state } = fake;
    assert.equal(state.sealed.length, 1);
    const s = state.sealed[0];
    assert.equal(s.to, carol.pk);
    assert.equal(s.epoch, 1);
    // Carol opens it with the box's public key, and it is this group's epoch 1 key.
    const opened = parseEnvelope(nip44Decrypt(s.blob, conversationKey(hex(carol), sk.pk)), state.gid, 1);
    assert.deepEqual(opened, state.k1);
    assert.deepEqual(state.kept, [3]);
    // A second look owes nothing and keeps nothing new.
    await run.keeper!.cycle();
    assert.equal(state.sealed.length, 1);
    assert.deepEqual(state.kept, [3]);
  });

  it('makes the new key after a leave, sealed to everyone still in and to itself, signed by the box', async () => {
    const ana = key(), ben = key(), carol = key();
    let fake!: ReturnType<typeof fakeGroupHome>;
    const { run, sk } = await boxWith((pk) => (fake = fakeGroupHome(pk, ana, ben, carol)).rpc);
    fake.state.needsKey = true;
    fake.state.members = [ana.pk, ben.pk];
    fake.state.owed = [];
    await run.keeper!.cycle();
    const [gid, version, change, env] = fake.state.changes[0];
    assert.equal(gid, fake.state.gid);
    assert.equal(version, 2);
    assert.equal(change.pubkey, sk.pk);
    assert.equal(change.id, eventId(change));
    assert.ok(schnorr.verify(Buffer.from(change.sig, 'hex'), Buffer.from(change.id, 'hex'), Buffer.from(sk.pk, 'hex')));
    assert.deepEqual(change.tags, [['h', gid], ['v', '2'], ['op', 'key']]);
    assert.equal(env.epoch, 2);
    assert.deepEqual(env.keys.map((k: any) => k.to).sort(), [ana.pk, ben.pk, sk.pk].sort());
    const anaKey = parseEnvelope(nip44Decrypt(env.keys.find((k: any) => k.to === ana.pk).blob, conversationKey(hex(ana), sk.pk)), gid, 2);
    assert.ok(anaKey && anaKey.length === 32);
  });

  it('serves the backup to members only, signed for the exact url', async () => {
    const ana = key(), ben = key(), carol = key(), stranger = key();
    let fake!: ReturnType<typeof fakeGroupHome>;
    const { run, clock } = await boxWith((pk) => (fake = fakeGroupHome(pk, ana, ben, carol)).rpc);
    await run.keeper!.cycle();
    const path = `/groups/${fake.state.gid}/events?before=3&limit=200`;
    const get = (who: Key, u = `https://${DOMAIN}${path}`) => {
      const e: any = {
        pubkey: who.pk, created_at: clock.now, kind: 27235, content: '',
        tags: [['u', u], ['method', 'GET'], ['payload', createHash('sha256').update('').digest('hex')]],
      };
      e.id = eventId(e);
      e.sig = Buffer.from(schnorr.sign(Buffer.from(e.id, 'hex'), who.sk)).toString('hex');
      return fetch(`${run.url}${path}`, { headers: { authorization: 'Nostr ' + Buffer.from(JSON.stringify(e)).toString('base64') } });
    };
    const ok = await get(ben);
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json() as any[]).map((r) => r.seq), [1, 2]);
    assert.equal((await get(stranger)).status, 403);
    assert.equal((await get(ben, `https://${DOMAIN}/groups/other`)).status, 401);
  });
});
