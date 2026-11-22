// Accounts and the bin, from the command line, until the admin page exists.
//
//   node src/cli.ts accounts
//   node src/cli.ts add <npub|hex> <quota: 10G, 500M, unlimited>
//   node src/cli.ts remove <npub|hex> [--purge]
//   node src/cli.ts bin
//   node src/cli.ts restore <sha256> [<npub|hex> owner, default the box owner]
//   node src/cli.ts erase <sha256>
//   node src/cli.ts home status | key | sync | apply
//
// STORAGE_DIR is the data folder (default ./data). The server can keep running meanwhile. The home commands read
// the same settings as the server (STORAGE_HOME_URL, STORAGE_OWNER, STORAGE_MEMBER_QUOTA).

import { join } from 'node:path';
import { configFromEnv, parseSize } from './config.ts';
import { Db } from './db.ts';
import { describeError, Home, httpHome } from './home.ts';
import { serviceKey } from './servicekey.ts';
import { npub, parsePubkey } from './keys.ts';
import { removeBlobFile } from './store.ts';

const dir = process.env.STORAGE_DIR || './data';
const db = new Db(join(dir, 'storage.db'));
const now = Math.floor(Date.now() / 1000);
const args = process.argv.slice(2);
const flags = new Set(args.filter((x) => x.startsWith('--')));
const [cmd, a, b] = args.filter((x) => !x.startsWith('--'));

const size = (n: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
};
const pk = (s: string | undefined) => {
  const p = s ? parsePubkey(s) : null;
  if (!p) throw new Error('give an npub or a hex pubkey');
  return p;
};
const quota = (s: string | undefined): number | null => parseSize(s ?? '', true);
const when = (t: number | null) => (t ? new Date(t * 1000).toISOString().replace('.000Z', 'Z') : 'never');

/** The home commands: they need the server's settings. */
async function homeCommand(sub: string | undefined): Promise<void> {
  const config = configFromEnv();
  const key = serviceKey(dir);
  const homeOf = () => {
    if (!config.homeUrl) throw new Error('STORAGE_HOME_URL is not set, so accounts do not follow a home');
    if (!config.owner) throw new Error('STORAGE_OWNER is not set');
    return new Home(db, httpHome(config.homeUrl, key, { timeoutMs: 10_000, now: () => Math.floor(Date.now() / 1000) }), {
      owner: config.owner, memberQuota: config.memberQuota, pollS: config.homePollS, now: () => Math.floor(Date.now() / 1000),
      log: (line) => console.log(line), removeFile: (sha) => removeBlobFile(dir, sha),
    });
  };
  const result = (r: Awaited<ReturnType<Home['sync']>>) => {
    if (!r.ok) throw new Error(describeError(r.kind, r.message));
    console.log(`${r.joined} joined, ${r.left} left${r.held ? `, ${r.held} removals held (run home apply to go ahead)` : ''}; ${db.members().length} members`);
  };
  switch (sub) {
    case 'key':
      console.log(`This storage's public key. Register it on the home so the home answers its member list requests.`);
      console.log(`hex:  ${key.pk}`);
      console.log(`npub: ${npub(key.pk)}`);
      break;
    case 'status': {
      const st = db.homeState();
      console.log(`home:        ${config.homeUrl || (st.url ? `not set (was ${st.url})` : 'not set: accounts do not follow a home')}`);
      console.log(`storage key: ${key.pk}`);
      console.log(`             ${npub(key.pk)}`);
      console.log(`last good:   ${when(st.lastGood)}${st.lastTry && st.lastTry !== st.lastGood ? `, last try ${when(st.lastTry)}` : ''}`);
      console.log(`members:     ${db.members().length}, quota ${size(config.memberQuota)} each unless set by hand`);
      if (st.errorKind) console.log(`problem:     ${describeError(st.errorKind, st.error ?? '')}`);
      const held = st.held ? (JSON.parse(st.held) as { pubkey: string }[]) : [];
      if (held.length) {
        console.log(`held:        ${held.length} removals since ${when(st.heldSince)}; check the home, then run home apply`);
        for (const h of held) console.log(`             ${npub(h.pubkey)}`);
      }
      const removed = db.removals();
      if (removed.length) console.log(`removed:     ${removed.length} recorded, latest ${npub(removed[0].pubkey)} at ${when(removed[0].removedAt)} (${removed[0].reason})`);
      break;
    }
    case 'sync':
      result(await homeOf().sync());
      break;
    case 'apply': {
      if (!db.homeState().held) {
        console.log('nothing is held');
        break;
      }
      result(homeOf().applyHeld());
      break;
    }
    default:
      throw new Error('home commands: status | key | sync | apply');
  }
}

try {
  switch (cmd) {
    case 'accounts':
      for (const acc of db.accounts()) {
        const from = acc.hand && acc.member ? 'by hand, also a home member' : acc.hand ? 'by hand' : 'home member';
        console.log(`${npub(acc.pubkey)}  ${size(acc.used)} of ${acc.quota === null ? 'unlimited' : size(acc.quota)}  (${from})`);
      }
      break;
    case 'home':
      await homeCommand(a);
      break;
    case 'add':
      db.putAccount(pk(a), quota(b), now);
      console.log(`added ${npub(pk(a))}`);
      break;
    case 'remove': {
      const member = !!db.account(pk(a))?.member;
      if (flags.has('--purge')) {
        const erased = db.purgeAccount(pk(a), now);
        if (erased === null) throw new Error('no such account');
        for (const s of erased) removeBlobFile(dir, s);
        console.log(`removed; erased ${erased.length} blobs only it held. Purge them from your edge cache too.`);
      } else {
        console.log(db.removeAccount(pk(a), now) ? 'removed; what only it held is in the bin' : 'no such account');
      }
      if (member) console.log('This key is a member of the home, so it comes back at the next sync. To keep it out, remove it on the home.');
      break;
    }
    case 'erase': {
      const s = (a ?? '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(s)) throw new Error('give a sha256');
      if (!db.eraseNow(s)) throw new Error('that blob is not here');
      removeBlobFile(dir, s);
      console.log('erased. Purge it from your edge cache too (Cloudflare: Caching, Purge by URL).');
      break;
    }
    case 'bin':
      for (const x of db.binned()) console.log(`${x.sha256}  ${size(x.size)}  binned ${new Date(x.binned! * 1000).toISOString()}`);
      break;
    case 'restore': {
      const x = db.blob(a ?? '');
      if (!x || x.binned === null) throw new Error('that blob is not in the bin');
      const owner = b ? pk(b) : db.accounts().find((acc) => acc.quota === null)?.pubkey;
      if (!owner) throw new Error('give the owner to restore it to');
      db.own(x.sha256, x.size, x.type, owner, now);
      console.log(`restored to ${npub(owner)}`);
      break;
    }
    default:
      console.log('commands: accounts | add <npub> <quota> | remove <npub> [--purge] | bin | restore <sha256> [<npub>] | erase <sha256> | home status|key|sync|apply');
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  db.close();
}
