# Running the box locally for app device tests

`scripts/local.ts` starts Keykin Storage on this machine with:

- a fresh temp data folder (removed when it stops), unless `STORAGE_DIR` names one;
- the member list read from a JSON file instead of a live home (no relay, no keeper);
- the small fixture town list, `test/fixtures/towns-small.tsv.gz` (20 towns, among them Moab, Banff, Paris, New York
  City, Tokyo and Sydney), unless `STORAGE_TOWNS` names another.

It talks to no other server.

## 1. The member list

Copy the fixture and put in the test accounts' keys (npub or hex):

```bash
cp test/fixtures/members-local.json /tmp/members.json
```

```json
{"owner": "npub1...home owner...", "members": ["npub1...phone A...", "npub1...phone B..."]}
```

`owner` is the home's owner. It is also the box owner unless `STORAGE_OWNER` says otherwise. Everyone in `owner` or
`members` is on the box; anyone else (phone C) is not. The file is read again every 10 seconds, so adding or removing
someone takes effect while the box runs (someone dropped from the file is removed, as the home would remove them, and
their notes go with them).

## 2. Start it

From the repo root, after `npm install`:

```bash
LOCAL_MEMBERS=/tmp/members.json STORAGE_PORT=7581 node scripts/local.ts
```

It prints the address, the data folder, the owners, how many members it read and the town list. Stop it with
Ctrl-C (or `kill` on its pid): it closes the server and removes the temp data folder.

For a phone to reach it, listen on every interface and give the address the phone uses. The app signs
`<that address>/places`, so `STORAGE_PUBLIC_URL` must be exactly the box address the app has:

```bash
LOCAL_MEMBERS=/tmp/members.json STORAGE_PORT=7581 STORAGE_ADDR=0.0.0.0 STORAGE_PUBLIC_URL=http://100.x.y.z:7581 node scripts/local.ts
```

| Variable | Default here | |
|---|---|---|
| `LOCAL_MEMBERS` | `test/fixtures/members-local.json` (placeholder keys) | The member list file |
| `STORAGE_PORT` | `7581` | |
| `STORAGE_ADDR` | `127.0.0.1` | `0.0.0.0` to let a phone in |
| `STORAGE_PUBLIC_URL` | `http://127.0.0.1:<port>` | What the app signs in `u` (plus `/places`) and the server tag uploads must name |
| `STORAGE_DIR` | a new temp folder, removed on exit | A folder you name is kept |
| `STORAGE_OWNER` | the file's `owner` | The box owner |
| `STORAGE_TOWNS` | `test/fixtures/towns-small.tsv.gz` | Another list, or `off` to test "this box has no town list" |
| `STORAGE_HOME_POLL_S` | `10` | How often the members file is read |

Every other `STORAGE_*` setting in the README works the same here.

## 3. Check it

`POST /places` needs a NIP-98 signature from a key in the file. Without one you get the right refusal, which is
enough to see it is up:

```bash
curl -s -X POST -H 'content-type: application/nostr+json+rpc' -d '{"method":"members","params":[]}' http://127.0.0.1:7581/places
```

`{"error":"authorization required"}`. The box logs one line per call from a key on the box, for example
`places: names 2 points, 1 named`.

With the fixture list, `names` for `[38.5733, -109.5498]` answers Moab, Utah, United States, 0.4 km, and
`[0.28, 0]` answers null (the nearest town is 31 km away).
