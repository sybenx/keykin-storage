// Runs the server from environment settings (see README). Stops cleanly on SIGTERM/SIGINT.

import { configFromEnv } from './config.ts';
import { npub } from './keys.ts';
import { start } from './server.ts';

let config: ReturnType<typeof configFromEnv>;
try {
  config = configFromEnv();
} catch (err) {
  console.error(`keykin-storage: not starting: ${(err as Error).message}`);
  process.exit(1);
}
const running = await start(config);
console.log(config.owner && config.publicUrl
  ? `keykin-storage on ${config.host}:${config.port}, ${config.publicUrl}, owner ${npub(config.owner)}`
  : `keykin-storage on ${config.host}:${config.port}, NOT SET UP: set STORAGE_PUBLIC_URL and STORAGE_OWNER; writes are refused until then`);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  running.close().then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
