// The town list: scripts/towns.ts (build time) and src/towns.ts (the lookup), against hand-written GeoNames lines and
// the small fixture list. No network.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { build, KEEP, LICENCE, parseAdmin1, parseCountries, townRow } from '../scripts/towns.ts';
import { distanceKm, Towns } from '../src/towns.ts';
import { tempDir } from './helpers.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');

/** A cities500.txt line: the 19 tab-separated GeoNames columns. */
const geo = (id: number, name: string, lat: string, lon: string, cls: string, code: string, cc: string, admin1: string, pop: string) =>
  [id, name, name, '', lat, lon, cls, code, cc, '', admin1, '', '', '', pop, '', '1000', 'America/Denver', '2024-01-01'].join('\t');

const ADMIN1 = 'US.UT\tUtah\tUtah\t5549030\nCA.01\tAlberta\tAlberta\t5883102\n';
const COUNTRIES = '#ISO\tISO3\tISO-Numeric\tfips\tCountry\n#CA\tcomment\nUS\tUSA\t840\tUS\tUnited States\tWashington\nCA\tCAN\t124\tCA\tCanada\tOttawa\n';

const LINES = [
  geo(1, 'Moab', '38.5733', '-109.5498', 'P', 'PPL', 'US', 'UT', '5366'),
  geo(2, 'Salt Lake City', '40.76078', '-111.89105', 'P', 'PPLA', 'US', 'UT', '200567'),
  geo(3, 'Downtown Moab', '38.57', '-109.55', 'P', 'PPLX', 'US', 'UT', '0'), // a section of a town
  geo(4, 'Old Moab', '38.6', '-109.6', 'P', 'PPLH', 'US', 'UT', '0'), // historical
  geo(5, 'Ghostville', '38.7', '-109.7', 'P', 'PPLQ', 'US', 'UT', '0'), // abandoned
  geo(6, 'Flattened', '38.8', '-109.8', 'P', 'PPLW', 'US', 'UT', '0'), // destroyed
  geo(7, 'Old Capital', '38.9', '-109.9', 'P', 'PPLCH', 'US', 'UT', '0'), // historical capital
  geo(8, 'Arches', '38.7', '-109.5', 'L', 'PRK', 'US', 'UT', '0'), // not a populated place
  geo(9, 'Banff', '51.1784', '-115.5708', 'P', 'PPLA3', 'CA', '01', '7851'),
  geo(10, 'Ottawa', '45.41117', '-75.69812', 'P', 'PPLC', 'CA', '08', '812129'), // region not in admin1
  geo(11, 'Nowhere', '1', '2', 'P', 'PPL', 'ZZ', '00', ''), // country unknown, population empty
  ...['PPLA2', 'PPLA4', 'PPLA5', 'PPLG', 'PPLS', 'PPLF', 'PPLL', 'PPLR'].map((c, i) => geo(20 + i, `Place ${c}`, '10', '10', 'P', c, 'US', 'UT', '1')),
];

describe('10. scripts/towns.ts', () => {
  it('keeps populated places and drops sections, historical, abandoned and destroyed places', () => {
    const admin1 = parseAdmin1(ADMIN1), countries = parseCountries(COUNTRIES);
    assert.equal(countries.get('US'), 'United States');
    assert.equal(countries.has('#C'), false);
    const kept = LINES.map((l) => townRow(l, admin1, countries)).filter((r) => r !== null);
    assert.deepEqual(kept.slice(0, 5), [
      'Moab\t38.5733\t-109.5498\tUS\tUtah\tUnited States\t5366',
      'Salt Lake City\t40.76078\t-111.89105\tUS\tUtah\tUnited States\t200567',
      'Banff\t51.1784\t-115.5708\tCA\tAlberta\tCanada\t7851',
      'Ottawa\t45.41117\t-75.69812\tCA\t\tCanada\t812129',
      'Nowhere\t1\t2\tZZ\t\t\t0',
    ]);
    assert.deepEqual(kept.slice(5).map((r) => r.split('\t')[0]), ['PPLA2', 'PPLA4', 'PPLA5', 'PPLG', 'PPLS', 'PPLF', 'PPLL', 'PPLR'].map((c) => `Place ${c}`));
    assert.deepEqual([...KEEP].sort(), ['PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLA5', 'PPLC', 'PPLF', 'PPLG', 'PPLL', 'PPLR', 'PPLS']);
    assert.equal(townRow('too\tshort', admin1, countries), null);
    assert.equal(townRow(geo(1, 'Bad', 'x', '1', 'P', 'PPL', 'US', 'UT', '1'), admin1, countries), null);
  });

  it('writes towns.tsv.gz and SOURCE with the checksums and the licence line; the same inputs give the same bytes', async () => {
    const dir = tempDir();
    try {
      const inDir = join(dir, 'in'), out1 = join(dir, 'out1'), out2 = join(dir, 'out2');
      for (const d of [inDir, out1, out2]) mkdirSync(d);
      writeFileSync(join(inDir, 'cities500.txt'), LINES.join('\n') + '\n');
      writeFileSync(join(inDir, 'admin1CodesASCII.txt'), ADMIN1);
      writeFileSync(join(inDir, 'countryInfo.txt'), COUNTRIES);
      assert.equal(await build(inDir, out1, '2026-11-24'), 13);
      await build(inDir, out2, '2026-11-24');
      const gz = readFileSync(join(out1, 'towns.tsv.gz'));
      assert.deepEqual(gz, readFileSync(join(out2, 'towns.tsv.gz')));
      assert.equal(gunzipSync(gz).toString('utf8').split('\n')[0], 'Moab\t38.5733\t-109.5498\tUS\tUtah\tUnited States\t5366');
      const source = readFileSync(join(out1, 'SOURCE'), 'utf8');
      const gzSha = createHash('sha256').update(gz).digest('hex');
      const citiesSha = createHash('sha256').update(LINES.join('\n') + '\n').digest('hex');
      assert.match(source, new RegExp(`^version: geonames-2026-11-24-${gzSha.slice(0, 8)}$`, 'm'));
      assert.match(source, new RegExp(`^sha256 towns.tsv.gz: ${gzSha}$`, 'm'));
      assert.match(source, new RegExp(`^sha256 cities500.txt: ${citiesSha}$`, 'm'));
      assert.match(source, /^sha256 admin1CodesASCII.txt: [0-9a-f]{64}$/m);
      assert.match(source, /^towns: 13$/m);
      assert.ok(source.includes(`licence: ${LICENCE}`));
      assert.match(LICENCE, /^Town names: GeoNames \(geonames.org\), CC BY 4.0/);
      // the box reads it, with the version from SOURCE
      const t = new Towns(join(out1, 'towns.tsv.gz'));
      await t.load();
      assert.equal(t.state, 'ready');
      assert.equal(t.count, 13);
      assert.equal(t.version, `geonames-2026-11-24-${gzSha.slice(0, 8)}`);
      assert.equal(t.nearest(38.57, -109.55)?.town, 'Moab');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the fixture town list', () => {
  it('towns-small.tsv.gz is towns-small.tsv', () => {
    assert.equal(gunzipSync(readFileSync(join(FIXTURES, 'towns-small.tsv.gz'))).toString('utf8'), readFileSync(join(FIXTURES, 'towns-small.tsv'), 'utf8'));
  });

  it('loads into the grid and answers outside it with null', async () => {
    const t = new Towns(join(FIXTURES, 'towns-small.tsv.gz'));
    assert.equal(t.state, 'loading');
    assert.equal(t.nearest(38.57, -109.55), null);
    await t.load();
    assert.equal(t.count, 20);
    assert.equal(t.nearest(-60, 0), null);
    assert.equal(t.nearest(90, 0), null);
    assert.equal(t.nearest(-90, 180), null);
    assert.equal(t.nearest(48.85, 2.35)?.region, 'Île-de-France');
  });

  it('a missing, cut-off or not gzipped list ends the load with state none and one log line', async () => {
    const dir = tempDir();
    try {
      const gz = readFileSync(join(FIXTURES, 'towns-small.tsv.gz'));
      writeFileSync(join(dir, 'cut.gz'), gz.subarray(0, 300));
      writeFileSync(join(dir, 'plain.gz'), 'Moab\t38.5\t-109.5\tUS\tUtah\tUnited States\t1\n');
      for (const f of [join(dir, 'missing.gz'), join(dir, 'cut.gz'), join(dir, 'plain.gz'), dir]) {
        const lines: string[] = [];
        const t = new Towns(f, (l) => lines.push(l));
        await t.load();
        assert.equal(t.state, 'none', f);
        assert.equal(t.nearest(38.57, -109.55), null);
        assert.equal(lines.length, 1);
        assert.match(lines[0], /could not read the town list/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('measures distance along the great circle', () => {
    assert.ok(Math.abs(distanceKm(0, 0, 0, 1) - 111.19) < 0.01);
    assert.ok(Math.abs(distanceKm(0, 179.9, 0, -179.9) - 22.24) < 0.01);
    assert.equal(distanceKm(10, 10, 10, 10), 0);
  });
});
