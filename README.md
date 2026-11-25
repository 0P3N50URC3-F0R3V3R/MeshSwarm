# MeshSwarm

A tracker that keeps a public, syncing list of MeshCrowd servers. A MeshCrowd server that turns on advertising sends a signed advert (icon, name, description, https address, registration state) to every tracker it is configured with, and shows the lists the trackers return on its login page. Trackers sync with each other, so any number of them can run and no single machine is the network.

Not federation: listed servers stay completely separate (accounts, Passport, data).

## Run

Windows: double-click `start.bat` (uses `runtime\node.exe` when present). Other systems: `./start.sh` with Node 22.5+.
No npm packages are needed; there is nothing to install.

`data/config.json` is created on first start:

| key | meaning |
| --- | --- |
| `port`, `host` | listen address (default 19898) |
| `tls.cert`, `tls.key` | PEM paths for direct HTTPS. Empty = plain HTTP, put a reverse proxy in front. MeshCrowd servers only talk to trackers over HTTPS with a normal certificate |
| `retentionDays` | entries not re-announced for this long are removed (default 7) |
| `maxEntries` | hard cap on stored servers (default 5000) |
| `announcePerMinute` | per-IP announce limit (default 30) |
| `trustProxy` | read the client address from `X-Forwarded-For` (only behind your own proxy) |
| `peers`, `seedPeers` | other trackers (https URLs) to sync with; more are discovered through `/peers` |
| `publicUrl` | this tracker's own public https address, so it never lists itself as a peer |
| `allowPrivatePeers` | allow LAN/loopback peers (testing, private networks) |
| `syncMinutes`, `sweepMinutes` | worker intervals |

## API

- `POST /announce` body = advert string (`text/plain`) -> `204`; `400` invalid, `409` address owned by another key, `413` too large, `429` rate limited.
- `DELETE /announce` body = the owner's advert string -> `204`/`404`.
- `GET /list?since=<ms>&limit=<n>` -> `{ "servers": [{ "advert": "...", "lastSeen": 123 }] }`, newest first, default 500, max 5000. CORS open.
- `GET /peers` -> `{ "peers": [...] }`.

An advert is `base64url(json).base64url(ed25519 signature)`; the first key to claim an address owns it until that entry expires.

## Test

`runtime\node.exe --test test\` (or `npm test`).

## Verified interop

Checked end to end against the MeshCrowd server worker (`server/lib/swarmWorker.js`): two MeshCrowd identities announced to one tracker, each saw the other in its merged list, and turning advertising off removed the entry through the signed `DELETE`.

## WebRTC peering dependency

`werift` 0.28 (pure JavaScript WebRTC, no native binaries, about 27 MB with its own dependencies) is the only npm package. It is installed into this folder's `node_modules` (`npm install`) and ships with the portable folder. Checked with the bundled `runtime
ode.exe` (Node 24.16): two peers connect over loopback and echo 200 KB over a data channel. A data channel message is limited to 64 KB, so larger payloads are sent in 16 KB chunks.

## WebRTC peering (trackers without a public address)

Off by default (`rtc.enabled: false`): with it off no WebRTC code is loaded and no UDP socket is opened, so a tracker behaves exactly as before. Turn it on to let a tracker behind NAT (home or LAN machine) sync with the rest of the network over a WebRTC data channel, connected through public STUN servers.

How it works: a reachable tracker acts as a **mailbox**. A NATed tracker registers at it, another tracker posts a signed offer for it there, the NATed tracker answers through the same mailbox, then both talk directly over the data channel (ICE with STUN). The data channel carries only the two requests peering already uses (`list`, `peers`), in 16 KB chunks (a data channel message is limited to 64 KB, a whole message to 1 MB). Everything received goes through the same advert verification, ownership rules and caps as https peering.

| key | meaning |
| --- | --- |
| `rtc.enabled` | turn WebRTC peering on (default off) |
| `rtc.stun` | STUN servers, `stun:` URLs, default Google and Cloudflare |
| `rtc.mailbox` | a reachable tracker with `rtc.enabled` also serves as a mailbox (default true) |
| `rtc.mailboxes` | mailbox URLs this tracker registers at (default: its https peers) |
| `rtc.peers` | `rtc:<tracker id>@<mailbox url>` entries to sync with; the tracker id is printed in the log at start (`data/tracker-key.json`) |
| `rtc.pollMs`, `rtc.perMinute` | mailbox poll interval (default 3000) and per-IP request limit on the mailbox routes (default 120) |

Mailbox routes (only when `rtc.enabled` and `rtc.mailbox`; otherwise 404): `POST /rtc/poll` (body: signed `register` envelope; marks the tracker present for 15 minutes and returns its waiting messages, so nobody else can read them) and `POST /rtc/post` (body: signed `offer` or `answer` envelope addressed to a present tracker; 200 pending messages max, 5 minute expiry, 16 KB each). `GET /peers` also lists `rtc` entries when rtc is on.

Limits, honestly: a NATed tracker still cannot receive announces from servers on the internet, so it is useful as a LAN mirror and relay. STUN cannot introduce two machines to each other; a reachable mailbox is needed once. Symmetric NATs cannot be traversed without a TURN relay; such peers fail with a status and back off like any peer. A list response is capped at about 900 KB, packed oldest first, so a long list is continued by the next sync.

Verified: automated tests with real WebRTC connections over loopback (identity, mailbox, transport, peering incl. forged answers, caps, backoff, rtc off), and a run of three real tracker processes (one mailbox, two `rtc.enabled` trackers with the default public STUN list) where an advert announced to one appeared on the other through the data channel. That run was on one machine, so it did not cross a real NAT; a two-machine check is still to do.

