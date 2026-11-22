// Blobs on disk: data/blobs/ab/cd/<sha256>. An upload streams into data/tmp while it's hashed, and is moved into
// place only after its hash is checked.

import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, unlinkSync } from 'node:fs';
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

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.root = join(dataDir, 'blobs');
    this.tmpDir = join(dataDir, 'tmp');
    mkdirSync(this.root, { recursive: true });
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
    const out = createWriteStream(tmp, { flags: 'wx' });
    const hash = createHash('sha256');
    let size = 0;
    return new Promise<Received>((resolve, reject) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      if (rate) {
        const perWindow = (rate.bytesPerSecond * rate.windowMs) / 1000;
        let mark = 0;
        timer = setInterval(() => {
          const left = rate.expected != null ? rate.expected - mark : Infinity;
          if (size - mark < Math.min(perWindow, left)) stop(new TooSlow('upload too slow'));
          mark = size;
        }, rate.windowMs);
      }
      const stop = (err: Error) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        body.unpipe(out);
        body.pause();
        // the file may not exist yet; remove it once the stream has closed either way
        out.once('close', () => this.discard(tmp));
        out.destroy();
        reject(err);
      };
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
        resolve({ tmp, sha256: hash.digest('hex'), size });
      });
      body.pipe(out);
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
