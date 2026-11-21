# Keykin Storage

A Blossom server for your Keykin box. Your account and the friends you add can store files on it. Anyone can
read a file by its hash (vault files are encrypted, so that's fine). Nothing is deleted behind your back: a
file nobody owns any more waits 30 days in a bin first.

See [DESIGN.md](DESIGN.md) for why it exists and where it's going (the keeper, key grants, the admin page).

## What works now (0.1.0)

- **BUD-01** `GET/HEAD /<sha256>[.ext]`: Range requests, CORS, `nosniff` and a sandbox CSP on every blob.
- **BUD-02** `PUT /upload`: streamed to disk and hashed as it arrives, checked against the auth `x` tag (and
  `X-SHA-256` when sent) before it's kept. 201 for a new blob, 200 for one already here.
- **BUD-04** `PUT /mirror`: fetches over http(s) only, never to loopback, private, link-local, CGNAT or tailnet
  addresses (checked on every connection and redirect), at most 5 redirects, with a timeout and the size cap.
- **BUD-06** `HEAD /upload`: answers what the upload would.
- **BUD-11** auth: kind 24242, valid signature, `created_at` not in the future, `expiration` in the future,
  `t` for the action, and a `server` tag naming this server (**required**).
- **BUD-12** `GET /list/<pubkey>`: your own blobs only, newest first, `cursor` and `limit`.
  `DELETE /<sha256>`: lets go of **your key's** copy. Other keys' copies stay. A blob nobody owns goes to the
  bin, is still served, and is erased after 30 days unless someone stores it again.
- **Accounts and quotas:** the owner has no limit. Each friend has a quota in bytes, charged once per blob
  however many of their keys hold it. What a friend deleted stays on their quota until the bin erases it.
- **Limits:** 4 uploads or mirrors in flight per account and 32 in all (429 past that). Uploads stop with 507 when
  less than 1 GB of disk would be left. A connection that sends nothing for a minute is closed.
- `/mirror` skips the fetch only when your account already holds that one blob. Otherwise it fetches and keeps
  what the url actually serves, if that's one of your `x` tags.

Not here: BUD-05 media, BUD-07 payments, BUD-08, BUD-09 reports.

## Run it

Node 24 or newer.

```bash
npm install
```

```bash
STORAGE_PUBLIC_URL=https://storage.example.com STORAGE_OWNER=npub1… npm start
```

| Variable | Default | |
|---|---|---|
| `STORAGE_PUBLIC_URL` | (required) | The address people reach this server at |
| `STORAGE_OWNER` | (required) | Your npub. Your account has no quota |
| `STORAGE_DOMAINS` | the public URL's host | Comma-separated domains a `server` tag may name |
| `STORAGE_DIR` | `./data` | Database (`storage.db`) and blobs |
| `STORAGE_ADDR` / `STORAGE_PORT` | `0.0.0.0` / `7480` | |
| `STORAGE_MAX_BLOB_MB` | `256` | Largest blob. Vault parts are under 8 MiB |
| `STORAGE_BIN_DAYS` | `30` | |
| `STORAGE_MIRROR_TIMEOUT_S` | `120` | |

## On Umbrel

Install Keykin Storage from the Keykin community store (github.com/sybenx/keykin-umbrel). In its settings, set
`STORAGE_PUBLIC_URL` to the address your tunnel or reverse proxy gives it, and `STORAGE_OWNER` to your npub.
Until both are set it refuses uploads with 503 and says so on its page. Then put that address first in your
Nostr server list (kind 10063).

On the box, the commands below run inside the container:

```bash
docker exec keykin-storage_server_1 node src/cli.ts add npub1… 50G
```

## Friends and the bin

Until the admin page exists:

```bash
npm run accounts -- add npub1… 50G
```

```bash
npm run accounts -- accounts
```

```bash
npm run accounts -- remove npub1…
```

```bash
npm run accounts -- bin
```

```bash
npm run accounts -- restore <sha256>
```

Removing a friend lets go of everything their keys held. What nobody else holds goes to the bin.

## Tests

```bash
npm test
```

They run servers on loopback ports in temp folders and close them at the end.
