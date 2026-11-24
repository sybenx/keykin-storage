// The town list behind `names` (places.ts): the nearest town to a point, from GeoNames cities500 (CC BY 4.0), built
// into the image by scripts/towns.ts. Loaded once after the server starts listening, from a gzipped TSV, into flat
// typed arrays and a grid of 1° cells. The box never asks anyone else where a point is.

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

/** Farthest a town may be from the point, km. */
export const MAX_KM = 30;
/** Towns whose distances are within this of the nearest one's count as just as near: the bigger one wins, km. */
export const TIE_KM = 1;
const R = 6371.0088;
const KM_PER_DEG = (Math.PI / 180) * R;
const RAD = Math.PI / 180;
const NAMES = new TextDecoder();

export interface Town {
  town: string;
  /** The state, province or similar, or '' when the list has none. */
  region: string;
  country: string;
  /** ISO 3166 alpha-2. */
  cc: string;
  /** From the point looked up, rounded to 0.1. */
  km: number;
}

export type TownsState = 'loading' | 'ready' | 'none';

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const latCell = (lat: number) => Math.min(179, Math.max(0, Math.floor(lat + 90)));
const lonCell = (lon: number) => ((Math.floor(lon + 180) % 360) + 360) % 360;

export class Towns {
  readonly file: string;
  state: TownsState = 'loading';
  /** What list this is: the `version` line of SOURCE next to the file, else the start of the file's sha256. */
  version = '';
  /** How many towns are loaded. */
  count = 0;
  private lat = new Float32Array(0);
  private lon = new Float32Array(0);
  private pop = new Uint32Array(0);
  /** Every name as UTF-8, one after another; town i's is nameBytes[nameEnd[i - 1] .. nameEnd[i]). */
  private nameBytes = new Uint8Array(0);
  private nameEnd = new Uint32Array(0);
  /** Per town: an index into `places` (region) and into `lands` (cc and country). */
  private region = new Uint16Array(0);
  private land = new Uint16Array(0);
  private places: string[] = [];
  private lands: { cc: string; country: string }[] = [];
  /** Town indexes sorted by cell; cell c's towns are cellItems[cellStart[c] .. cellStart[c + 1]). */
  private cellStart = new Uint32Array(180 * 360 + 1);
  private cellItems = new Uint32Array(0);
  private loading: Promise<void> | null = null;
  private readonly log: (line: string) => void;

  constructor(file: string, log: (line: string) => void = () => {}) {
    this.file = file;
    this.log = log;
  }

  /** Reads the list (once; later calls get the same promise). Never throws: a list it can't read leaves state 'none'. */
  load(): Promise<void> {
    this.loading ??= this.read().catch((err) => {
      this.state = 'none';
      this.log(`towns: could not read the town list ${this.file}: ${(err as Error).message}. Town lookups answer "this box has no town list"`);
    });
    return this.loading;
  }

  private async read(): Promise<void> {
    let cap = 1 << 16, n = 0;
    let lat = new Float32Array(cap), lon = new Float32Array(cap), pop = new Uint32Array(cap);
    let region = new Uint16Array(cap), land = new Uint16Array(cap), nameEnd = new Uint32Array(cap);
    // names go straight into one byte array: a substring of a line would keep the whole line alive in V8
    let nameBytes = new Uint8Array(4 << 20), at = 0;
    const utf8 = new TextEncoder();
    /** A copy of a substring that holds nothing else alive. */
    const own = (s: string) => Buffer.from(s, 'utf8').toString('utf8');
    const placeIx = new Map<string, number>(), landIx = new Map<string, number>();
    const places: string[] = [], lands: { cc: string; country: string }[] = [];
    const grow = <T extends Float32Array | Uint32Array | Uint16Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(cap);
      b.set(a);
      return b;
    };
    const hash = createHash('sha256');
    const raw = createReadStream(this.file);
    const gunzip = createGunzip();
    raw.on('data', (c) => hash.update(c));
    const lines = createInterface({ input: raw.pipe(gunzip), crlfDelay: Infinity });
    // pipe() passes no errors on: a missing or broken file must end the read, not hang it or crash the box
    let failure: Error | null = null;
    const fail = (err: Error) => {
      failure ??= err;
      lines.close();
    };
    raw.on('error', fail);
    gunzip.on('error', fail);
    for await (const line of lines) {
      const f = line.split('\t');
      if (f.length < 7) continue;
      const la = Number(f[1]), lo = Number(f[2]);
      if (!f[0] || !Number.isFinite(la) || !Number.isFinite(lo) || la < -90 || la > 90 || lo < -180 || lo > 180) continue;
      if (n === cap) {
        cap *= 2;
        lat = grow(lat); lon = grow(lon); pop = grow(pop); region = grow(region); land = grow(land); nameEnd = grow(nameEnd);
      }
      if (at + f[0].length * 3 > nameBytes.length) {
        const b = new Uint8Array(nameBytes.length * 2);
        b.set(nameBytes);
        nameBytes = b;
      }
      at += utf8.encodeInto(f[0], nameBytes.subarray(at)).written;
      nameEnd[n] = at;
      lat[n] = la;
      lon[n] = lo;
      pop[n] = Math.min(Number(f[6]) || 0, 0xffffffff);
      // regions and countries repeat: one string each, kept once
      const lk = `${f[3]}\t${f[5]}`;
      let li = landIx.get(lk);
      if (li === undefined) {
        li = lands.push({ cc: own(f[3]), country: own(f[5]) }) - 1;
        landIx.set(lk, li);
      }
      let pi = placeIx.get(f[4]);
      if (pi === undefined) {
        pi = places.push(own(f[4])) - 1;
        placeIx.set(places[pi], pi);
      }
      if (li > 0xffff || pi > 0xffff) throw new Error('more than 65,536 regions or countries');
      land[n] = li;
      region[n] = pi;
      n++;
    }
    if (failure) throw failure;
    // the grid: count per cell, then place each town (a counting sort)
    const cellOf = new Uint32Array(n);
    const start = new Uint32Array(180 * 360 + 1);
    for (let i = 0; i < n; i++) {
      cellOf[i] = latCell(lat[i]) * 360 + lonCell(lon[i]);
      start[cellOf[i] + 1]++;
    }
    for (let c = 0; c < 180 * 360; c++) start[c + 1] += start[c];
    const items = new Uint32Array(n);
    const fill = start.slice(0, 180 * 360);
    for (let i = 0; i < n; i++) items[fill[cellOf[i]]++] = i;

    this.lat = lat.slice(0, n); this.lon = lon.slice(0, n); this.pop = pop.slice(0, n);
    this.region = region.slice(0, n); this.land = land.slice(0, n);
    this.nameBytes = nameBytes.slice(0, at); this.nameEnd = nameEnd.slice(0, n);
    this.places = places; this.lands = lands;
    this.cellStart = start; this.cellItems = items;
    this.count = n;
    this.version = sourceVersion(this.file) ?? `sha256-${hash.digest('hex').slice(0, 16)}`;
    this.state = 'ready';
    this.log(`towns: ${n} towns loaded (${this.version})`);
  }

  /**
   * The nearest town within MAX_KM, or null. Towns whose distances are within TIE_KM of the nearest count as just as
   * near, and the biggest of those wins. Looks in the point's 1° cell and the cells around it: one cell up and down
   * (1° of latitude is 111 km), and in longitude as many as 30 km spans at the poleward edge of each row (one cell
   * until about 74°, more above), across the date line.
   */
  nearest(lat: number, lon: number): Town | null {
    if (this.state !== 'ready') return null;
    const r0 = latCell(lat), c0 = lonCell(lon);
    let bestD = Infinity;
    const found: { i: number; d: number }[] = [];
    for (let r = r0 - 1; r <= r0 + 1; r++) {
      if (r < 0 || r > 179) continue;
      const edge = Math.max(Math.abs(r - 90), Math.abs(r - 89)); // the row's poleward edge, degrees
      const perDeg = KM_PER_DEG * Math.cos(edge * RAD);
      // +1: across a short span near a pole the great circle is a little shorter than the parallel
      const w = perDeg < 1e-6 ? 180 : Math.min(180, Math.ceil(MAX_KM / perDeg) + 1);
      const cells = 2 * w + 1 >= 360 ? 360 : 2 * w + 1;
      for (let k = 0; k < cells; k++) {
        const c = cells === 360 ? k : (((c0 - w + k) % 360) + 360) % 360;
        const cell = r * 360 + c;
        for (let j = this.cellStart[cell]; j < this.cellStart[cell + 1]; j++) {
          const i = this.cellItems[j];
          const d = distanceKm(lat, lon, this.lat[i], this.lon[i]);
          if (d > MAX_KM) continue;
          found.push({ i, d });
          if (d < bestD) bestD = d;
        }
      }
    }
    if (found.length === 0) return null;
    let pick = -1, pickD = Infinity;
    for (const { i, d } of found) {
      if (d > bestD + TIE_KM) continue;
      if (pick < 0 || this.pop[i] > this.pop[pick] || (this.pop[i] === this.pop[pick] && d < pickD)) {
        pick = i;
        pickD = d;
      }
    }
    const l = this.lands[this.land[pick]];
    const name = NAMES.decode(this.nameBytes.subarray(pick === 0 ? 0 : this.nameEnd[pick - 1], this.nameEnd[pick]));
    return { town: name, region: this.places[this.region[pick]], country: l.country, cc: l.cc, km: Math.round(pickD * 10) / 10 };
  }
}

/** The `version:` line of the SOURCE file next to the list, or null. */
function sourceVersion(file: string): string | null {
  try {
    const m = /^version:\s*(\S+)\s*$/m.exec(readFileSync(join(dirname(file), 'SOURCE'), 'utf8'));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
