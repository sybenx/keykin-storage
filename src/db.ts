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
  /** 1 when added by hand (the CLI, or the box owner): its quota is the one set by hand. */
  hand: number;
  /** 1 while the home's member list has it. */
  member: number;
}

/** A removal from the home's member list, as this box recorded it the first time it saw it. */
export interface Removal {
  pubkey: string;
  removedAt: number;
  deletesAt: number | null;
  reason: 'removed' | 'erased';
  /** When this box noticed. */
  noticed: number;
}

/** What this box knows about the home: kept in the database so a restart, or the CLI, sees the same. */
export interface HomeState {
  url: string | null;
  /** When the last good member list came in, and the list itself (JSON). */
  lastGood: number | null;
  list: string | null;
  lastTry: number | null;
  /** Why the last try failed (a HomeError kind and message), or null when it worked. */
  errorKind: string | null;
  error: string | null;
  /** Removals held back for `home apply` (JSON array of {pubkey, removedAt, reason}), and since when. */
  held: string | null;
  heldSince: number | null;
  /** The owner and the admins (JSON array of hex pubkeys) of the last good member list. */
  homeOwner: string | null;
  admins: string | null;
}

/** A blob in the bin, with the account its bytes count against (null when that account is gone). */
export interface Binned extends Blob {
  binned: number;
  charged: string | null;
}

/** A removed member's files waiting on their return: everything that comes back if they do. */
export interface Parked {
  pubkey: string;
  removedAt: number;
  reason: 'removed' | 'erased';
  /** Counted the way quotas count (each blob at least MIN_CHARGE bytes), so this is what comes back on their quota. */
  bytes: number;
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

const ACCOUNT_COLS = 'a.pubkey, a.quota, a.added, a.used, a.blobs, a.hand, a.member';

/** An upload in pieces that is open: what was promised, and how far it got. */
export interface Upload {
  id: string;
  /** The account that started it: the only one that may touch it. */
  account: string;
  sha256: string;
  size: number;
  type: string;
  /** Bytes in each piece but the last, fixed when the upload starts. */
  pieceSize: number;
  /** Bytes of the pieces received so far. */
  received: number;
  created: number;
  /** When it started or last got a piece: it is open until this plus the idle time. */
  touched: number;
}

const UPLOAD_COLS = 'id, account, sha256, size, type, piece_size AS pieceSize, received, created, touched';

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
  // 0.2.0: accounts that follow the home's member list
  (db) => db.sql.exec(`
    ALTER TABLE accounts ADD COLUMN hand INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE accounts ADD COLUMN member INTEGER NOT NULL DEFAULT 0;
    -- what a removed member's keys owned, so a member who comes back before the bin erases gets it back
    CREATE TABLE parked (
      account TEXT NOT NULL, sha256 TEXT NOT NULL REFERENCES blobs(sha256) ON DELETE CASCADE, key TEXT NOT NULL,
      uploaded INTEGER NOT NULL, PRIMARY KEY (account, sha256, key));
    CREATE INDEX parked_by_sha ON parked(sha256);
    -- removals from the home's list, recorded the first time they're seen (the home lists them for 14 days only)
    CREATE TABLE home_removed (
      pubkey TEXT PRIMARY KEY, removed_at INTEGER NOT NULL, deletes_at INTEGER, reason TEXT NOT NULL, noticed INTEGER NOT NULL);
    CREATE TABLE home_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), url TEXT, last_good INTEGER, list TEXT, last_try INTEGER, error_kind TEXT,
      error TEXT, held TEXT, held_since INTEGER);
    INSERT INTO home_state (id) VALUES (1);`),
  // 0.3.0: what is stored in all, kept by triggers on every insert and delete, so the management page reads one row
  (db) => db.sql.exec(`
    CREATE TABLE totals (id INTEGER PRIMARY KEY CHECK (id = 1), bytes INTEGER NOT NULL, blobs INTEGER NOT NULL);
    INSERT INTO totals (id, bytes, blobs) SELECT 1, COALESCE(SUM(size), 0), COUNT(*) FROM blobs;
    CREATE TRIGGER totals_in AFTER INSERT ON blobs BEGIN
      UPDATE totals SET bytes = bytes + NEW.size, blobs = blobs + 1 WHERE id = 1; END;
    CREATE TRIGGER totals_out AFTER DELETE ON blobs BEGIN
      UPDATE totals SET bytes = bytes - OLD.size, blobs = blobs - 1 WHERE id = 1; END;`),
  // 0.3.0: totals of each removed member's parked files, set when they are parked and lowered by a trigger when a
  // blob row goes (the bin, an erase), before the cascade takes the parked rows with it
  (db) => {
    db.sql.exec(`
      ALTER TABLE home_removed ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE home_removed ADD COLUMN blobs INTEGER NOT NULL DEFAULT 0;
      CREATE TRIGGER parked_out BEFORE DELETE ON blobs BEGIN
        UPDATE home_removed SET bytes = bytes - MAX(OLD.size, ${MIN_CHARGE}), blobs = blobs - 1
          WHERE pubkey IN (SELECT account FROM parked WHERE sha256 = OLD.sha256); END;`);
    for (const r of db.sql.prepare('SELECT pubkey FROM home_removed').all()) db.recountParked(r.pubkey as string);
  },
  // 0.3.0: the home's owner and admins, kept with the last good member list
  (db) => {
    db.sql.exec('ALTER TABLE home_state ADD COLUMN home_owner TEXT; ALTER TABLE home_state ADD COLUMN admins TEXT;');
    const list = db.sql.prepare('SELECT list FROM home_state WHERE id = 1').get()?.list;
    let owner: unknown = null;
    try {
      owner = typeof list === 'string' ? JSON.parse(list)?.owner : null;
    } catch {}
    if (typeof owner === 'string' && /^[0-9a-f]{64}$/.test(owner)) db.sql.prepare('UPDATE home_state SET home_owner = ? WHERE id = 1').run(owner);
  },
  // 0.4.0: uploads in pieces, kept here so they can resume after a restart. They go with their account. (IF NOT
  // EXISTS: a test winds a new database back to 0.2.0 by its user_version alone.)
  (db) => db.sql.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(pubkey) ON DELETE CASCADE, sha256 TEXT NOT NULL,
      size INTEGER NOT NULL, type TEXT NOT NULL, piece_size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL, touched INTEGER NOT NULL, UNIQUE (account, sha256));
    CREATE INDEX IF NOT EXISTS uploads_touched ON uploads(touched);
    CREATE TABLE IF NOT EXISTS upload_pieces (
      upload TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE, idx INTEGER NOT NULL, bytes INTEGER NOT NULL,
      PRIMARY KEY (upload, idx));`),
  // 0.6.0: place notes (places.ts). Small sealed files kept apart from blobs: never served by hash, listed or counted
  // in usage. They go with their account.
  (db) => db.sql.exec(`
    CREATE TABLE IF NOT EXISTS place_notes (
      sha TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(pubkey) ON DELETE CASCADE,
      bytes BLOB NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS place_notes_account ON place_notes(account, created);`),
];

export interface Owned extends Blob {
  uploaded: number;
}

export class Db {
  readonly sql: DatabaseSync;
  readonly maxBlobs: number;
  /**
   * Whether accounts that came only from the home's member list may write. The server sets it from whether a home
   * is set: with no home, only accounts added by hand write, as before members existed, and nothing is deleted.
   */
  membersWrite = true;
  private depth = 0;

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

  /** Runs `f` in one write transaction. Inside another transaction it just runs, as part of that one. */
  tx<T>(f: () => T): T {
    if (this.depth > 0) return f();
    this.sql.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const r = f();
      this.depth--;
      this.sql.exec('COMMIT');
      return r;
    } catch (err) {
      this.depth--;
      this.sql.exec('ROLLBACK');
      throw err;
    }
  }

  // --- accounts

  /** Adds an account by hand (its own pubkey becomes its key), or sets its quota by hand. A hand-set quota wins. */
  putAccount(pubkey: string, quota: number | null, now: number): void {
    this.tx(() => {
      this.sql.prepare(`INSERT INTO accounts (pubkey, quota, added, hand) VALUES (?, ?, ?, 1)
        ON CONFLICT(pubkey) DO UPDATE SET quota = excluded.quota, hand = 1`).run(pubkey, quota, now);
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
    const r = this.sql.prepare(`SELECT ${ACCOUNT_COLS} FROM keys k JOIN accounts a ON a.pubkey = k.account WHERE k.key = ?
      AND (a.hand = 1 OR ${this.membersWrite ? 1 : 0})`).get(key);
    return (r as unknown as Account) ?? null;
  }

  /** An account by its pubkey, whether or not it may write now. */
  account(pubkey: string): Account | null {
    return (this.sql.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts a WHERE a.pubkey = ?`).get(pubkey) as unknown as Account) ?? null;
  }

  // --- the home's member list

  /** Pubkeys the home's member list has, as last applied. */
  members(): string[] {
    return this.sql.prepare('SELECT pubkey FROM accounts WHERE member = 1 ORDER BY pubkey').all().map((r) => r.pubkey as string);
  }

  /** Sets the quota of every account that came only from the home (a hand-set quota is left alone). */
  setMemberQuota(quota: number): void {
    this.sql.prepare('UPDATE accounts SET quota = ? WHERE hand = 0').run(quota);
  }

  /**
   * Makes `pubkey` a member. A new account gets `quota`; an account added by hand keeps its own. What its keys
   * owned when it was last removed comes back, where the bin hasn't erased it yet.
   */
  joinMember(pubkey: string, quota: number, now: number): void {
    this.tx(() => {
      this.sql.prepare(`INSERT INTO accounts (pubkey, quota, added, hand, member) VALUES (?, ?, ?, 0, 1)
        ON CONFLICT(pubkey) DO UPDATE SET member = 1`).run(pubkey, quota, now);
      this.sql.prepare('INSERT OR IGNORE INTO keys (key, account) VALUES (?, ?)').run(pubkey, pubkey);
      const parked = this.sql.prepare('SELECT p.sha256, p.key, p.uploaded, b.size, b.type FROM parked p JOIN blobs b ON b.sha256 = p.sha256 WHERE p.account = ?').all(pubkey);
      for (const p of parked) {
        // only keys that still write for this account take their copies back
        if (this.accountKey(p.key as string) === pubkey) this.ownIn(p.sha256 as string, Number(p.size), p.type as string, p.key as string, Number(p.uploaded));
      }
      this.sql.prepare('DELETE FROM parked WHERE account = ?').run(pubkey);
      this.sql.prepare('DELETE FROM home_removed WHERE pubkey = ?').run(pubkey);
      this.recount(pubkey);
    });
  }

  /**
   * Takes `pubkey` off the member list. An account added by hand keeps working with its own quota. Otherwise the
   * account goes: for `removed`, what its keys owned is let go into the bin with the bin clock at `removedAt` (and
   * parked, so it can come back); for `erased`, what only it holds is erased now. Returns the hashes erased now
   * (delete their files after the transaction).
   */
  leaveMember(r: Removal, now: number): string[] {
    return this.tx(() => {
      this.sql.prepare(`INSERT INTO home_removed (pubkey, removed_at, deletes_at, reason, noticed) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(pubkey) DO UPDATE SET removed_at = excluded.removed_at, deletes_at = excluded.deletes_at, reason = excluded.reason`)
        .run(r.pubkey, r.removedAt, r.deletesAt, r.reason, r.noticed);
      const acc = this.account(r.pubkey);
      if (!acc) return [];
      if (acc.hand) {
        this.sql.prepare('UPDATE accounts SET member = 0 WHERE pubkey = ?').run(r.pubkey);
        return [];
      }
      if (r.reason === 'erased') return this.purgeAccount(r.pubkey, now) ?? [];
      const at = Math.min(r.removedAt, now);
      for (const k of this.sql.prepare('SELECT key FROM keys WHERE account = ?').all(r.pubkey).map((x) => x.key as string)) {
        for (const o of this.sql.prepare('SELECT sha256, uploaded FROM owners WHERE key = ?').all(k)) {
          this.sql.prepare('INSERT OR IGNORE INTO parked (account, sha256, key, uploaded) VALUES (?, ?, ?, ?)').run(r.pubkey, o.sha256, k, o.uploaded);
          this.letGo(o.sha256 as string, k, at);
        }
      }
      this.recountParked(r.pubkey);
      this.sql.prepare('DELETE FROM accounts WHERE pubkey = ?').run(r.pubkey);
      return [];
    });
  }

  /** Sets a removed member's parked totals from a full count of their parked rows. */
  recountParked(pubkey: string): void {
    this.sql.prepare(`UPDATE home_removed SET (bytes, blobs) = (SELECT COALESCE(SUM(MAX(size, ${MIN_CHARGE})), 0), COUNT(*)
      FROM blobs WHERE sha256 IN (SELECT sha256 FROM parked WHERE account = ?)) WHERE pubkey = ?`).run(pubkey, pubkey);
  }

  /** Removed members with parked files, removed after `since`, newest first. */
  parked(since: number): Parked[] {
    return this.sql.prepare(`SELECT pubkey, removed_at AS removedAt, reason, bytes, blobs FROM home_removed
      WHERE blobs > 0 AND removed_at > ? ORDER BY removed_at DESC`).all(since) as unknown as Parked[];
  }

  /** Removals recorded from the home, newest first. */
  removals(): Removal[] {
    return this.sql.prepare('SELECT pubkey, removed_at AS removedAt, deletes_at AS deletesAt, reason, noticed FROM home_removed ORDER BY removed_at DESC')
      .all() as unknown as Removal[];
  }

  homeState(): HomeState {
    const r = this.sql.prepare(`SELECT url, last_good AS lastGood, list, last_try AS lastTry, error_kind AS errorKind, error,
      held, held_since AS heldSince, home_owner AS homeOwner, admins FROM home_state WHERE id = 1`).get();
    return r as unknown as HomeState;
  }

  saveHomeState(s: Partial<HomeState>): void {
    const cols: Record<keyof HomeState, string> = {
      url: 'url', lastGood: 'last_good', list: 'list', lastTry: 'last_try', errorKind: 'error_kind', error: 'error', held: 'held', heldSince: 'held_since',
      homeOwner: 'home_owner', admins: 'admins',
    };
    const keys = Object.keys(s) as (keyof HomeState)[];
    if (keys.length === 0) return;
    this.sql.prepare(`UPDATE home_state SET ${keys.map((k) => `${cols[k]} = ?`).join(', ')} WHERE id = 1`).run(...keys.map((k) => s[k] ?? null));
  }

  /** The owner and admins of the last good member list (none before the first one, or from a home without admins). */
  homeRoles(): { owner: string | null; admins: string[] } {
    const r = this.sql.prepare('SELECT home_owner AS owner, admins FROM home_state WHERE id = 1').get();
    let admins: string[] = [];
    try {
      const a = typeof r?.admins === 'string' ? JSON.parse(r.admins) : [];
      if (Array.isArray(a)) admins = a.filter((x): x is string => typeof x === 'string');
    } catch {}
    return { owner: (r?.owner as string) ?? null, admins };
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
    return this.tx(() => this.ownIn(sha256, size, type, key, now));
  }

  /**
   * `own` for an upload or mirror, in one transaction: checks that `key` still writes for an account and that the
   * blob still fits, then calls `place` (which moves the file into place) and records the owner. A CLI `remove`
   * from another process can't land between the check and the write.
   */
  ownAsWriter(sha256: string, size: number, type: string, key: string, now: number, pending: (a: Account) => Pending, place: () => void):
      { ok: true; isNew: boolean } | { ok: false; status: number; reason: string } {
    return this.tx(() => {
      const account = this.accountOf(key);
      if (!account) return { ok: false, status: 403, reason: 'this key may not write here' };
      const why = this.refusal(account, sha256, size, pending(account));
      if (why) return { ok: false, status: 413, reason: why };
      place();
      return { ok: true, isNew: this.ownIn(sha256, size, type, key, now) };
    });
  }

  private ownIn(sha256: string, size: number, type: string, key: string, now: number): boolean {
    const had = this.blob(sha256);
    const account = this.accountKey(key);
    const was = account !== null && this.charged(account, sha256);
    const binnedBy = had && had.binned !== null ? this.binnedBy(sha256) : null;
    if (!had) this.sql.prepare('INSERT INTO blobs (sha256, size, type, created, binned) VALUES (?, ?, ?, ?, NULL)').run(sha256, size, type, now);
    else if (had.binned !== null) this.sql.prepare('UPDATE blobs SET binned = NULL, binned_by = NULL WHERE sha256 = ?').run(sha256);
    this.sql.prepare('INSERT OR IGNORE INTO owners (sha256, key, uploaded) VALUES (?, ?, ?)').run(sha256, key, now);
    const bytes = had ? had.size : size;
    if (account !== null && !was) this.charge(account, bytes, 1);
    // out of the bin: off the quota of whoever let go of it last, unless that's this account
    if (binnedBy !== null && binnedBy !== account) this.charge(binnedBy, bytes, -1);
    return !had;
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

  // --- uploads in pieces. An upload counts as open while `touched` is after `since` (now less the idle time).

  upload(id: string): Upload | null {
    return (this.sql.prepare(`SELECT ${UPLOAD_COLS} FROM uploads WHERE id = ?`).get(id) as unknown as Upload) ?? null;
  }

  /** Every upload row, open or not. */
  uploads(): Upload[] {
    return this.sql.prepare(`SELECT ${UPLOAD_COLS} FROM uploads`).all() as unknown as Upload[];
  }

  /** The account's open upload of this blob, if any. */
  uploadOf(account: string, sha256: string, since: number): Upload | null {
    return (this.sql.prepare(`SELECT ${UPLOAD_COLS} FROM uploads WHERE account = ? AND sha256 = ? AND touched > ?`)
      .get(account, sha256, since) as unknown as Upload) ?? null;
  }

  /**
   * What the account's open uploads hold back from its quota: each one's full size (at least MIN_CHARGE) and one
   * blob each, leaving out `except`. At most a few rows, read through the (account, sha256) index.
   */
  openFor(account: string, since: number, except: string | null = null): Pending {
    const r = this.sql.prepare(`SELECT COALESCE(SUM(MAX(size, ${MIN_CHARGE})), 0) AS bytes, COUNT(*) AS n FROM uploads
      WHERE account = ? AND touched > ? AND id IS NOT ?`).get(account, since, except)!;
    return { bytes: Number(r.bytes), n: Number(r.n) };
  }

  /** How many uploads are open on the whole box, and the bytes they still have to receive (held back from the disk). */
  openAll(since: number): { n: number; remaining: number } {
    const r = this.sql.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size - received), 0) AS remaining FROM uploads WHERE touched > ?').get(since)!;
    return { n: Number(r.n), remaining: Number(r.remaining) };
  }

  /**
   * Opens an upload for the account `key` writes for, in one transaction with the checks: `check` gets the account
   * and returns a refusal or null. A CLI `remove` can't land between the check and the write.
   */
  openUpload(key: string, u: Omit<Upload, 'account' | 'received'>, check: (a: Account) => { status: number; reason: string } | null):
      { ok: true; upload: Upload } | { ok: false; status: number; reason: string } {
    return this.tx(() => {
      const account = this.accountOf(key);
      if (!account) return { ok: false, status: 403, reason: 'this key may not write here' };
      const why = check(account);
      if (why) return { ok: false, ...why };
      this.sql.prepare(`INSERT INTO uploads (id, account, sha256, size, type, piece_size, received, created, touched)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(u.id, account.pubkey, u.sha256, u.size, u.type, u.pieceSize, u.created, u.touched);
      return { ok: true, upload: this.upload(u.id)! };
    });
  }

  /** The pieces received, in order. */
  pieces(id: string): number[] {
    return this.sql.prepare('SELECT idx FROM upload_pieces WHERE upload = ? ORDER BY idx').all(id).map((r) => Number(r.idx));
  }

  pieceCount(id: string): number {
    return Number(this.sql.prepare('SELECT COUNT(*) AS n FROM upload_pieces WHERE upload = ?').get(id)!.n);
  }

  /** Records a piece as received and the upload as touched. False when the upload is gone. */
  markPiece(id: string, idx: number, bytes: number, now: number): boolean {
    return this.tx(() => {
      if (!this.sql.prepare('SELECT 1 FROM uploads WHERE id = ?').get(id)) return false;
      const added = this.sql.prepare('INSERT OR IGNORE INTO upload_pieces (upload, idx, bytes) VALUES (?, ?, ?)').run(id, idx, bytes).changes;
      this.sql.prepare('UPDATE uploads SET received = received + ?, touched = ? WHERE id = ?').run(added ? bytes : 0, now, id);
      return true;
    });
  }

  /** Forgets a piece (it is being sent again). */
  unmarkPiece(id: string, idx: number): void {
    this.tx(() => {
      const r = this.sql.prepare('SELECT bytes FROM upload_pieces WHERE upload = ? AND idx = ?').get(id, idx);
      if (!r) return;
      this.sql.prepare('DELETE FROM upload_pieces WHERE upload = ? AND idx = ?').run(id, idx);
      this.sql.prepare('UPDATE uploads SET received = received - ? WHERE id = ?').run(r.bytes, id);
    });
  }

  /** Forgets an upload and its pieces. Returns whether it was there. Delete its file after. */
  dropUpload(id: string): boolean {
    return this.sql.prepare('DELETE FROM uploads WHERE id = ?').run(id).changes > 0;
  }

  /** Ids of uploads no longer open (touched at or before `since`). */
  expiredUploads(since: number): string[] {
    return this.sql.prepare('SELECT id FROM uploads WHERE touched <= ?').all(since).map((r) => r.id as string);
  }

  // --- place notes (places.ts)

  /**
   * Whether a key is on this box: the box owner, the home's owner (from the last good member list), or a key of an
   * account the home's member list has. Friends added by hand who are not members are not.
   */
  onBox(pubkey: string, boxOwner: string): boolean {
    if (pubkey === boxOwner) return true;
    if (pubkey === this.homeRoles().owner) return true;
    return this.accountOf(pubkey)?.member === 1;
  }

  /** Keeps a note for `account`. A sha already here is left as it is. Returns whether it is new. */
  putNote(sha: string, account: string, bytes: Uint8Array, now: number): boolean {
    return this.sql.prepare('INSERT OR IGNORE INTO place_notes (sha, account, bytes, created) VALUES (?, ?, ?, ?)')
      .run(sha, account, bytes, now).changes > 0;
  }

  /** Whether a note with this sha is here. */
  hasNote(sha: string): boolean {
    return !!this.sql.prepare('SELECT 1 FROM place_notes WHERE sha = ?').get(sha);
  }

  /** The notes here among `shas`, by sha. */
  getNotes(shas: string[]): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    const q = this.sql.prepare('SELECT bytes FROM place_notes WHERE sha = ?');
    for (const s of shas) {
      const r = q.get(s);
      if (r) out.set(s, r.bytes as Uint8Array);
    }
    return out;
  }

  /** Drops the notes among `shas` that `account` stored. Returns how many went. */
  dropNotes(account: string, shas: string[]): number {
    return this.tx(() => {
      const q = this.sql.prepare('DELETE FROM place_notes WHERE sha = ? AND account = ?');
      let n = 0;
      for (const s of shas) n += Number(q.run(s, account).changes);
      return n;
    });
  }

  noteCount(account: string): number {
    return Number(this.sql.prepare('SELECT COUNT(*) AS n FROM place_notes WHERE account = ?').get(account)!.n);
  }

  // --- the bin

  /**
   * Blobs in the bin, newest first, at most `limit` (all when not given), with the account each is charged to. Reads
   * the bin's index, not every blob.
   */
  binned(limit = -1): Binned[] {
    return this.sql.prepare(`SELECT b.sha256, b.size, b.type, b.created, b.binned, a.pubkey AS charged FROM blobs b
      LEFT JOIN accounts a ON a.pubkey = b.binned_by WHERE b.binned IS NOT NULL ORDER BY b.binned DESC LIMIT ?`).all(limit) as unknown as Binned[];
  }

  /** Every blob stored, binned ones included: their real bytes and how many. Kept by triggers, so one row read. */
  totals(): { bytes: number; blobs: number } {
    const r = this.sql.prepare('SELECT bytes, blobs FROM totals WHERE id = 1').get()!;
    return { bytes: Number(r.bytes), blobs: Number(r.blobs) };
  }

  /**
   * Takes a blob out of the bin. It goes back to `key` when given; otherwise to the account it is charged to, which
   * costs that account nothing more, or to `fallback` (the box owner) when that account is gone. Returns the key it
   * went back to, or null when the blob is not in the bin. Throws when there is nobody to give it to.
   */
  restore(sha256: string, now: number, to: { key?: string; fallback: string | null }): string | null {
    return this.tx(() => {
      const b = this.blob(sha256);
      if (!b || b.binned === null) return null;
      const by = this.binnedBy(sha256);
      const key = to.key ?? (by !== null && this.account(by) ? by : to.fallback);
      if (!key) throw new Error('the account it is charged to is gone: give the owner to restore it to (or set STORAGE_OWNER)');
      this.ownIn(b.sha256, b.size, b.type, key, now);
      return key;
    });
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
