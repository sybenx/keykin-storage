// Accounts and the bin, from the command line, until the admin page exists.
//
//   node src/cli.ts accounts
//   node src/cli.ts add <npub|hex> <quota: 10G, 500M, unlimited>
//   node src/cli.ts remove <npub|hex>
//   node src/cli.ts bin
//   node src/cli.ts restore <sha256> [<npub|hex> owner, default the box owner]
//
// STORAGE_DIR is the data folder (default ./data). The server can keep running meanwhile.

import { join } from 'node:path';
import { Db } from './db.ts';
import { npub, parsePubkey } from './keys.ts';

const dir = process.env.STORAGE_DIR || './data';
const db = new Db(join(dir, 'storage.db'));
const now = Math.floor(Date.now() / 1000);
const [cmd, a, b] = process.argv.slice(2);

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
        console.log(`${npub(acc.pubkey)}  ${size(db.usage(acc.pubkey))} of ${acc.quota === null ? 'unlimited' : size(acc.quota)}`);
      }
      break;
    case 'add':
      db.putAccount(pk(a), quota(b), now);
      console.log(`added ${npub(pk(a))}`);
      break;
    case 'remove':
      console.log(db.removeAccount(pk(a), now) ? 'removed; what only it held is in the bin' : 'no such account');
      break;
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
      console.log('commands: accounts | add <npub> <quota> | remove <npub> | bin | restore <sha256> [<npub>]');
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  db.close();
}
