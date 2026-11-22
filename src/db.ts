// What's stored and who owns it, in SQLite (node:sqlite). Every function here is synchronous, so a check and the
// write after it can't be split by another request.

import { DatabaseSync } from 'node:sqlite';

export interface Blob {
  sha256: string;
  size: number;
  type: string;
  created: number;
  /** When the last owner let go of it (Unix seconds), or null while someone owns it. */
  binned: number | null;
}

export interface Account {
  pubkey: string;
  /** Bytes, or null for no limit (the box owner). */
  quota: number | null;
  added: number;
  /** Bytes charged to the account, kept up to date in the same transactions that change ownership. */
  used: number;
  /** Blobs charged to the account. */
  blobs: number;
}

/** Every blob is charged at least this many bytes, so tiny blobs can't use up the disk's inodes for free. */
export const MIN_CHARGE = 4096;
export const cost = (size: number) => Math.max(size, MIN_CHARGE);

export interface DbOptions {
  /** Most blobs an account with a quota may hold (owned or in the bin on its name). */
  maxBlobs?: number;
}

/** Uploads in flight for an account: their declared bytes and how many. */
export interface Pending {
  bytes: number;
  n: number;
}

const ACCOUNT_COLS = 'a.pubkey, a.quota, a.added, a.used, a.blobs';

/**
 * Schema changes after 0.1.0, in order. `PRAGMA user_version` says how many have run. Each runs once, in a
 * transaction, on a new database as well as an old one.
 */
const MIGRATIONS: ((db: Db) => void)[] = [
  // 0.2.0: running totals per account, so a quota check doesn't sum every blob the account holds
  (db) => {
    db.sql.exec('ALTER TABLE accounts ADD COLUMN used INTEGER NOT NULL DEFAULT 0');
    db.sql.exec('ALTER TABLE accounts ADD COLUMN blobs INTEGER NOT NULL DEFAULT 0');
    db.recountAll();
  },
  // 0.2.0: each blob costs at least MIN_CHARGE
  (db) => db.recountAll(),
];

export interface Owned extends Blob {
  uploaded: number;
}

export class Db {
  readonly sql: DatabaseSync;
  readonly maxBlobs: number;

  constructor(file: string, opts: DbOptions = {}) {
    this.maxBlobs = opts.maxBlobs ?? 200_000;
    this.sql = new DatabaseSync(file);
    this.sql.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000; -- the CLI writes from another process
      CREATE TABLE IF NOT EXISTS accounts (
        pubkey TEXT PRIMARY KEY, quota INTEGER, added INTEGER NOT NULL);
      -- Keys that write for an account. v1: each account's own pubkey. Key grants (spec proposal) add more.
      CREATE TABLE IF NOT EXISTS keys (
        key TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(pubkey) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS blobs (
        sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, type TEXT NOT NULL, created INTEGER NOT NULL, binned INTEGER,
        -- the account whose key let go last: a binned blob stays on its quota until erased, so delete-and-upload
        -- again can't fill the disk
        binned_by TEXT);
      -- Ownership is per key (a DELETE lets go of one key's copy only); charging is per account.
      CREATE TABLE IF NOT EXISTS owners (
        sha256 TEXT NOT NULL REFERENCES blobs(sha256) ON DELETE CASCADE, key TEXT NOT NULL, uploaded INTEGER NOT NULL,
        PRIMARY KEY (sha256, key));
      CREATE INDEX IF NOT EXISTS owners_by_key ON owners(key, uploaded, sha256);
      CREATE INDEX IF NOT EXISTS blobs_binned ON blobs(binned) WHERE binned IS NOT NULL;
    `);
    this.migrate();
  }

  private migrate(): void {
    const version = () => Number(this.sql.prepare('PRAGMA user_version').get()!.user_version);
    if (version() >= MIGRATIONS.length) return;
    this.tx(() => {
      // the CLI and the server may open the database at the same time: check again under the write lock
      for (let v = version(); v < MIGRATIONS.length; v++) MIGRATIONS[v](this);
      this.sql.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    });
  }

  close(): void {
    this.sql.close();
  }

  private tx<T>(f: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const r = f();
      this.sql.exec('COMMIT');
      return r;
    } catch (err) {
      this.sql.exec('ROLLBACK');
      throw err;
    }
  }

  // --- accounts

  /** Adds an account (its own pubkey becomes its key), or changes its quota. */
  putAccount(pubkey: string, quota: number | null, now: number): void {
    this.tx(() => {
      this.sql.prepare('INSERT INTO accounts (pubkey, quota, added) VALUES (?, ?, ?) ON CONFLICT(pubkey) DO UPDATE SET quota = excluded.quota')
        .run(pubkey, quota, now);
      this.sql.prepare('INSERT OR IGNORE INTO keys (key, account) VALUES (?, ?)').run(pubkey, pubkey);
      // a new account may have blobs it let go of before it was removed, still in the bin on its name
      this.recount(pubkey);
    });
  }

  /** Removes an account and lets go of everything its keys own (to the bin, where nobody else owns it). */
  removeAccount(pubkey: string, now: number): boolean {
    return this.tx(() => {
      const keys = this.sql.prepare('SELECT key FROM keys WHERE account = ?').all(pubkey).map((r) => r.key as string);
      for (const k of keys) {
        const shas = this.sql.prepare('SELECT sha256 FROM owners WHERE key = ?').all(k).map((r) => r.sha256 as string);
        for (const s of shas) this.letGo(s, k, now);
      }
      return this.sql.prepare('DELETE FROM accounts WHERE pubkey = ?').run(pubkey).changes > 0;
    });
  }

  /**
   * Removes an account and erases at once every blob only it holds: what its keys own that nobody else owns, and
   * what it let go of that is still in the bin on its name. Returns the erased hashes (delete their files), or null
   * when there is no such account.
   */
  purgeAccount(pubkey: string, now: number): string[] | null {
    return this.tx(() => {
      if (!this.sql.prepare('SELECT 1 FROM accounts WHERE pubkey = ?').get(pubkey)) return null;
      const keys = this.sql.prepare('SELECT key FROM keys WHERE account = ?').all(pubkey).map((r) => r.key as string);
      for (const k of keys) {
        const shas = this.sql.prepare('SELECT sha256 FROM owners WHERE key = ?').all(k).map((r) => r.sha256 as string);
        for (const s of shas) this.letGo(s, k, now);
      }
      const erased = this.sql.prepare('SELECT sha256 FROM blobs WHERE binned IS NOT NULL AND binned_by = ?').all(pubkey).map((r) => r.sha256 as string);
      for (const s of erased) this.eraseRow(s);
      this.sql.prepare('DELETE FROM accounts WHERE pubkey = ?').run(pubkey);
      return erased;
    });
  }

  accounts(): Account[] {
    return this.sql.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts a ORDER BY a.added`).all() as unknown as Account[];
  }

  /** The account a key writes for, or null if it may not write here. */
  accountOf(key: string): Account | null {
    const r = this.sql.prepare(`SELECT ${ACCOUNT_COLS} FROM keys k JOIN accounts a ON a.pubkey = k.account WHERE k.key = ?`).get(key);
    return (r as unknown as Account) ?? null;
  }

  /** The account a key writes for, by pubkey only. */
  private accountKey(key: string): string | null {
    return (this.sql.prepare('SELECT account FROM keys WHERE key = ?').get(key)?.account as string) ?? null;
  }

  /**
   * Counts what an account is charged from scratch: each blob any of its keys owns, once, plus what it last let go
   * of that's still in the bin, each at least MIN_CHARGE bytes. O(blobs): only for checks, the upgrade and accounts being added.
   */
  count(account: string): { used: number; blobs: number } {
    const r = this.sql.prepare(`SELECT COALESCE(SUM(MAX(size, ${MIN_CHARGE})), 0) AS used, COUNT(*) AS blobs FROM blobs WHERE sha256 IN
      (SELECT o.sha256 FROM owners o JOIN keys k ON k.key = o.key WHERE k.account = ?)
      OR (binned IS NOT NULL AND binned_by = ?)`).get(account, account);
    return { used: Number(r!.used), blobs: Number(r!.blobs) };
  }

  /** Bytes charged to an account, counted from scratch (see `count`). The running total is `Account.used`. */
  usage(account: string): number {
    return this.count(account).used;
  }

  /** Sets an account's running totals from a full count. */
  recount(account: string): void {
    const c = this.count(account);
    this.sql.prepare('UPDATE accounts SET used = ?, blobs = ? WHERE pubkey = ?').run(c.used, c.blobs, account);
  }

  recountAll(): void {
    for (const r of this.sql.prepare('SELECT pubkey FROM accounts').all()) this.recount(r.pubkey as string);
  }

  /** Adds (`sign` 1) or takes off (-1) one blob of `size` bytes from an account's running totals. */
  private charge(account: string, size: number, sign: 1 | -1): void {
    this.sql.prepare('UPDATE accounts SET used = used + ?, blobs = blobs + ? WHERE pubkey = ?').run(sign * cost(size), sign, account);
  }

  /** Whether any key of the account owns the blob. */
  holds(account: string, sha256: string): boolean {
    return !!this.sql.prepare('SELECT 1 FROM owners o JOIN keys k ON k.key = o.key WHERE k.account = ? AND o.sha256 = ?').get(account, sha256);
  }

  /** Whether the blob is already on the account's quota (owned, or in the bin on its account). */
  charged(account: string, sha256: string): boolean {
    return this.holds(account, sha256) ||
      !!this.sql.prepare('SELECT 1 FROM blobs WHERE sha256 = ? AND binned IS NOT NULL AND binned_by = ?').get(sha256, account);
  }

  /**
   * Why this blob would not fit in the account's quota or blob cap, with `pending` uploads in flight, or null if
   * it fits. Uses the running totals on `account`, so read the account once per request and pass it in.
   * An account without a quota has no blob cap either.
   */
  refusal(account: Account, sha256: string | null, size: number, pending: Pending = { bytes: 0, n: 0 }): string | null {
    if (account.quota === null) return null;
    if (sha256 && this.charged(account.pubkey, sha256)) return null;
    if (account.used + pending.bytes + cost(size) > account.quota) return 'over your quota on this box';
    if (account.blobs + pending.n + 1 > this.maxBlobs) return `you hold ${this.maxBlobs} blobs here, the most an account may`;
    return null;
  }

  fits(account: Account, sha256: string | null, size: number, pending?: Pending): boolean {
    return this.refusal(account, sha256, size, pending) === null;
  }

  /** When `key` took its copy, or null. */
  uploadedAt(sha256: string, key: string): number | null {
    const r = this.sql.prepare('SELECT uploaded FROM owners WHERE sha256 = ? AND key = ?').get(sha256, key);
    return r ? Number(r.uploaded) : null;
  }

  // --- blobs

  blob(sha256: string): Blob | null {
    return (this.sql.prepare('SELECT sha256, size, type, created, binned FROM blobs WHERE sha256 = ?').get(sha256) as unknown as Blob) ?? null;
  }

  /** Forgets a blob row that has no file after all (a failed commit). */
  forget(sha256: string): void {
    this.sql.prepare('DELETE FROM blobs WHERE sha256 = ?').run(sha256);
  }

  /** Records that `key` holds the blob. Takes it out of the bin if it was there. Returns whether the blob is new. */
  own(sha256: string, size: number, type: string, key: string, now: number): boolean {
    return this.tx(() => {
      const had = this.blob(sha256);
      const account = this.accountKey(key);
      const was = account !== null && this.charged(account, sha256);
      const binnedBy = had && had.binned !== null ? this.binnedBy(sha256) : null;
      if (!had) this.sql.prepare('INSERT INTO blobs (sha256, size, type, created, binned) VALUES (?, ?, ?, ?, NULL)').run(sha256, size, type, now);
      else if (had.binned !== null) this.sql.prepare('UPDATE blobs SET binned = NULL, binned_by = NULL WHERE sha256 = ?').run(sha256);
      this.sql.prepare('INSERT OR IGNORE INTO owners (sha256, key, uploaded) VALUES (?, ?, ?)').run(sha256, key, now);
      const cost = had ? had.size : size;
      if (account !== null && !was) this.charge(account, cost, 1);
      // out of the bin: off the quota of whoever let go of it last, unless that's this account
      if (binnedBy !== null && binnedBy !== account) this.charge(binnedBy, cost, -1);
      return !had;
    });
  }

  /** `key` lets go of its copy. When nobody owns the blob any more it goes to the bin. Returns whether `key` owned it. */
  disown(sha256: string, key: string, now: number): boolean {
    return this.tx(() => this.letGo(sha256, key, now));
  }

  private letGo(sha256: string, key: string, now: number): boolean {
    const account = this.accountKey(key);
    const was = account !== null && this.charged(account, sha256);
    const gone = this.sql.prepare('DELETE FROM owners WHERE sha256 = ? AND key = ?').run(sha256, key).changes > 0;
    if (gone && !this.sql.prepare('SELECT 1 FROM owners WHERE sha256 = ?').get(sha256)) {
      this.sql.prepare('UPDATE blobs SET binned = ?, binned_by = ? WHERE sha256 = ?').run(now, account, sha256);
    }
    if (gone && was && !this.charged(account!, sha256)) this.charge(account!, this.blob(sha256)!.size, -1);
    return gone;
  }

  private binnedBy(sha256: string): string | null {
    return (this.sql.prepare('SELECT binned_by FROM blobs WHERE sha256 = ?').get(sha256)?.binned_by as string) ?? null;
  }

  /** Blobs `key` owns, newest first. `cursor` is the last sha256 of the previous page. */
  owned(key: string, cursor: string | null, limit: number): Owned[] {
    const cols = 'b.sha256, b.size, b.type, b.created, b.binned, o.uploaded';
    if (cursor) {
      const at = this.sql.prepare('SELECT uploaded FROM owners WHERE key = ? AND sha256 = ?').get(key, cursor);
      if (!at) return [];
      return this.sql.prepare(`SELECT ${cols} FROM owners o JOIN blobs b ON b.sha256 = o.sha256 WHERE o.key = ?
        AND (o.uploaded < ? OR (o.uploaded = ? AND o.sha256 < ?)) ORDER BY o.uploaded DESC, o.sha256 DESC LIMIT ?`)
        .all(key, at.uploaded, at.uploaded, cursor, limit) as unknown as Owned[];
    }
    return this.sql.prepare(`SELECT ${cols} FROM owners o JOIN blobs b ON b.sha256 = o.sha256 WHERE o.key = ?
      ORDER BY o.uploaded DESC, o.sha256 DESC LIMIT ?`).all(key, limit) as unknown as Owned[];
  }

  // --- the bin

  binned(): Blob[] {
    return this.sql.prepare('SELECT sha256, size, type, created, binned FROM blobs WHERE binned IS NOT NULL ORDER BY binned DESC').all() as unknown as Blob[];
  }

  /** Blobs in the bin since before `before`. */
  expired(before: number): string[] {
    return this.sql.prepare('SELECT sha256 FROM blobs WHERE binned IS NOT NULL AND binned < ?').all(before).map((r) => r.sha256 as string);
  }

  /**
   * Erases a blob's row now, whoever owns it (a take-down). Returns whether there was one. Delete the file after.
   */
  eraseNow(sha256: string): boolean {
    return this.tx(() => this.eraseRow(sha256));
  }

  /** Deletes a blob's row and takes it off every account it was charged to. */
  private eraseRow(sha256: string): boolean {
    const b = this.blob(sha256);
    if (!b) return false;
    const charged = new Set(this.sql.prepare('SELECT DISTINCT k.account FROM owners o JOIN keys k ON k.key = o.key WHERE o.sha256 = ?')
      .all(sha256).map((r) => r.account as string));
    const by = b.binned !== null ? this.binnedBy(sha256) : null;
    if (by !== null) charged.add(by);
    this.sql.prepare('DELETE FROM blobs WHERE sha256 = ?').run(sha256);
    for (const a of charged) this.charge(a, b.size, -1);
    return true;
  }

  /** Erases a blob's row if it is still binned since before `before`. Returns whether it did. */
  erase(sha256: string, before: number): boolean {
    return this.tx(() => {
      const b = this.blob(sha256);
      if (!b || b.binned === null || b.binned >= before) return false;
      return this.eraseRow(sha256);
    });
  }
}
