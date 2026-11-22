// The fake home's check of a memberkeys request, written from the agreed contract, not from src/home.ts.

import { createHash } from 'node:crypto';
import type http from 'node:http';
import { schnorr } from '@noble/curves/secp256k1.js';

/** Why the request fails the home's checks, 'unregistered' for a good request from another key, or null. */
export function verifyEvent(req: http.IncomingMessage, body: string, url: string, registered: string, now: number): string | null {
  if (req.method !== 'POST') return 'not POST';
  if (req.url !== '/') return 'not /';
  if (req.headers['content-type'] !== 'application/nostr+json+rpc') return 'wrong content type';
  let rpc: any;
  try { rpc = JSON.parse(body); } catch { return 'body not JSON'; }
  if (rpc?.method !== 'memberkeys' || !Array.isArray(rpc.params) || rpc.params.length !== 0) return 'not memberkeys';
  const m = /^Nostr ([A-Za-z0-9+/=]+)$/.exec(req.headers.authorization ?? '');
  if (!m) return 'no Nostr authorization';
  let e: any;
  try { e = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); } catch { return 'authorization not JSON'; }
  if (e.kind !== 27235) return 'not kind 27235';
  const id = createHash('sha256').update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest('hex');
  if (id !== e.id) return 'wrong id';
  let good = false;
  try { good = schnorr.verify(Buffer.from(e.sig, 'hex'), Buffer.from(e.id, 'hex'), Buffer.from(e.pubkey, 'hex')); } catch {}
  if (!good) return 'bad signature';
  const tag = (n: string) => e.tags.find((t: string[]) => t[0] === n)?.[1];
  if (tag('u') !== url) return `u is ${tag('u')}, not ${url}`;
  if (tag('method') !== 'POST') return 'method tag is not POST';
  if (tag('payload') !== createHash('sha256').update(body).digest('hex')) return 'payload hash is wrong';
  if (Math.abs(e.created_at - now) > 60) return 'created_at too far from now';
  if (e.pubkey !== registered) return 'unregistered';
  return null;
}
