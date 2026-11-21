// Fetching a blob for BUD-04 /mirror without letting anyone point this server at the box's own network.
// Every connection is checked: literal IPs before connecting, names through a lookup that refuses private
// answers (so the address checked is the address connected to), and each redirect again.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

const blocked4 = new BlockList(), blocked6 = new BlockList(); // separate: a v6 rule like ::/96 would also match every v4 address
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked4.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ['::', 96] /* unspecified, loopback and IPv4-compatible */, ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked6.addSubnet(net, bits, "ipv6");

/** Whether an address is loopback, private, link-local, CGNAT (Tailscale), multicast, reserved or a transition range. */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return blocked4.check(ip, "ipv4");
  if (v === 6) return blocked6.check(ip, "ipv6");
  return true;
}

export class MirrorError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Fetched {
  body: http.IncomingMessage;
  type: string | null;
  length: number | null;
}

export interface FetchOptions {
  timeoutMs: number;
  allowPrivate?: boolean;
  maxRedirects?: number;
}

/** GETs `url`, following up to 5 redirects. Resolves once headers are in; the caller reads (and caps) the body. */
export function guardedFetch(url: string, opts: FetchOptions, signal: AbortSignal): Promise<Fetched> {
  return go(url, opts, signal, opts.maxRedirects ?? 5);
}

async function go(raw: string, opts: FetchOptions, signal: AbortSignal, redirectsLeft: number): Promise<Fetched> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new MirrorError(400, 'mirror url is not a url');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new MirrorError(400, 'mirror url must be http or https');
  if (u.username || u.password) throw new MirrorError(400, 'mirror url must not carry credentials');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !opts.allowPrivate && isBlockedAddress(host)) throw new MirrorError(400, 'mirror url points at a private address');

  const lookup = (hostname: string, options: any, cb: (...a: any[]) => void) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addrs: LookupAddress[]) => {
      if (err) return cb(err);
      const ok = opts.allowPrivate ? addrs : addrs.filter((a) => !isBlockedAddress(a.address));
      if (ok.length === 0 || ok.length !== addrs.length) return cb(new MirrorError(400, 'mirror host resolves to a private address'));
      if (options?.all) cb(null, ok);
      else cb(null, ok[0].address, ok[0].family);
    });
  };

  const mod = u.protocol === 'https:' ? https : http;
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = mod.get(u, { lookup, signal, headers: { 'user-agent': 'keykin-storage', accept: '*/*' } }, resolve);
    req.on('error', (err) => reject(err instanceof MirrorError ? err : new MirrorError(502, `mirror fetch failed: ${err.message}`)));
  });

  const status = res.statusCode ?? 0;
  if ([301, 302, 303, 307, 308].includes(status)) {
    res.resume();
    const next = res.headers.location;
    if (!next) throw new MirrorError(502, 'mirror redirect has no location');
    if (redirectsLeft <= 0) throw new MirrorError(502, 'mirror url redirects too often');
    return go(new URL(next, u).toString(), opts, signal, redirectsLeft - 1);
  }
  if (status !== 200) {
    res.resume();
    throw new MirrorError(502, `mirror source answered ${status}`);
  }
  const len = res.headers['content-length'];
  return { body: res, type: res.headers['content-type'] ?? null, length: len && /^\d+$/.test(len) ? Number(len) : null };
}
