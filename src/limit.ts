// A small per-address limit on signed requests: a token bucket per client address, in memory, bounded in size.
// It keeps one address from making the box check signatures (and answer quota questions) as fast as it can send.

import http from 'node:http';
import { isIP } from 'node:net';

export interface LimitOptions {
  /** Requests an address may send at once. */
  burst: number;
  /** Requests per second it gets back. */
  perSecond: number;
  /** Most addresses remembered; the least recently seen is forgotten first. */
  maxAddresses?: number;
}

export class RateLimit {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly max: number;
  private readonly opts: LimitOptions;
  constructor(opts: LimitOptions) {
    this.opts = opts;
    this.max = opts.maxAddresses ?? 4096;
  }

  /** Takes one request's allowance for `addr`. False when it has none left. `nowMs` is for tests. */
  take(addr: string, nowMs = Date.now()): boolean {
    let b = this.buckets.get(addr);
    if (b) {
      this.buckets.delete(addr); // re-inserted below, so the Map's order is least recently seen first
      b.tokens = Math.min(this.opts.burst, b.tokens + ((nowMs - b.at) / 1000) * this.opts.perSecond);
      b.at = nowMs;
    } else {
      b = { tokens: this.opts.burst, at: nowMs };
      while (this.buckets.size >= this.max) this.buckets.delete(this.buckets.keys().next().value!);
    }
    this.buckets.set(addr, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * The client's address: Cloudflare's CF-Connecting-IP when `behindCloudflare` (only then can it be trusted, since
 * anyone can send the header), else the socket's address.
 */
export function clientAddress(req: http.IncomingMessage, behindCloudflare: boolean): string {
  if (behindCloudflare) {
    const h = req.headers['cf-connecting-ip'];
    const v = (Array.isArray(h) ? h[0] : h)?.trim();
    if (v && isIP(v)) return v;
  }
  return req.socket.remoteAddress ?? 'unknown';
}
