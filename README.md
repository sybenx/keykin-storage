# Keykin Storage

A Blossom server for your Keykin box. Your account and the friends you add can store files on it. Anyone can
read a file by its hash (vault files are encrypted, so that's fine). Nothing is deleted behind your back: a
file nobody owns any more waits 30 days in a bin first.

See [DESIGN.md](DESIGN.md) for why it exists and where it's going (the keeper, key grants, the admin page).

## What works now (0.3.0)

- **BUD-01** `GET/HEAD /<sha256>[.ext]`: Range requests, CORS, `nosniff` and a sandbox CSP on every blob. Images
  (not SVG), video and audio are served as their type; everything else, SVG included, as
  `application/octet-stream` with `content-disposition: attachment`, so nothing runs as a page on this domain.
  Cached for one day (`public, max-age=86400`), not forever, so a take-down can stick.
- **BUD-02** `PUT /upload`: streamed to disk and hashed as it arrives, checked against the auth `x` tag (and
  `X-SHA-256` when sent) before it's kept. 201 for a new blob, 200 for one already here.
- **BUD-04** `PUT /mirror`: **for the box owner only** (403 for others: a mirror makes the box fetch someone
  else's url from your home address). Fetches over http(s) only, never to loopback, private, link-local, CGNAT,
  tailnet or IPv4-mapped and -translated IPv6 addresses (checked on every connection and redirect), at most
  5 redirects, with a timeout and the size cap.
- **BUD-06** `HEAD /upload`: answers what the upload would.
- **BUD-11** auth: kind 24242, valid signature, `created_at` not in the future and at most 25 hours old,
  `expiration` in the future and at most 25 hours ahead, `t` for the action, at most 16 `x` tags, and a
  `server` tag naming this server (**required**). A write from a key with no account here is refused before its
  signature is checked.
- **BUD-12** `GET /list/<pubkey>`: your own blobs only, newest first, `cursor` and `limit`.
  `DELETE /<sha256>`: lets go of **your key's** copy. Other keys' copies stay. A blob nobody owns goes to the
  bin, is still served, and is erased after 30 days unless someone stores it again.
- **Accounts and quotas:** the owner has no limit. Each friend has a quota in bytes, charged once per blob
  however many of their keys hold it, and each blob costs at least 4 KiB. An account with a quota holds at most
  200,000 blobs. What a friend deleted stays on their quota until the bin erases it.
- **Members of your home:** with `STORAGE_HOME_URL` set, the members of your home (your private relay) may
  upload here with the member quota, and stop being able to the moment the home removes them. See below.
- **Limits:** 4 uploads or mirrors in flight per account and 32 in all (429 past that). Signed requests from one
  address: 60 at once, then 10 a second (429 past that). Uploads stop with 507 when less than 1 GB of disk would
  be left. A connection that sends nothing for a minute is closed, and an upload that averages under 16 KiB a
  second over a minute is cut off (408).
- `/mirror` skips the fetch only when your account already holds that one blob. Otherwise it fetches and keeps
  what the url actually serves, if that's one of your `x` tags.
- **Management** `POST /manage`: disk use, accounts, the bin, restore and erase, for a web page signed in as the
  box owner or one of the home's admins. See below.

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
| `STORAGE_DIR` | `./data` | Database (`storage.db`), blobs and this storage's key (`service-key`) |
| `STORAGE_ADDR` / `STORAGE_PORT` | `0.0.0.0` / `7480` | |
| `STORAGE_MAX_BLOB_MB` | `256` | Largest blob. Vault parts are under 8 MiB |
| `STORAGE_MAX_BLOBS` | `200000` | Most blobs an account with a quota may hold |
| `STORAGE_BIN_DAYS` | `30` | |
| `STORAGE_MIRROR_TIMEOUT_S` | `120` | |
| `STORAGE_BEHIND_CLOUDFLARE` | `false` | Set to `true` behind a Cloudflare Tunnel, so the per-address limit uses `CF-Connecting-IP`. Leave it off when people can reach the port without Cloudflare, since anyone can send that header |
| `STORAGE_HOME_URL` | (none) | Your home's https address. When set, its members may upload here |
| `STORAGE_MEMBER_QUOTA` | `5G` | Quota of each member of the home |
| `STORAGE_HOME_POLL_S` | `300` | How often to ask the home for its member list |

Numbers must be positive numbers (`256`, not `256M`; quotas take `5G`, `500M`). A setting it can't read stops
the server at start, with one line naming the setting.

Behind a Cloudflare Tunnel, set `STORAGE_BEHIND_CLOUDFLARE=true`. Without it every request seems to come from
the tunnel, so everyone shares one address's allowance of signed requests.

## On Umbrel

Install Keykin Storage from the Keykin community store (github.com/sybenx/keykin-umbrel). In its settings, set
`STORAGE_PUBLIC_URL` to the address your tunnel or reverse proxy gives it, and `STORAGE_OWNER` to your npub.
Until both are set it refuses uploads with 503 and says so on its page. Then put that address first in your
Nostr server list (kind 10063).

On the box, the commands below run inside the container:

```bash
docker exec keykin-storage_server_1 node src/cli.ts add npub1… 50G
```

## Members of your home

Your home is the private relay your friends and family use. Its member list says who may upload here, with no
step on this box: someone you add on the home can upload right away, and someone you remove there can't from
the next check (every 5 minutes).

1. On first start this storage makes its own key and prints its public key. Show it again with:

   ```bash
   npm run accounts -- home key
   ```

2. Register that key on your home as its storage.
3. Set `STORAGE_HOME_URL` to your home's https address and restart.

```bash
npm run accounts -- home status
```

```bash
npm run accounts -- home sync
```

```bash
npm run accounts -- home apply
```

`home status` shows the home, this storage's key, when the member list last came in, how many members there
are, and anything held. `home sync` asks the home now.

- Members get `STORAGE_MEMBER_QUOTA`. Your home's owner may upload too, with no limit when it's you
  (`STORAGE_OWNER`).
- When the home can't be reached, answers with an error, or sends something that isn't a member list, nothing
  changes: storage keeps the last good list.
- When one check would remove more than half of 4 or more members, or the list comes back empty, storage holds
  those removals and logs one line. Check the home, then run `home apply`.
- A removed member's files go to the bin for 30 days, counted from when the home removed them. If they come back
  before then, they get their files back. Someone who deleted their own account on the home has the files only
  they held erased at once.
- Friends you added by hand keep working and keep their own quota, whether or not they are also members. If you
  unset `STORAGE_HOME_URL`, accounts that came from the home can't upload until you set it again; nothing is
  deleted.

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

`restore` gives the blob back to the account it is charged to, or to you when that account is gone. Name an npub
after the hash to give it to someone else.

Removing a friend lets go of everything their keys held. What nobody else holds goes to the bin. A friend who
is also a member of your home comes back at the next check; remove them on the home to keep them out.

To take something down now, without the 30 days in the bin:

```bash
npm run accounts -- erase <sha256>
```

```bash
npm run accounts -- remove npub1… --purge
```

`erase` removes one blob's record and file at once, whoever holds it. `remove --purge` removes the account and
erases everything only that account holds (blobs someone else also holds stay). Blobs are served with a one-day
cache lifetime, so after an erase also purge the blob's URL from your edge cache (on Cloudflare: Caching,
Configuration, Purge by URL), or it may be served from there for up to a day.

## Management (`POST /manage`)

A web page can show disk use and the bin, and restore or erase what is in it. Who may:

- **owner:** `STORAGE_OWNER`, or the owner your home reports. Everything.
- **admin:** a key in the `admins` list your home sends with its member list. Everything but `erase`. A home that
  sends no `admins` has none. When the home can't be reached, the last good list of admins stays.

Anyone else, members included, gets 401. The signature is checked before anything about the key, and every
refusal after a good signature reads `{"error": "this key may not manage this box"}`, an admin calling `erase`
included. So no answer tells someone who can't sign as a key whether that key is the owner or an admin (your home
keeps its admin list private).

### Request

```
POST <STORAGE_PUBLIC_URL>/manage
Content-Type: application/nostr+json+rpc
Authorization: Nostr <base64 of a signed kind 27235 event>

{"method":"usage","params":[]}
```

The event's tags: `u` is `STORAGE_PUBLIC_URL` followed by `/manage` (a slash left on the end of the public url is
all right: `https://x//manage` works too, `https://x/manage/` does not), `method` is `POST`, `payload` is the hex
sha256 of the exact body bytes. `created_at` must be within 60 seconds of the box's clock, either way. Content is
not read. The body is at most 64 KiB. `info` needs no `Authorization`.

### Replies

HTTP 200 with `{"result": …}`, or HTTP 200 with `{"error": "…"}` for a call that can't be done (unknown method, bad
params). Every other status also has a JSON body `{"error": "…"}`:

| Status | When |
|---|---|
| 401 | no or bad `Authorization` (the reason says what is wrong with it, the same whoever it names), or a good signature from a key that may not do this: always `this key may not manage this box` |
| 400 | the body isn't `{"method": "...", "params": [...]}` |
| 405 | not POST (`/manage`) or not GET (`/manage/info`) |
| 413 | the body is over 64 KiB |
| 415 | the content type isn't `application/nostr+json+rpc` |
| 429 | too many signed requests from your address (the same limit as uploads) |
| 503 | the box isn't set up yet (`info` still answers) |

CORS is open (`*`), with `Authorization` allowed, and the preflight answers 204.

### Methods

| Method | Who | Result |
|---|---|---|
| `info []` | anyone, unsigned; also `GET /manage/info` | `{pubkey, home}`: this storage's key (hex) and the home url it follows, or null |
| `usage []` | owner, admin | `{disk: {used, free}, total: {bytes, blobs}, accounts: [{pubkey, used, blobs, quota, member, hand}]}` |
| `bin []` | owner, admin | `{items: [{sha256, size, type, charged, binnedAt, erasesAt}], more, parked: [{pubkey, removedAt, reason, bytes, blobs, erasesAt}]}` |
| `restore [[sha256, ...]]` | owner, admin | `{restored: n}` |
| `erase [[sha256, ...]]` | owner | `{erased: n}` |

- Bytes are numbers of bytes, times are Unix seconds, pubkeys are hex.
- `disk`: the data volume's used and free bytes (null if the box can't read them). `total`: every blob stored, the
  binned ones too, by real size.
- `accounts[].used`: what counts against the quota (each blob at least 4 KiB, binned ones included). `quota` is null
  for no limit. `member`: on the home's member list. `hand`: added by hand.
- `items`: newest first, at most 5,000, with `more: true` when there are more. `charged` is the account the bytes
  count against, or null when that account is gone. `erasesAt` is when the bin erases it (at the next hourly sweep
  after).
- `parked`: members the home removed whose files are waiting for them to come back, until `erasesAt`. `bytes` and
  `blobs` count everything they get back on return (counted like quotas, shared files included). `reason` is
  `removed` or `erased`.
- `restore` gives each binned blob back to the account it is charged to, or to the box owner when that account is
  gone. Hashes not in the bin are skipped (not counted).
- `erase` deletes each blob's record and file now, whoever holds it, binned or not. Hashes not here are skipped.
  Purge them from your edge cache too.
- At most 500 hashes per call. A hash that isn't 64 hex characters makes the whole call an error, and nothing is
  done.
- An unknown method answers `{"error": "unknown method"}`.

## Tests

```bash
npm test
```

They run servers on loopback ports in temp folders and close them at the end.
