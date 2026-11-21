// Blobs on disk: data/blobs/ab/cd/<sha256>. An upload streams into data/tmp while it's hashed, and is moved into
// place only after its hash is checked.

import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

export class TooLarge extends Error {}
/** The sender went away mid-upload. Not our fault, not worth a log line. */
export class Aborted extends Error {}

export interface Received {
  tmp: string;
  sha256: string;
  size: number;
}

export class Store {
  readonly root: string;
  private readonly tmpDir: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, 'blobs');
    this.tmpDir = join(dataDir, 'tmp');
    mkdirSync(this.root, { recursive: true });
    // anything left in tmp is from an upload that never finished
    rmSync(this.tmpDir, { recursive: true, force: true });
    mkdirSync(this.tmpDir, { recursive: true });
  }

  path(sha256: string): string {
    return join(this.root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  has(sha256: string): boolean {
    return existsSync(this.path(sha256));
  }

  /** Streams `body` to a temp file, hashing it. Throws TooLarge past `max` bytes; the temp file is gone then. */
  receive(body: Readable, max: number): Promise<Received> {
    const tmp = join(this.tmpDir, randomBytes(12).toString('hex'));
    const out = createWriteStream(tmp, { flags: 'wx' });
    const hash = createHash('sha256');
    let size = 0;
    return new Promise<Received>((resolve, reject) => {
      let done = false;
      const stop = (err: Error) => {
        if (done) return;
        done = true;
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
