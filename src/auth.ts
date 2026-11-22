// BUD-11 authorization: `Authorization: Nostr <base64url of a kind 24242 event>`. And NIP-98 HTTP auth (kind 27235)
// for the management surface.

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
/** How long one token may live: `created_at` at most this old, `expiration` at most this far ahead, seconds. */
export const MAX_AGE = 25 * 3600;
const MAX_HEADER = 16 * 1024;
/** Most `x` tags one authorization may carry. Each is a database lookup per request. */
export const MAX_X_TAGS = 16;

/** NIP-98 HTTP auth. */
export const HTTP_AUTH_KIND = 27235;
/** How far a NIP-98 event's `created_at` may be from now, either way, seconds. */
export const HTTP_AUTH_WINDOW = 60;

const fail = (reason: string): { ok: false; status: number; reason: string } => ({ ok: false, status: 401, reason });

export function eventId(e: { pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }): string {
  return createHash('sha256').update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest('hex');
}

/** An event (kind 24242 or 27235) whose shape is right but whose signature and tags are not checked yet. */
export interface Unchecked {
  id: string;
  pubkey: string;
  sig: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/** Whether the event's signature is good for its id and pubkey. The id must be checked first. */
function signed(e: Unchecked): boolean {
  try {
    return schnorr.verify(Buffer.from(e.sig, 'hex'), Buffer.from(e.id, 'hex'), Buffer.from(e.pubkey, 'hex'));
  } catch {
    return false;
  }
}

export type Parsed = { ok: true; event: Unchecked } | { ok: false; status: number; reason: string };

/**
 * Reads the header into an event without checking its signature, so the caller can refuse a key that may not do
 * anything here before paying for a signature check.
 */
export function parseAuth(header: string | undefined, kind = 24242): Parsed {
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
      e.kind !== kind || typeof e.content !== 'string' || !Array.isArray(e.tags) ||
      !e.tags.every((t: unknown) => Array.isArray(t) && t.length > 0 && t.every((s) => typeof s === 'string'))) {
    return fail(`authorization is not a kind ${kind} event`);
  }
  return { ok: true, event: e as Unchecked };
}

/**
 * Checks a parsed event for `verb`: `created_at` not in the future and at most 25 hours old, an `expiration` in
 * the future and at most 25 hours ahead (so a leaked token ages out), a `t` tag for
 * the verb, a `server` tag naming one of `domains` (required here: a token without one can be replayed on any
 * server), and last the signature. `x` tags are returned for the caller to match against the blob.
 */
export function checkAuth(e: Unchecked, verb: Verb, domains: string[], now: number): AuthResult {
  if (eventId(e) !== e.id) return fail('authorization id is wrong');
  if (e.created_at > now + SKEW) return fail('authorization is from the future');
  if (e.created_at < now - MAX_AGE) return fail('authorization is too old: sign a new one');
  const tags = (name: string): string[] => e.tags.filter((t: string[]) => t[0] === name && t.length > 1).map((t: string[]) => t[1]);
  const exp = tags('expiration');
  if (exp.length !== 1 || !/^\d+$/.test(exp[0]) || Number(exp[0]) <= now) return fail('authorization expired or has no expiration');
  if (Number(exp[0]) > now + MAX_AGE) return fail('authorization expiration is more than 25 hours ahead');
  if (!tags('t').includes(verb)) return fail(`authorization is not for ${verb}`);
  const servers = tags('server').map((s) => s.toLowerCase());
  if (servers.length === 0) return fail('authorization needs a server tag');
  if (!servers.some((s) => domains.includes(s))) return fail('authorization is for another server');
  const xs = tags('x').map((x) => x.toLowerCase()).filter((x) => H64.test(x));
  if (xs.length > MAX_X_TAGS) return fail(`authorization has more than ${MAX_X_TAGS} x tags`);
  if (!signed(e)) return fail('authorization signature is wrong');
  return { ok: true, auth: { pubkey: e.pubkey, xs } };
}

/** What a NIP-98 event must name: the urls it may be for (exact), the HTTP method, and the body's bytes. */
export interface HttpRequest {
  urls: string[];
  method: string;
  body: Uint8Array;
}

/**
 * Checks a parsed kind 27235 event against a request: `created_at` within a minute of now either way, a `u` tag that
 * is one of `urls`, a `method` tag, a `payload` tag with the body's sha256, then the id and last the signature.
 */
export function checkHttpAuth(e: Unchecked, req: HttpRequest, now: number): { ok: true; pubkey: string } | { ok: false; status: number; reason: string } {
  if (e.created_at > now + HTTP_AUTH_WINDOW) return fail('authorization is from the future: check this device\'s clock');
  if (e.created_at < now - HTTP_AUTH_WINDOW) return fail('authorization is more than a minute old: sign a new one');
  const tag = (name: string): string | undefined => e.tags.find((t) => t[0] === name)?.[1];
  const u = tag('u');
  if (u === undefined || !req.urls.includes(u)) return fail('authorization is for another url');
  if (tag('method') !== req.method) return fail(`authorization is not for ${req.method}`);
  if (tag('payload')?.toLowerCase() !== createHash('sha256').update(req.body).digest('hex')) return fail('authorization payload does not match the body');
  if (eventId(e) !== e.id) return fail('authorization id is wrong');
  if (!signed(e)) return fail('authorization signature is wrong');
  return { ok: true, pubkey: e.pubkey };
}

/** parseAuth then checkAuth. */
export function readAuth(header: string | undefined, verb: Verb, domains: string[], now: number): AuthResult {
  const p = parseAuth(header);
  return p.ok ? checkAuth(p.event, verb, domains, now) : p;
}
