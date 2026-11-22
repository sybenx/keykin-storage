// This storage's own key. The home knows storage by its public key (the owner registers it there) and storage signs
// its member list requests with it. Made on first start, kept in the data folder, readable by this user only.

import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';

export interface ServiceKey {
  sk: Uint8Array;
  /** Hex public key. */
  pk: string;
}

export const SERVICE_KEY_FILE = 'service-key';

/** Reads the key, or makes one if there is none yet. Never logs or returns the secret as text. */
export function serviceKey(dataDir: string): ServiceKey {
  const file = join(dataDir, SERVICE_KEY_FILE);
  let hex: string;
  try {
    hex = readFileSync(file, 'utf8').trim();
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
    const sk = schnorr.utils.randomSecretKey();
    try {
      writeFileSync(file, Buffer.from(sk).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e; // the CLI and the server both made one at once: use the one that won
    }
    hex = readFileSync(file, 'utf8').trim();
  }
  if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${file} is not a key; move it away to make a new one (the home must then learn the new public key)`);
  const sk = Uint8Array.from(Buffer.from(hex, 'hex'));
  let pk: string;
  try {
    pk = Buffer.from(schnorr.getPublicKey(sk)).toString('hex');
  } catch {
    throw new Error(`${file} is not a valid key`);
  }
  return { sk, pk };
}
