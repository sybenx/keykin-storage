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
}

export interface Owned extends Blob {
  uploaded: number;
}

export class Db {
  readonly sql: DatabaseSync;

  constructor(file: string) {
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

  accounts(): Account[] {
    return this.sql.prepare('SELECT pubkey, quota, added FROM accounts ORDER BY added').all() as unknown as Account[];
  }

  /** The account a key writes for, or null if it may not write here. */
  accountOf(key: string): Account | null {
    const r = this.sql.prepare('SELECT a.pubkey, a.quota, a.added FROM keys k JOIN accounts a ON a.pubkey = k.account WHERE k.key = ?').get(key);
    return (r as unknown as Account) ?? null;
  }

  /** Bytes charged to an account: each blob any of its keys owns, once, plus what it last let go of that's still in the bin. */
  usage(account: string): number {
    const r = this.sql.prepare(`SELECT COALESCE(SUM(size), 0) AS n FROM blobs WHERE sha256 IN
      (SELECT o.sha256 FROM owners o JOIN keys k ON k.key = o.key WHERE k.account = ?)
      OR (binned IS NOT NULL AND binned_by = ?)`).get(account, account);
    return Number(r!.n);
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

  /** Whether `size` more bytes for this blob fit in the account's quota, with `pending` bytes of uploads in flight. */
  fits(account: Account, sha256: string | null, size: number, pending = 0): boolean {
    if (account.quota === null) return true;
    if (sha256 && this.charged(account.pubkey, sha256)) return true;
    return this.usage(account.pubkey) + pending + size <= account.quota;
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
      if (!had) this.sql.prepare('INSERT INTO blobs (sha256, size, type, created, binned) VALUES (?, ?, ?, ?, NULL)').run(sha256, size, type, now);
      else if (had.binned !== null) this.sql.prepare('UPDATE blobs SET binned = NULL, binned_by = NULL WHERE sha256 = ?').run(sha256);
      this.sql.prepare('INSERT OR IGNORE INTO owners (sha256, key, uploaded) VALUES (?, ?, ?)').run(sha256, key, now);
      return !had;
    });
  }

  /** `key` lets go of its copy. When nobody owns the blob any more it goes to the bin. Returns whether `key` owned it. */
  disown(sha256: string, key: string, now: number): boolean {
    return this.tx(() => this.letGo(sha256, key, now));
  }

  private letGo(sha256: string, key: string, now: number): boolean {
    const gone = this.sql.prepare('DELETE FROM owners WHERE sha256 = ? AND key = ?').run(sha256, key).changes > 0;
    if (gone && !this.sql.prepare('SELECT 1 FROM owners WHERE sha256 = ?').get(sha256)) {
      const acc = this.sql.prepare('SELECT account FROM keys WHERE key = ?').get(key);
      this.sql.prepare('UPDATE blobs SET binned = ?, binned_by = ? WHERE sha256 = ?').run(now, (acc?.account as string) ?? null, sha256);
    }
    return gone;
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

  /** Erases a blob's row if it is still binned since before `before`. Returns whether it did. */
  erase(sha256: string, before: number): boolean {
    return this.sql.prepare('DELETE FROM blobs WHERE sha256 = ? AND binned IS NOT NULL AND binned < ?').run(sha256, before).changes > 0;
  }
}
