# Keykin Storage: design (draft, 2026-11-20, updated for 0.2.0 on 2026-11-21)

Working name. A small Blossom server and keeper that runs on your Keykin box, so your files have a home
you own. It is the storage half of Marble as a Google Drive replacement. It is built for vaults
(~/nostr-sync-nip/vaults.md, 7.14) and works as an ordinary Blossom server for anything else.

## 1. What it is for

- **Your files outlive any one server.** A full copy of everything your account stores sits on a disk you own.
- **Friends back each other up.** You give a friend a quota on your box, and they give you one on theirs.
  Everything stored is ciphertext, so the host learns sizes and times, nothing else.
- **No port to open.** Most boxes have no public address (Keykin DIRECTION.md, 2026-11-20). The keeper
  works with outbound connections only. Serving is a bonus for boxes that have a door.

Not for: selling storage to strangers (payments, moderation, public media). If that's wanted later, fork
Route96 and make it Keykin-aware. That isn't this.

## 2. Two modes, one app

### 2.1 Keeper (every box, outbound only)

The keeper holds **no vault key**. A stolen box can't read any vault, and the box never needs the whole
nsec. (box-keeper proposal.)

- **Owner devices tell it what to keep.** After an upload, a device sends a **want** (part hashes, sizes,
  servers). After vaults §6.5 collects a blob, it sends a **drop**. Both are encrypted from a per-device link key
  to the keeper key, sent as NIP-59 over relays so a box with no door still gets them.
- **Receipts.** The keeper publishes one encrypted receipt per device: a `through` watermark plus failed,
  needed and repaired parts. In vaults, "backed up" (§6.3) becomes on two servers plus a covering keeper
  receipt, and `config.pinner` may say `"keeper"`. So a pinned vault needs no always-on pinner device.
- **Sweeps are a backstop.** Every few hours it lists each key it keeps (BUD-12 `GET /list/<pubkey>`) to catch
  anything no want named (other apps, public media). On a server without `/list`, it works from wants alone
  and the admin page says what it can't see.
- **Repair.** A part missing from a server is put back by upload. Under today's npub auth, the keeper lists
  what it needs in its receipt, and the next owner device online signs a 24-hour upload auth for exactly
  those hashes. With key grants (§3), the keeper's own key is granted on the account's servers and it repairs
  alone.
- **It never deletes on its own.** Absence from a server is never a drop. A drop moves a part to the bin
  (§4). A large batch of drops waits for a second device, or for the admin page, to confirm. Drops made by a
  root that is later revoked come back out of the bin.
- **No door:** repair-only, which is enough, since readers read from servers.

### 2.2 Server (boxes with a door: Cloudflare Tunnel, Pangolin, a tailnet)

A Blossom server, listed first in the account's kind 10063 list.

| BUD | Endpoint | Notes |
|---|---|---|
| 01 | `GET/HEAD /<sha256>[.ext]` | No auth (vault reads must not name the reader). Range requests, `accept-ranges: bytes`, CORS `*`. Images (not SVG), video and audio served as their type, the rest as an `application/octet-stream` attachment. Cached one day, not immutable |
| 02 | `PUT /upload` | Streamed to a temp file, SHA-256 computed as it arrives, checked against the auth `x` tag and `X-SHA-256`, then moved into place. 201 new, 200 existing. Bytes never changed |
| 04 | `PUT /mirror` | **Owner only** (it fetches from the box's home address). Pulls with an SSRF guard on every connection (no loopback, private, link-local, CGNAT or tailnet addresses, re-checked after DNS and on each redirect, max 5 redirects), a timeout and a size cap |
| 06 | `HEAD /upload` | Answers what the PUT would: allowed key, size cap, quota |
| 11 | auth | kind 24242, `expiration` in the future and at most 25 h ahead, `created_at` in the past and at most 25 h old, at most 16 `x` tags, `t` matches, `x` matches where required, **`server` tag required** and must name this server (vaults always send one, §6.3) |
| 12 | `GET /list/<pubkey>`, `DELETE /<sha256>` | List only for the same key. Delete removes **this key's ownership**, not the blob (§4) |

Not implemented: BUD-05 media, BUD-07 payments, BUD-08 NIP-94, BUD-09 reports (an account-only server
has no strangers' content to report). `PUT /media` answers 404.

Size cap: one setting, default 256 MiB per blob. Vault parts are under 8 MiB (vaults §6.1), so this only
matters for non-vault uploads. Cloudflare Tunnel's free plan cuts requests at about 100 MB, so the app
says so when it detects a tunnel door.

## 3. Who can write

- **Accounts.** The owner's npub, plus friends the owner adds by npub, each with a quota in bytes.
  Anyone else gets 403 on writes, before their signature is checked. Reads are open.
- **Members of a home** (0.2.0, §8). The owner's home (bothy, a private relay) keeps the member list; with
  `STORAGE_HOME_URL` set, members are accounts with the member quota and stop being accounts when the home
  removes them. Accounts added by hand stay as they are.
- **Keys of an account** (server-key-authorization proposal). Three links, each signed by a key that already exists:
  1. **Account:** the server owner signs one event per friend (kind 24246, working number): npub, quota, `server`.
  2. **Device:** the account's existing Keykin/vault device cert links a device root to the npub.
  3. **Keys:** the root signs a **key grant** (kind 24247) listing its storage and probe keys. Each key proves
     possession by signing over the signer and the server domain.

  After that, plain BUD-11 auth from those keys works. There are no new npub signatures in steady state.
  Grants go only to the server, never to relays: `PUT /keys` with the grant as the body, or a NIP-59 wrap to
  the box key for a box with no door. A device sends them only to a server that refused an unknown key. The
  server learns account → device roots → keys, never which vault a key belongs to.
- **The npub is still a key of its own account**, so today's npub-signed uploads keep working (v1).
- **Removing a device** reuses the revocation the npub already signs. Every remaining device pushes it to the
  servers at catch-up. Revoked keys are **frozen**, not erased: copies they deleted in the 30 days before the
  server learned of it come back. One npub-signed `release` frees them later.
- **Readers (vaults §8.7)** get guest grants, charged to the owner's account with a cap per key. Any live root
  can withdraw them. A key that has its own-key grant ignores guest grants, so a friend can't claim the
  owner's keys.
- **Adding a friend** happens on the box's admin page, behind the Umbrel login, like Keykin Box's admin page:
  paste an npub, set a quota (this signs the account event). Later, a friend request from Marble ("back up my
  files on your box?") that you approve.

## 4. Ownership, quota and the bin

- A blob row has an owner list. Uploading or mirroring a blob that is already there adds the key as an
  owner without storing it twice.
- **Ownership is per key, charging is per account.** Each owning account is charged the blob's full size
  (at least 4 KiB, so tiny blobs can't use up inodes), once, however many of its keys hold it. An account with a
  quota holds at most 200,000 blobs. The totals live on the account row and change in the same transaction as
  the ownership, so a quota check is one row read, not a sum over every blob. That's simple to explain ("you're using 4.2 GB of 10 GB"), nobody's
  usage changes because of someone else, and quota numbers don't reveal whether anyone else holds a blob.
- **DELETE** removes that key's ownership. When the last owner is gone, the blob goes to the **bin**: it's
  still on disk, still counted against the account that let go of it last (otherwise delete-and-upload would
  fill the disk past any quota; found in review, 2026-11-21), still served (so a mistaken or hostile delete can be
  undone), and erased after 30 days. An upload or mirror during those 30 days takes it out of the bin.
- **Why the bin:** under npub auth, any device of the account can delete every copy. A stolen phone could
  wipe the box. The bin turns that into "30 days to notice". It doesn't break the vault probe
  (vaults §6.4): blobs other keys still own are never touched.
- The app never deletes on a timer, by disk pressure, or for being unaccessed. When the disk fills up,
  uploads get 507/413 and the admin page says so.

## 5. Build

- **TypeScript on Node 24**, like Keykin (`node file.ts`). Dependencies: `@noble/curves`, `@noble/hashes` and
  `@scure/base`, which Keykin already uses. Metadata in `node:sqlite`, no database server. Blobs on disk as
  `blobs/ab/cd/<sha256>`, with no extensions stored (the extension in a URL is ignored).
- Written ourselves. The protocol surface is about 600–1,000 lines. hzrd149/blossom-server (MIT,
  maintained) is the reference for edge cases. khatru's blossom package is archived and skips the `x`
  and `server` checks, so don't copy it.
- **Packaging** like Keykin Box in ~/keykin-umbrel: its own Umbrel app, `read_only: true`,
  `cap_drop: ALL`, `no-new-privileges`, user 1000, image pinned by digest. Blossom routes are public
  through the app proxy, and the admin page sits behind the Umbrel login. It is a separate container from
  Keykin Box, because the signer stays small.
- **Admin page:** accounts and quotas, disk used and free, the bin (restore), keeper status per server
  ("nostr.download: 1,204 blobs, 2 missing, repaired 11:40").
- **Tests:** `node --test`, covering the BUD request and response cases from the spec texts, the probe
  sequence from vaults §6.4, the SSRF guard table, and quota and bin edge cases. A conformance run
  against a real Marble upload before release.
- **Review** before any friend uses it: an internet-facing upload server. Cosign-style review of auth,
  mirror (SSRF) and the path handling.

## 6. Spec proposals (drafted 2026-11-20, not decided)

Both are in ~/nostr-sync-nip/proposals/, uncommitted. Each lists the vaults.md sections it would change.

1. **server-key-authorization.md:** account events, device certs, key grants, `PUT /keys`, freeze on
   revocation, guest grants for readers (summarized in §3). It changes §8.2's 2026-11-18 decision, so it
   needs the person's call. Related: Blossom PR #118 ("allow users to authorize pubkeys", open) makes the
   delegator the owner, which breaks per-key deletes. Comment there or not: open.
2. **box-keeper.md:** the keeper is a new keyless role, not the pinner. It runs on want/drop notes and
   receipts, and a receipt can stand in for the pinner (summarized in §2.1). It found that under npub auth,
   one device's DELETE already removes every server copy, so the keeper's own disk is what restores the
   §6.3 safeguard. It also flags that §6.4 cites `/list` as BUD-02 where it should be BUD-12.

Open across both: whether the keeper also keeps relay events, whether BUD-11 accepts several `x` tags in one
auth, how a box with no door serves Blossom at all (it doesn't: keeper-only), and whether web pages get
grants.

## 7. Order of work

1. Server mode: BUD-01/02/04/06/11/12, npub accounts, quotas, bin, tests.
2. Keeper: sweeps, fetch and check first (useful today). Then wants, drops and receipts, once the
   keeper proposal is decided.
3. Admin page and Umbrel package. Runs next to Keykin Box, behind a tunnel or reverse proxy.
4. Marble: put the box first in kind 10063 when the account has one with a door, and show "on your box"
   in a file's backup state.
5. Key grants and `PUT /keys` (server-key-authorization proposal), once decided.
6. Done in 0.2.0: the review fixes (§9) and accounts that follow the home's member list (§8).

## 8. Accounts that follow the home's member list (0.2.0)

The home is the single source of truth for who may upload, with no step on this box.

- **Service key.** Storage makes its own secp256k1 key on first start (`<data>/service-key`, 0600), prints the
  public key at start and with `home key`. The owner registers it on the home.
- **The call.** `POST <home>/`, `Content-Type: application/nostr+json+rpc`, body
  `{"method":"memberkeys","params":[]}`, `Authorization: Nostr <base64 kind 27235>` signed by the service key,
  tags `u` (the exact url, with its trailing slash), `method` `POST`, `payload` (sha256 of the body). The reply
  is `{"result":{"owner","members":[…],"removed":[{"pubkey","removedAt","deletesAt","reason"}]}}` or
  `{"error"}`. Field names live in one table in `src/home.ts`.
- **When.** Every `STORAGE_HOME_POLL_S` (300) seconds, and when an unknown key tries to write: one refresh, then
  a second look, at most once a minute overall. After a 429 it waits two minutes.
- **Failure is not removal.** The last good list is in the database. An unreachable home, an error, a 401, a 429,
  a malformed or over 1 MiB reply, or a redirect (never followed) changes nothing. One poll that would remove
  more than half of 4 or more members, or an empty list where people just vanished, is held (one log line) until
  `home apply`.
- **Removals.** The home lists a removal for 14 days, so storage records it the first time it sees it and never
  reads anything into it dropping off. A member missing from both lists is removed as of when storage noticed.
  `removed`: the account goes and what its keys owned is let go into the bin, with the bin clock at `removedAt`;
  the ownership is parked, so a member who comes back before the bin erases gets it back. `erased` (the person
  deleted their own account): what only it holds is erased at once. Unknown reasons count as `removed`.
  `deletesAt` is shown, not used.
- **Who.** Members get `STORAGE_MEMBER_QUOTA`. The home's owner is allowed too, unlimited only when it is
  `STORAGE_OWNER`. Accounts carry `hand` (added by hand) and `member` flags: a hand-set quota wins, a hand
  account removed by the home keeps working, and with no home set accounts that came only from a home can't
  write and nothing is deleted.

## 9. Review fixes (2026-11-21, 0.2.0)

Quota totals kept per account (O(1) checks) and at most 16 `x` tags per auth; 4 KiB minimum charge and a blob
cap per account; unknown keys refused before the signature check and a per-address limit on signed requests
(`CF-Connecting-IP` only with `STORAGE_BEHIND_CLOUDFLARE`); CLI `erase` and `remove --purge`, one-day cache
lifetime; `/mirror` for the owner only; tokens at most 25 hours old or ahead; uploads under 16 KiB/s over a
minute cut off and a deadline on the `/mirror` body; only media served inline; a quiet 400 for a malformed
request line; the account check and the ownership write in one transaction; numeric settings checked at start;
`::ffff:0:0:0/96` in the mirror blocklist.
