// BUD-11 authorization: `Authorization: Nostr <base64url of a kind 24242 event>`.

import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

export type Verb = 'get' | 'upload' | 'list' | 'delete' | 'media';

export interface Auth {
  pubkey: string;
  /** Every `x` tag, lowercase hex. */
  xs: string[];
}

export type AuthResult = { ok: true; auth: Auth } | { ok: false; status: number; reason: string };

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
const H64 = HEX(64), H128 = HEX(128);
/** A signature can't be from the future by more than this (clock skew), seconds. */
const SKEW = 60;
const MAX_HEADER = 16 * 1024;

const fail = (reason: string): AuthResult => ({ ok: false, status: 401, reason });

export function eventId(e: { pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }): string {
  return createHash('sha256').update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest('hex');
}

/**
 * Checks the header for `verb`: a valid signed kind 24242 event, `created_at` not in the future, an `expiration`
 * in the future, a `t` tag for the verb, and a `server` tag naming one of `domains` (required here: a token without
 * one can be replayed on any server). `x` tags are returned for the caller to match against the blob.
 */
export function readAuth(header: string | undefined, verb: Verb, domains: string[], now: number): AuthResult {
  if (!header) return fail('authorization required');
  if (header.length > MAX_HEADER) return fail('authorization too large');
  const m = /^Nostr\s+([A-Za-z0-9+/_=-]+)$/.exec(header.trim());
  if (!m) return fail('authorization is not Nostr');
  let e: any;
  try {
    e = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
  } catch {
    return fail('authorization is not JSON');
  }
  if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !H64.test(e.id) || typeof e.pubkey !== 'string' ||
      !H64.test(e.pubkey) || typeof e.sig !== 'string' || !H128.test(e.sig) || !Number.isSafeInteger(e.created_at) ||
      e.kind !== 24242 || typeof e.content !== 'string' || !Array.isArray(e.tags) ||
      !e.tags.every((t: unknown) => Array.isArray(t) && t.length > 0 && t.every((s) => typeof s === 'string'))) {
    return fail('authorization is not a kind 24242 event');
  }
  if (eventId(e) !== e.id) return fail('authorization id is wrong');
  let good = false;
  try {
    good = schnorr.verify(Buffer.from(e.sig, 'hex'), Buffer.from(e.id, 'hex'), Buffer.from(e.pubkey, 'hex'));
  } catch {
    good = false;
  }
  if (!good) return fail('authorization signature is wrong');
  if (e.created_at > now + SKEW) return fail('authorization is from the future');
  const tags = (name: string): string[] => e.tags.filter((t: string[]) => t[0] === name && t.length > 1).map((t: string[]) => t[1]);
  const exp = tags('expiration');
  if (exp.length !== 1 || !/^\d+$/.test(exp[0]) || Number(exp[0]) <= now) return fail('authorization expired or has no expiration');
  if (!tags('t').includes(verb)) return fail(`authorization is not for ${verb}`);
  const servers = tags('server').map((s) => s.toLowerCase());
  if (servers.length === 0) return fail('authorization needs a server tag');
  if (!servers.some((s) => domains.includes(s))) return fail('authorization is for another server');
  const xs = tags('x').map((x) => x.toLowerCase()).filter((x) => H64.test(x));
  return { ok: true, auth: { pubkey: e.pubkey, xs } };
}
