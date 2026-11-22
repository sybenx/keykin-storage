// Blobs on disk: data/blobs/ab/cd/<sha256>. An upload streams into data/tmp while it's hashed, and is moved into
// place only after its hash is checked. An upload in pieces is one file, data/pieces/<id>, as long as the whole
// blob from the start: each piece is written at its own place in it, so there is nothing to join at the end, only
// the whole to hash before it is moved into place. That folder is kept across restarts, so uploads resume.

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, createReadStream, createWriteStream, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, renameSync,
  rmSync, statSync, unlinkSync, type WriteStream,
} from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

export class TooLarge extends Error {}
/** The sender went away mid-upload. Not our fault, not worth a log line. */
export class Aborted extends Error {}
/** The sender is too slow: under the minimum rate over a whole window. */
export class TooSlow extends Error {}

export interface MinRate {
  /** Length of the window, ms. */
  windowMs: number;
  /** Bytes per second the sender must average over each window. */
  bytesPerSecond: number;
  /** Bytes still expected in all (content-length), so the last short stretch isn't held to the full rate. */
  expected?: number | null;
}

export interface Received {
  tmp: string;
  sha256: string;
  size: number;
}

/** Where a blob's file lives: <dataDir>/blobs/ab/cd/<sha256>. */
export function blobPath(dataDir: string, sha256: string): string {
  return join(dataDir, 'blobs', sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

/** Removes a blob's file, if it is there. For the CLI, which must not construct a Store (that empties tmp). */
export function removeBlobFile(dataDir: string, sha256: string): void {
  try {
    unlinkSync(blobPath(dataDir, sha256));
  } catch {}
}

export class Store {
  readonly root: string;
  private readonly dataDir: string;
  private readonly tmpDir: string;
  private readonly piecesDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.root = join(dataDir, 'blobs');
    this.tmpDir = join(dataDir, 'tmp');
    this.piecesDir = join(dataDir, 'pieces');
    mkdirSync(this.root, { recursive: true });
    mkdirSync(this.piecesDir, { recursive: true });
    // anything left in tmp is from an upload that never finished
    rmSync(this.tmpDir, { recursive: true, force: true });
    mkdirSync(this.tmpDir, { recursive: true });
  }

  path(sha256: string): string {
    return blobPath(this.dataDir, sha256);
  }

  has(sha256: string): boolean {
    return existsSync(this.path(sha256));
  }

  /**
   * Streams `body` to a temp file, hashing it. Throws TooLarge past `max` bytes, and TooSlow when `rate` is given
   * and a window goes by with fewer bytes than it asks for; the temp file is gone then.
   */
  receive(body: Readable, max: number, rate?: MinRate): Promise<Received> {
    const tmp = join(this.tmpDir, randomBytes(12).toString('hex'));
    return pump(body, createWriteStream(tmp, { flags: 'wx' }), max, rate).then(
      (r) => ({ tmp, ...r }),
      (err) => {
        this.discard(tmp);
        throw err;
      },
    );
  }

  // --- uploads in pieces

  /** The file of an upload in pieces. */
  uploadPath(id: string): string {
    return join(this.piecesDir, id);
  }

  /** Makes an upload's file, `size` bytes long (sparse: disk is used as pieces arrive). */
  createUpload(id: string, size: number): void {
    const fd = openSync(this.uploadPath(id), 'wx');
    try {
      ftruncateSync(fd, size);
    } finally {
      closeSync(fd);
    }
  }

  /** The length of an upload's file, or null when there is none. */
  uploadSize(id: string): number | null {
    try {
      return statSync(this.uploadPath(id)).size;
    } catch {
      return null;
    }
  }

  /** The ids of every upload file. */
  uploadIds(): string[] {
    try {
      return readdirSync(this.piecesDir);
    } catch {
      return [];
    }
  }

  dropUpload(id: string): void {
    try {
      unlinkSync(this.uploadPath(id));
    } catch {}
  }

  /**
   * Streams one piece into an upload's file at `offset`, hashing it. Throws TooLarge past `max` bytes, TooSlow as
   * `receive` does, and Aborted when the sender goes away or `signal` fires. Settles only once the file is closed, so
   * another write of the same piece can start right after. Bytes written before a failure stay, but the piece is not
   * counted as received.
   */
  writePiece(id: string, offset: number, body: Readable, max: number, rate?: MinRate, signal?: AbortSignal): Promise<{ sha256: string; size: number }> {
    return pump(body, createWriteStream(this.uploadPath(id), { flags: 'r+', start: offset }), max, rate, signal);
  }

  /**
   * The sha256 of an upload's whole file, read as a stream in 1 MiB chunks: each chunk is hashed in a moment and the
   * event loop answers other requests in between, however big the file.
   */
  hashUpload(id: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const file = createReadStream(this.uploadPath(id), { highWaterMark: 1024 * 1024, signal });
      file.on('data', (c) => hash.update(c));
      file.on('error', reject);
      file.on('end', () => resolve(hash.digest('hex')));
    });
  }

  /** Moves a received file into place (synchronously, so it can sit in one step with the database write). */
  commit(r: Received): void {
    const dest = this.path(r.sha256);
    if (existsSync(dest)) return this.discard(r.tmp);
    mkdirSync(join(this.root, r.sha256.slice(0, 2), r.sha256.slice(2, 4)), { recursive: true });
    renameSync(r.tmp, dest);
  }

  discard(tmp: string): void {
    try {
      unlinkSync(tmp);
    } catch {}
  }

  remove(sha256: string): void {
    try {
      unlinkSync(this.path(sha256));
    } catch {}
  }
}

/**
 * Pipes `body` into `out`, hashing it. Throws TooLarge past `max` bytes, TooSlow when `rate` is given and a window
 * goes by with fewer bytes than it asks for, Aborted when the sender goes away or `signal` fires. Settles once `out`
 * is closed.
 */
function pump(body: Readable, out: WriteStream, max: number, rate?: MinRate, signal?: AbortSignal): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  return new Promise((resolve, reject) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const closed = (f: () => void) => (out.closed ? f() : out.once('close', f));
    if (rate) {
      const perWindow = (rate.bytesPerSecond * rate.windowMs) / 1000;
      let mark = 0;
      timer = setInterval(() => {
        const left = rate.expected != null ? rate.expected - mark : Infinity;
        if (size - mark < Math.min(perWindow, left)) stop(new TooSlow('upload too slow'));
        mark = size;
      }, rate.windowMs);
    }
    const onAbort = () => stop(new Aborted('upload aborted'));
    const stop = (err: Error) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      signal?.removeEventListener('abort', onAbort);
      body.unpipe(out);
      body.pause();
      out.destroy();
      closed(() => reject(err));
    };
    if (signal?.aborted) return stop(new Aborted('upload aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    body.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) return stop(new TooLarge());
      hash.update(chunk);
    });
    body.on('error', () => stop(new Aborted('upload aborted')));
    body.on('aborted', () => stop(new Aborted('upload aborted')));
    body.on('close', () => { if (!body.readableEnded) stop(new Aborted('upload aborted')); });
    out.on('error', stop);
    out.on('finish', () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      signal?.removeEventListener('abort', onAbort);
      closed(() => resolve({ sha256: hash.digest('hex'), size }));
    });
    body.pipe(out);
  });
}
