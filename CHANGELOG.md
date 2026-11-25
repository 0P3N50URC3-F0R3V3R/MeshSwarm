# Changelog

All notable changes to MeshSwarm. Newest first.

### 2026-11-25
#### Changed
- MeshCrowd no longer ships a default tracker address. There is no central tracker: every operator runs their own MeshSwarm and adds its address to their server and clients. Nothing changes in the tracker itself.

### 2026-11-24
#### Added
- First release: a tracker that keeps a public, syncing list of MeshCrowd servers. `POST /announce` and `DELETE /announce` take a signed advert (base64url JSON plus an ed25519 signature; the first key to claim an address owns it), `GET /list` returns the verified adverts and `GET /peers` the known trackers.
- Advert verification: only the known fields (`url`, `name`, `description`, `icon`, `registration`, `updated`, `pub`) are kept, `url` must be an https string and control and bidi characters are refused.
- Retention: an advert that is not refreshed is dropped after the configured number of days; per-IP rate limits on every route.
- Tracker peering over HTTPS: trackers sync their lists with each other, so any number can run and no single machine is the network.
- Optional WebRTC peering (`werift`): trackers behind NAT can sync over data channels through a signed mailbox (`POST /rtc/poll`, `POST /rtc/post`, 16 KB chunks, 64 KB message limit). Off by default; not yet tested across two real NATs.
- Portable: its own bundled Node runtime and `node_modules`, `start.bat` and `start.sh`.
