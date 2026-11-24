// Build time only: turns GeoNames dump files into the town list the box answers `names` from (src/towns.ts).
//
//   node scripts/towns.ts <input folder> <output folder> [--downloaded YYYY-MM-DD]
//
// The input folder holds cities500.txt (unzipped from cities500.zip), admin1CodesASCII.txt and countryInfo.txt, all
// from https://download.geonames.org/export/dump/, and cities500.zip itself when there (only for its checksum). The
// output folder gets towns.tsv.gz and SOURCE (where the list came from, the sha256 of every input and of the output,
// and the licence line). Same inputs, same output bytes: rows keep the order of cities500.txt and gzip writes no time.
//
// GeoNames data is CC BY 4.0. The credit line in SOURCE travels with the list into the image.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { gzipSync } from 'node:zlib';

/**
 * Feature codes kept: populated places. Dropped among class P: PPLX (section of a town), PPLH (historical), PPLQ
 * (abandoned), PPLW (destroyed), PPLCH (historical capital), STLMT and anything else not listed.
 */
export const KEEP = new Set(['PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLA5', 'PPLC', 'PPLG', 'PPLS', 'PPLF', 'PPLL', 'PPLR']);

export const LICENCE = 'Town names: GeoNames (geonames.org), CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). ' +
  'Changed from the original: only populated places kept, reduced to name, position, region, country and population.';

/** A field as it goes into the TSV: no tabs or line breaks inside. */
const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ').trim();

/** admin1CodesASCII.txt: `CC.CODE<TAB>name<TAB>ascii name<TAB>geonameid` into CC.CODE → name. */
export function parseAdmin1(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f.length >= 2 && f[0] && !line.startsWith('#')) m.set(f[0], clean(f[1]));
  }
  return m;
}

/** countryInfo.txt: lines not starting with `#`, ISO code in column 0, the country's name in column 4. */
export function parseCountries(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length >= 5 && /^[A-Z]{2}$/.test(f[0])) m.set(f[0], clean(f[4]));
  }
  return m;
}

/**
 * One cities500.txt line into a TSV row `name, lat, lon, cc, region, country, population`, or null when it is not a
 * populated place this list keeps (or is malformed). Region and country are '' when GeoNames has no name for them.
 */
export function townRow(line: string, admin1: Map<string, string>, countries: Map<string, string>): string | null {
  const f = line.split('\t');
  if (f.length < 15) return null;
  const [, name, , , lat, lon, cls, code, cc] = f;
  if (cls !== 'P' || !KEEP.has(code)) return null;
  const la = Number(lat), lo = Number(lon);
  if (!name || !Number.isFinite(la) || !Number.isFinite(lo) || la < -90 || la > 90 || lo < -180 || lo > 180) return null;
  const pop = /^\d+$/.test(f[14]) ? f[14] : '0';
  const region = admin1.get(`${cc}.${f[10]}`) ?? '';
  return [clean(name), lat, lon, cc, region, countries.get(cc) ?? '', pop].join('\t');
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Reads the inputs, writes towns.tsv.gz and SOURCE. Returns how many towns were kept. */
export async function build(inDir: string, outDir: string, downloaded: string): Promise<number> {
  const admin1Text = readFileSync(join(inDir, 'admin1CodesASCII.txt'));
  const countryText = readFileSync(join(inDir, 'countryInfo.txt'));
  const admin1 = parseAdmin1(admin1Text.toString('utf8'));
  const countries = parseCountries(countryText.toString('utf8'));
  const rows: string[] = [];
  const citiesHash = createHash('sha256');
  const input = createReadStream(join(inDir, 'cities500.txt'));
  input.on('data', (c) => citiesHash.update(c));
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    const r = townRow(line, admin1, countries);
    if (r) rows.push(r);
  }
  // about 10 MB of text before gzip: fine at build time, and gzipSync keeps the bytes the same run to run
  const gz = gzipSync(Buffer.from(rows.join('\n') + '\n', 'utf8'), { level: 9 });
  gz[9] = 3; // the header's OS byte says Unix wherever it is built, so a Mac and the image make the same bytes
  writeFileSync(join(outDir, 'towns.tsv.gz'), gz);
  const outSha = sha256(gz);
  const zip = join(inDir, 'cities500.zip');
  const lines = [
    `version: geonames-${downloaded}-${outSha.slice(0, 8)}`,
    `source: https://download.geonames.org/export/dump/ (cities500.zip, admin1CodesASCII.txt, countryInfo.txt)`,
    `downloaded: ${downloaded}`,
    ...(existsSync(zip) ? [`sha256 cities500.zip: ${sha256(readFileSync(zip))}`] : []),
    `sha256 cities500.txt: ${citiesHash.digest('hex')}`,
    `sha256 admin1CodesASCII.txt: ${sha256(admin1Text)}`,
    `sha256 countryInfo.txt: ${sha256(countryText)}`,
    `sha256 towns.tsv.gz: ${outSha}`,
    `towns: ${rows.length}`,
    `feature codes kept: ${[...KEEP].join(' ')}`,
    `licence: ${LICENCE}`,
  ];
  writeFileSync(join(outDir, 'SOURCE'), lines.join('\n') + '\n');
  return rows.length;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--downloaded');
  const downloaded = at >= 0 ? args.splice(at, 2)[1] : new Date().toISOString().slice(0, 10);
  if (args.length !== 2 || !/^\d{4}-\d{2}-\d{2}$/.test(downloaded ?? '')) {
    console.error('usage: node scripts/towns.ts <input folder> <output folder> [--downloaded YYYY-MM-DD]');
    process.exit(2);
  }
  const n = await build(args[0], args[1], downloaded);
  console.log(`towns: ${n} kept`);
}
