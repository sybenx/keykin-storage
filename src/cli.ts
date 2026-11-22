// Accounts and the bin, from the command line, until the admin page exists.
//
//   node src/cli.ts accounts
//   node src/cli.ts add <npub|hex> <quota: 10G, 500M, unlimited>
//   node src/cli.ts remove <npub|hex> [--purge]
//   node src/cli.ts bin
//   node src/cli.ts restore <sha256> [<npub|hex> owner, default the box owner]
//   node src/cli.ts erase <sha256>
//
// STORAGE_DIR is the data folder (default ./data). The server can keep running meanwhile.

import { join } from 'node:path';
import { Db } from './db.ts';
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
const quota = (s: string | undefined): number | null => {
  if (s === 'unlimited') return null;
  const m = /^(\d+(?:\.\d+)?)\s*([KMGT]?)B?$/i.exec(s ?? '');
  if (!m) throw new Error('give a quota like 10G, 500M or unlimited');
  return Math.round(Number(m[1]) * 1000 ** ' KMGT'.indexOf(m[2].toUpperCase() || ' '));
};

try {
  switch (cmd) {
    case 'accounts':
      for (const acc of db.accounts()) {
        console.log(`${npub(acc.pubkey)}  ${size(acc.used)} of ${acc.quota === null ? 'unlimited' : size(acc.quota)}`);
      }
      break;
    case 'add':
      db.putAccount(pk(a), quota(b), now);
      console.log(`added ${npub(pk(a))}`);
      break;
    case 'remove':
      if (flags.has('--purge')) {
        const erased = db.purgeAccount(pk(a), now);
        if (erased === null) throw new Error('no such account');
        for (const s of erased) removeBlobFile(dir, s);
        console.log(`removed; erased ${erased.length} blobs only it held. Purge them from your edge cache too.`);
      } else {
        console.log(db.removeAccount(pk(a), now) ? 'removed; what only it held is in the bin' : 'no such account');
      }
      break;
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
      console.log('commands: accounts | add <npub> <quota> | remove <npub> [--purge] | bin | restore <sha256> [<npub>] | erase <sha256>');
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  db.close();
}
