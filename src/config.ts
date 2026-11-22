// Settings, from the environment (main.ts) or given directly (tests).

import { parsePubkey } from './keys.ts';

export interface Config {
  /** Where the database and blobs live. */
  dataDir: string;
  host: string;
  port: number;
  /** The address people reach this server at, used in blob descriptors (`https://storage.example.com`). */
  publicUrl: string;
  /** Lowercase domains a BUD-11 `server` tag may name. Defaults to publicUrl's host. */
  domains: string[];
  /** The box owner's pubkey (hex), or '' when not set up yet. Their account has no quota. */
  owner: string;
  /** Largest blob, in bytes. */
  maxBlobBytes: number;
  /** Most blobs an account with a quota may hold. */
  maxBlobsPerAccount: number;
  /** Days a blob nobody owns stays in the bin before it's erased. */
  binDays: number;
  /** Mirror fetch timeout, ms. */
  mirrorTimeoutMs: number;
  /** Tests only: uploads stop when the disk would have less than this left. Default 1 GiB. */
  diskMarginBytes?: number;
  /** Tests only: let /mirror fetch from loopback and private addresses. */
  mirrorAllowPrivate?: boolean;
  /** Tests only: the clock, in Unix seconds. */
  now?: () => number;
}

const MiB = 1024 * 1024;

/**
 * Reads the settings. A box installed before it's set up (no STORAGE_PUBLIC_URL or STORAGE_OWNER) still starts:
 * it serves reads and refuses every write with 503 until both are set. Malformed values are errors.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = (env.STORAGE_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  let host = '';
  if (publicUrl) {
    const u = new URL(publicUrl); // throws on a malformed url: better than a box that silently can't be written to
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('STORAGE_PUBLIC_URL must be http(s)');
    host = u.hostname.toLowerCase();
  }
  const rawOwner = (env.STORAGE_OWNER ?? '').trim();
  const owner = rawOwner ? parsePubkey(rawOwner) : '';
  if (owner === null) throw new Error('STORAGE_OWNER is not an npub or a hex pubkey');
  return {
    dataDir: env.STORAGE_DIR || './data',
    host: env.STORAGE_ADDR || '0.0.0.0',
    port: Number(env.STORAGE_PORT || 7480),
    publicUrl,
    domains: env.STORAGE_DOMAINS ? env.STORAGE_DOMAINS.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean) : host ? [host] : [],
    owner,
    maxBlobBytes: Number(env.STORAGE_MAX_BLOB_MB || 256) * MiB,
    maxBlobsPerAccount: Number(env.STORAGE_MAX_BLOBS || 200_000),
    binDays: Number(env.STORAGE_BIN_DAYS || 30),
    mirrorTimeoutMs: Number(env.STORAGE_MIRROR_TIMEOUT_S || 120) * 1000,
  };
}
