// Pubkeys as people type them: npub1… or 64 hex characters.

import { bech32 } from '@scure/base';

const HEX64 = /^[0-9a-f]{64}$/;

/** Hex pubkey, or null if it isn't one. */
export function parsePubkey(s: string): string | null {
  const t = s.trim().toLowerCase();
  if (HEX64.test(t)) return t;
  if (t.startsWith('npub1')) {
    try {
      const { prefix, words } = bech32.decode(t as `${string}1${string}`, 90);
      if (prefix !== 'npub') return null;
      const bytes = bech32.fromWords(words);
      if (bytes.length !== 32) return null;
      return Buffer.from(bytes).toString('hex');
    } catch {
      return null;
    }
  }
  return null;
}

export function npub(hex: string): string {
  return bech32.encode('npub', bech32.toWords(Buffer.from(hex, 'hex')), 90);
}
