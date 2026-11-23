// The group keeper (DMs docs/next-round/groups.md; bothy src/home-groups.ts). The home's groups each have one key per
// epoch, and this box holds every one of them (Aaron 2026-11-23: no opt-out). With them it:
//   - seals the current key to someone who joined from a link, and the earlier keys to new members, so they read
//     what was said before (the home lists what is owed: `keepergroups`);
//   - makes the new key after someone leaves or the home removes them (`needsKey`);
//   - backs up every sealed message, tells the home (`groupkept`) so it may drop month-old ones, and serves them to
//     members from GET /groups/<gid>/events, checked against the home's roster.
// It never opens a message: it holds keys and sealed bytes. It talks to the home with this storage's service key,
// which the home knows as its storage (setstorage) and names as the groups' keeper.

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { schnorr } from '@noble/curves/secp256k1.js';
import { checkHttpAuth, eventId, HTTP_AUTH_KIND, parseAuth } from './auth.ts';
import type { Db } from './db.ts';
import { requestUrl, signRequest } from './home.ts';
import { conversationKey, nip44Decrypt, nip44Encrypt } from './nip44.ts';
import type { ServiceKey } from './servicekey.ts';

export const MESSAGE_KIND = 1490;
export const CHANGE_KIND = 1491;
const GID = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** groupsince pages and the door's pages. */
const PAGE = 500;
export const DOOR_PAGE = 200;
/** How long the door trusts a roster it asked the home for, seconds. */
const ROSTER_TTL = 30;

/** One NIP-86 call to the home, signed with the service key. Throws with the home's error text. */
export interface HomeRpc {
  call(method: string, params: unknown[]): Promise<any>;
}

export class RpcError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The real home over http(s), as home.ts asks it for the member list. */
export function httpRpc(homeUrl: string, key: ServiceKey, opts: { timeoutMs: number; now: () => number }): HomeRpc {
  const url = requestUrl(homeUrl);
  return {
    call: (method, params) => new Promise((resolve, reject) => {
      const body = JSON.stringify({ method, params });
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(u, {
        method: 'POST', signal: AbortSignal.timeout(opts.timeoutMs),
        headers: {
          'content-type': 'application/nostr+json+rpc', 'user-agent': 'keykin-storage',
          'content-length': Buffer.byteLength(body), authorization: signRequest(url, body, key, opts.now()),
        },
      }, (res) => {
        const parts: Buffer[] = [];
        let n = 0;
        res.on('data', (c: Buffer) => {
          n += c.length;
          if (n > 16 * 1024 * 1024) res.destroy(new Error('the answer is too big'));
          else parts.push(c);
        });
        res.on('error', (err) => reject(new RpcError(0, err.message)));
        res.on('end', () => {
          let j: any;
          try {
            j = JSON.parse(Buffer.concat(parts).toString('utf8'));
          } catch {
            return reject(new RpcError(res.statusCode ?? 0, 'not JSON'));
          }
          if (res.statusCode !== 200 || j?.error !== undefined && j?.result === undefined) {
            return reject(new RpcError(res.statusCode ?? 0, String(j?.error ?? `status ${res.statusCode}`)));
          }
          resolve(j.result);
        });
      });
      req.on('error', (err) => reject(new RpcError(0, err.message)));
      req.end(body);
    }),
  };
}

export interface KeeperOptions {
  now: () => number;
  log: (line: string) => void;
  /** Look at every group this often, seconds, besides when the home's socket says something happened. */
  pollS: number;
  /** The home's websocket url for wakes, or null to poll only. */
  wsUrl: string | null;
  /** This box's public url, which the door's authorization must name. */
  publicUrl: string;
}

/** What an envelope holds: this group's key for one epoch (the same JSON the app writes). */
export function envelopePlain(gid: string, epoch: number, key: Uint8Array): string {
  return JSON.stringify({ gid, epoch, key: Buffer.from(key).toString('hex') });
}

export function parseEnvelope(plain: string, gid: string, epoch: number): Uint8Array | null {
  try {
    const o = JSON.parse(plain);
    if (o?.gid !== gid || o?.epoch !== epoch || typeof o?.key !== 'string' || !HEX64.test(o.key)) return null;
    return Uint8Array.from(Buffer.from(o.key, 'hex'));
  } catch {
    return null;
  }
}

export class Keeper {
  private readonly db: Db;
  private readonly rpc: HomeRpc;
  private readonly key: ServiceKey;
  private readonly o: KeeperOptions;
  private readonly skHex: string;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private ws: WebSocket | null = null;
  private wsBackoff = 2000;
  private wake: NodeJS.Timeout | undefined;
  private rosters = new Map<string, { at: number; info: any }>();
  private lastError = '';

  constructor(db: Db, rpc: HomeRpc, key: ServiceKey, opts: KeeperOptions) {
    this.db = db;
    this.rpc = rpc;
    this.key = key;
    this.o = opts;
    this.skHex = Buffer.from(key.sk).toString('hex');
    db.sql.exec(`
      CREATE TABLE IF NOT EXISTS keeper_keys (gid TEXT NOT NULL, epoch INTEGER NOT NULL, key TEXT NOT NULL, PRIMARY KEY (gid, epoch));
      CREATE TABLE IF NOT EXISTS keeper_events (
        gid TEXT NOT NULL, seq INTEGER NOT NULL, stored_at INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (gid, seq));
    `);
  }

  start(): void {
    this.timer = setInterval(() => void this.cycle(), this.o.pollS * 1000);
    this.timer.unref();
    void this.cycle();
    if (this.o.wsUrl) this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.wake);
    try { this.ws?.close(); } catch {}
    await this.running?.catch(() => {});
  }

  /** One look at every group; a call during one runs once more after it. */
  cycle(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.once();
          this.lastError = '';
        } catch (err) {
          const line = `keeper: ${(err as Error).message}`;
          if (line !== this.lastError) this.o.log(line);
          this.lastError = line;
        }
      } while (this.again && !this.stopped);
    })().finally(() => { this.running = null; });
    return this.running;
  }

  private async once(): Promise<void> {
    const groups: any[] = await this.rpc.call('keepergroups', []);
    if (!Array.isArray(groups)) throw new Error('keepergroups did not answer a list');
    const live = new Set<string>();
    for (const g of groups) {
      if (typeof g?.gid !== 'string' || !GID.test(g.gid)) continue;
      live.add(g.gid);
      try {
        await this.keep(g);
      } catch (err) {
        this.o.log(`keeper: group ${g.gid.slice(0, 8)}: ${(err as Error).message}`);
      }
    }
    // A group nobody is in any more: its keys and messages go too.
    for (const { gid } of this.db.sql.prepare('SELECT DISTINCT gid FROM keeper_keys UNION SELECT DISTINCT gid FROM keeper_events').all() as { gid: string }[]) {
      if (live.has(gid)) continue;
      this.db.sql.prepare('DELETE FROM keeper_keys WHERE gid = ?').run(gid);
      this.db.sql.prepare('DELETE FROM keeper_events WHERE gid = ?').run(gid);
    }
  }

  private keyOf(gid: string, epoch: number): Uint8Array | null {
    const r = this.db.sql.prepare('SELECT key FROM keeper_keys WHERE gid = ? AND epoch = ?').get(gid, epoch) as { key: string } | undefined;
    return r ? Uint8Array.from(Buffer.from(r.key, 'hex')) : null;
  }

  private maxEpoch(gid: string): number {
    const r = this.db.sql.prepare('SELECT MAX(epoch) AS e FROM keeper_keys WHERE gid = ?').get(gid) as { e: number | null };
    return r.e ?? 0;
  }

  private putKey(gid: string, epoch: number, key: Uint8Array): void {
    this.db.sql.prepare('INSERT OR REPLACE INTO keeper_keys (gid, epoch, key) VALUES (?, ?, ?)').run(gid, epoch, Buffer.from(key).toString('hex'));
  }

  private seal(gid: string, epoch: number, key: Uint8Array, to: string): string {
    return nip44Encrypt(envelopePlain(gid, epoch, key), conversationKey(this.skHex, to));
  }

  /** Everything one group owes or is owed. */
  private async keep(g: any): Promise<void> {
    const gid: string = g.gid;
    // 1. The keys sealed to this box since the newest it holds, each checked to be this group's for that epoch.
    if (this.maxEpoch(gid) < g.epoch) {
      const keys: any[] = await this.rpc.call('groupkeys', [gid, this.maxEpoch(gid)]);
      for (const k of keys ?? []) {
        if (!Number.isInteger(k?.epoch) || typeof k?.from !== 'string' || !HEX64.test(k.from) || typeof k?.blob !== 'string') continue;
        try {
          const key = parseEnvelope(nip44Decrypt(k.blob, conversationKey(this.skHex, k.from)), gid, k.epoch);
          if (key) this.putKey(gid, k.epoch, key);
        } catch {}
      }
    }
    // 2. A new key after a leave or a removal the home made, for everyone still in, and for this box.
    if (g.needsKey) await this.rekey(g);
    // 3. Keys owed: a link join's current key, a new member's earlier keys.
    const owed: any[] = Array.isArray(g.owed) ? g.owed : [];
    const envelopes: { to: string; epoch: number; blob: string }[] = [];
    for (const o of owed) {
      if (typeof o?.pubkey !== 'string' || !HEX64.test(o.pubkey) || !Array.isArray(o.epochs)) continue;
      for (const epoch of o.epochs) {
        const key = Number.isInteger(epoch) ? this.keyOf(gid, epoch) : null;
        if (key) envelopes.push({ to: o.pubkey, epoch, blob: this.seal(gid, epoch, key, o.pubkey) });
      }
    }
    for (let i = 0; i < envelopes.length; i += 500) await this.rpc.call('groupseal', [gid, envelopes.slice(i, i + 500)]);
    // 4. The backup: every event after the last one kept, then the home is told.
    let after = this.lastSeq(gid);
    if (g.lastSeq > after) {
      for (;;) {
        const rows: any[] = await this.rpc.call('groupsince', [gid, after, PAGE]);
        if (!Array.isArray(rows) || rows.length === 0) break;
        const put = this.db.sql.prepare('INSERT OR IGNORE INTO keeper_events (gid, seq, stored_at, event) VALUES (?, ?, ?, ?)');
        this.db.tx(() => {
          for (const r of rows) {
            if (!Number.isSafeInteger(r?.seq) || typeof r?.event !== 'object') continue;
            put.run(gid, r.seq, Number.isSafeInteger(r.storedAt) ? r.storedAt : this.o.now(), JSON.stringify(r.event));
            after = Math.max(after, r.seq);
          }
        });
        if (rows.length < PAGE) break;
      }
    }
    if (after > (g.keptSeq ?? 0)) await this.rpc.call('groupkept', [gid, after]);
  }

  private lastSeq(gid: string): number {
    const r = this.db.sql.prepare('SELECT MAX(seq) AS s FROM keeper_events WHERE gid = ?').get(gid) as { s: number | null };
    return r.s ?? 0;
  }

  /** The key change after a leave: a fresh key sealed to each person still in and to this box, signed by this box. */
  private async rekey(g: any): Promise<void> {
    const gid: string = g.gid;
    const members: string[] = (Array.isArray(g.members) ? g.members : []).map((m: any) => m?.pubkey).filter((p: unknown) => typeof p === 'string' && HEX64.test(p));
    if (members.length === 0) return;
    const epoch = g.epoch + 1;
    const key = Uint8Array.from(randomBytes(32));
    const keys = [...members, this.key.pk].map((to) => ({ to, blob: this.seal(gid, epoch, key, to) }));
    const e: any = {
      pubkey: this.key.pk, created_at: this.o.now(), kind: CHANGE_KIND, content: '',
      tags: [['h', gid], ['v', String(g.version)], ['op', 'key']],
    };
    e.id = eventId(e);
    e.sig = Buffer.from(schnorr.sign(Buffer.from(e.id, 'hex'), this.key.sk)).toString('hex');
    try {
      await this.rpc.call('groupchange', [gid, g.version, e, { epoch, keys }]);
      this.putKey(gid, epoch, key);
    } catch (err) {
      // Someone's app made it first, or the group changed: the next look sorts it out.
      if (!/changed|epoch/.test((err as Error).message)) throw err;
    }
  }

  // --- the home's socket: a wake on every group event, so a link join gets its key in seconds

  private connect(): void {
    if (this.stopped || !this.o.wsUrl || typeof WebSocket === 'undefined') return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.o.wsUrl);
    } catch {
      return this.reconnect();
    }
    this.ws = ws;
    const req = JSON.stringify(['REQ', 'keeper', { kinds: [MESSAGE_KIND, CHANGE_KIND] }]);
    ws.onopen = () => { this.wsBackoff = 2000; ws.send(req); };
    ws.onmessage = (m) => {
      let f: any;
      try { f = JSON.parse(String(m.data)); } catch { return; }
      if (f[0] === 'AUTH' && typeof f[1] === 'string') {
        const e: any = {
          pubkey: this.key.pk, created_at: this.o.now(), kind: 22242, content: '',
          tags: [['relay', this.o.wsUrl!], ['challenge', f[1]]],
        };
        e.id = eventId(e);
        e.sig = Buffer.from(schnorr.sign(Buffer.from(e.id, 'hex'), this.key.sk)).toString('hex');
        ws.send(JSON.stringify(['AUTH', e]));
      } else if (f[0] === 'OK' && f[2] === true) {
        ws.send(req); // authenticated: ask again
      } else if (f[0] === 'EVENT') {
        clearTimeout(this.wake);
        this.wake = setTimeout(() => void this.cycle(), 500);
      }
    };
    ws.onclose = () => { if (this.ws === ws) this.ws = null; this.reconnect(); };
    ws.onerror = () => {};
  }

  private reconnect(): void {
    if (this.stopped) return;
    const wait = this.wsBackoff;
    this.wsBackoff = Math.min(this.wsBackoff * 2, 120_000);
    setTimeout(() => this.connect(), wait).unref();
  }

  // --- the door: GET /groups/<gid>/events?before=<seq>&limit=<n>, signed by someone in the group

  /** The events a member may read, newest `limit` before `before`, oldest first. Throws an HttpError-shaped object. */
  async door(req: http.IncomingMessage, gid: string): Promise<{ status: number; body: unknown }> {
    const q = new URL(req.url ?? '/', 'http://x');
    const before = Number(q.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
    const limit = Math.min(Math.max(Number(q.searchParams.get('limit') ?? DOOR_PAGE) || DOOR_PAGE, 1), DOOR_PAGE);
    if (!GID.test(gid) || !Number.isSafeInteger(before) || before < 0) return { status: 400, body: { error: 'before must be a home number' } };
    const p = parseAuth(req.headers.authorization, HTTP_AUTH_KIND);
    if (!p.ok) return { status: p.status, body: { error: p.reason } };
    const url = this.o.publicUrl + (req.url ?? '');
    const r = checkHttpAuth(p.event, { urls: [url], method: 'GET', body: new Uint8Array() }, this.o.now());
    if (!r.ok) return { status: r.status, body: { error: r.reason } };
    const info = await this.roster(gid);
    const me = info?.members?.find((m: any) => m?.pubkey === r.pubkey);
    if (!me) return { status: 403, body: { error: 'you are not in this group' } };
    // New people read everything while the switch is on (the default); otherwise from when they joined.
    const from = info.settings?.history === false ? Number(me.fromSeq) || 0 : 0;
    const rows = this.db.sql.prepare(
      'SELECT seq, stored_at, event FROM keeper_events WHERE gid = ? AND seq < ? AND seq >= ? ORDER BY seq DESC LIMIT ?',
    ).all(gid, before, from, limit) as { seq: number; stored_at: number; event: string }[];
    return { status: 200, body: rows.reverse().map((x) => ({ seq: x.seq, storedAt: x.stored_at, event: JSON.parse(x.event) })) };
  }

  private async roster(gid: string): Promise<any> {
    const hit = this.rosters.get(gid);
    if (hit && this.o.now() - hit.at < ROSTER_TTL) return hit.info;
    try {
      const info = await this.rpc.call('groupinfo', [gid, Number.MAX_SAFE_INTEGER]);
      if (this.rosters.size > 1000) this.rosters.clear();
      this.rosters.set(gid, { at: this.o.now(), info });
      return info;
    } catch {
      return null;
    }
  }
}

/** The home's websocket url from its https url. */
export const wsUrlOf = (homeUrl: string) => homeUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
