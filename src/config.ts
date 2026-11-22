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
  /** Whether requests come through Cloudflare, so CF-Connecting-IP names the client. Otherwise the socket does. */
  behindCloudflare: boolean;
  /** Signed requests an address may send at once, and per second after that. Defaults 60 and 10. */
  authBurst?: number;
  authPerSecond?: number;
  /** Tests only: an upload must average this many bytes a second over each window (default 16 KiB/s)… */
  minUploadBytesPerSecond?: number;
  /** …of this many ms (default 60 s). */
  uploadWindowMs?: number;
  /** Tests only: how long the small JSON body of /mirror may take to arrive, ms (default 10 s). */
  mirrorBodyTimeoutMs?: number;
  /** Tests only: uploads stop when the disk would have less than this left. Default 1 GiB. */
  diskMarginBytes?: number;
  /** Tests only: let /mirror fetch from loopback and private addresses. */
  mirrorAllowPrivate?: boolean;
  /** Tests only: the clock, in Unix seconds. */
  now?: () => number;
}

const MiB = 1024 * 1024;

/**
 * A numeric setting: unset or empty gives `fallback`; otherwise it must be a positive finite number (a whole one
 * when `integer`), or it's an error naming the setting. A typo like `256M` must not quietly remove a cap.
 */
function number(env: NodeJS.ProcessEnv, name: string, fallback: number, opts: { integer?: boolean; max?: number } = {}): number {
  const raw = (env[name] ?? '').trim();
  if (raw === '') return fallback;
  const n = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0 || (opts.integer && !Number.isInteger(n)) || (opts.max !== undefined && n > opts.max)) {
    throw new Error(`${name} must be a positive ${opts.integer ? 'whole ' : ''}number${opts.max !== undefined ? ` up to ${opts.max}` : ''}, not "${raw}"`);
  }
  return n;
}

/** A yes/no setting: true, yes, 1 or false, no, 0 (empty is no). Anything else is an error naming the setting. */
function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = (env[name] ?? '').trim().toLowerCase();
  if (['', 'false', 'no', '0'].includes(v)) return false;
  if (['true', 'yes', '1'].includes(v)) return true;
  throw new Error(`${name} must be true or false`);
}

/**
 * Reads the settings. A box installed before it's set up (no STORAGE_PUBLIC_URL or STORAGE_OWNER) still starts:
 * it serves reads and refuses every write with 503 until both are set. Malformed values are errors that name
 * the setting, and the server does not start.
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
    port: number(env, 'STORAGE_PORT', 7480, { integer: true, max: 65535 }),
    publicUrl,
    domains: env.STORAGE_DOMAINS ? env.STORAGE_DOMAINS.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean) : host ? [host] : [],
    owner,
    maxBlobBytes: Math.floor(number(env, 'STORAGE_MAX_BLOB_MB', 256) * MiB),
    maxBlobsPerAccount: number(env, 'STORAGE_MAX_BLOBS', 200_000, { integer: true }),
    binDays: number(env, 'STORAGE_BIN_DAYS', 30),
    mirrorTimeoutMs: number(env, 'STORAGE_MIRROR_TIMEOUT_S', 120) * 1000,
    behindCloudflare: flag(env, 'STORAGE_BEHIND_CLOUDFLARE'),
  };
}
