// Runs the box on this machine for the app's device tests (docs/local-run.md): a fresh temp data folder, the member
// list read from a JSON file instead of a live home, and a town list from a file (the small fixture by default).
// Nothing here talks to a relay or to any other server. Ctrl-C (or SIGTERM) stops it and removes the temp folder.
//
//   LOCAL_MEMBERS=test/fixtures/members-local.json STORAGE_PORT=7581 node scripts/local.ts
//
// The members file: {"owner": "<npub or hex>", "members": ["<npub or hex>", ...]}. It is read again at every poll
// (STORAGE_HOME_POLL_S, 10 s here) and when an unknown key calls (at most once a minute), so editing it adds or
// removes people while the box runs. Anyone dropped from it is removed as the home would remove them.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configFromEnv } from '../src/config.ts';
import { HomeError, parseReply, type HomeSource } from '../src/home.ts';
import { npub, parsePubkey } from '../src/keys.ts';
import { start } from '../src/server.ts';

const repo = resolve(import.meta.dirname, '..');
const env = { ...process.env };
const membersFile = resolve(env.LOCAL_MEMBERS || join(repo, 'test/fixtures/members-local.json'));

/** The members file as the home's memberkeys reply: npubs or hex, checked by the same parser. */
function readMembers(): { owner: string; members: string[]; removed: never[]; admins: string[] } {
  const j = JSON.parse(readFileSync(membersFile, 'utf8'));
  const hex = (s: unknown) => {
    const k = typeof s === 'string' ? parsePubkey(s) : null;
    if (!k) throw new HomeError('malformed', `${membersFile}: ${JSON.stringify(s)} is not an npub or hex pubkey`);
    return k;
  };
  const result = { owner: hex(j.owner), members: (j.members ?? []).map(hex), removed: [], admins: (j.admins ?? []).map(hex) };
  parseReply(JSON.stringify({ result }));
  return result;
}

let first: ReturnType<typeof readMembers>;
try {
  first = readMembers();
} catch (err) {
  console.error(`local: cannot read the members file ${membersFile}: ${(err as Error).message}`);
  process.exit(1);
}

const madeDir = !env.STORAGE_DIR;
if (madeDir) env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'keykin-storage-local-'));
env.STORAGE_ADDR ||= '127.0.0.1';
env.STORAGE_PORT ||= '7581';
env.STORAGE_PUBLIC_URL ||= `http://127.0.0.1:${env.STORAGE_PORT}`;
env.STORAGE_OWNER ||= first.owner;
env.STORAGE_TOWNS ||= join(repo, 'test/fixtures/towns-small.tsv.gz');
env.STORAGE_HOME_POLL_S ||= '10';

let config: ReturnType<typeof configFromEnv>;
try {
  config = configFromEnv(env);
} catch (err) {
  console.error(`local: not starting: ${(err as Error).message}`);
  process.exit(1);
}
config.homeUrl = `file://${membersFile}`; // a home is set, so members count; the keeper stays off (it needs a relay)
config.keeper = false;
const source: HomeSource = { fetch: async () => readMembers() };

const cleanUp = () => {
  if (madeDir) rmSync(config.dataDir, { recursive: true, force: true });
};
let running: Awaited<ReturnType<typeof start>>;
try {
  running = await start(config, { homeSource: source });
} catch (err) {
  cleanUp();
  throw err;
}
await running.home!.sync();
console.log(`local box on ${config.host}:${config.port}, public url ${config.publicUrl}`);
console.log(`data ${config.dataDir}${madeDir ? ' (removed on exit)' : ''}`);
console.log(`box owner ${npub(config.owner)}; home owner ${npub(first.owner)}; ${first.members.length} members from ${membersFile}`);
console.log(`towns ${config.towns}`);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  running.close().then(() => {
    cleanUp();
    process.exit(0);
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
