# SyncPlay Lite

Sync-only browser extension: two people on **different sites** with a plain `<video>` can watch together. Play, pause and seek are mirrored; nothing else (yet).

- **Firefox first:** Manifest V3, desktop + Android. The manifest also declares a Chrome MV3 service worker (Chrome 121+).
- **Zero cost:** Cloudflare Workers + Durable Objects free tier, or a local Node relay for testing.
- **Plain JS:** no build step, no framework, no bundler.

```
Browser A (any site/iframe)                         Browser B (a different site)
  content.js  ──runtime──►  background.js            content.js  ◄──runtime── background.js
  <video>     ◄────────────   │  │    │   │                         │
                              │  │    │   └── WS ──┐         ┌──────┘
                              │  │    └──────── WS ├──► Relay (DO per room) ◄── WS
                              │  └─────────────── WS ├──► {paused, position, updatedAt}
                              └─────────────────── WS │
```

## Step 0: existing projects considered

I checked GitHub before writing code. **VideoTogether/VideoTogether** (1.8k★, MIT, active) syncs all sites but ships an MV2 Firefox build with no popup, a 156 KB multi-feature script with site adapters/chat/permissions, and a self-hosted Go + TLS server. **Semro/syncwatch** (183★, MIT, May 2025) has the right content-script mechanics (all frames, MutationObserver, play/pause/seek, echo guard, autoplay error) but uses React + WXT + Socket.IO + Express, requires both viewers to open the *same shared link*, and has no clock offset, heartbeat or drift correction. Older hits (`syncplay-web`, `syncWebV`, `Bili-SyncPlay`) are abandoned or site-specific.

**Decision:** don't fork — either option would require replacing its entire stack and sync engine to meet the constraints. The <video> detection / all-frames / guard patterns here are independently implemented but were inspired by those two MIT-licensed projects (credit retained here).

## Project structure

```
manifest.json                     MV3 manifest (Firefox event page + Chrome service worker)
src/shared/protocol.js            message names shared by content + popup
src/content/content.js            injected into ALL frames; video detection & playback control
src/background/background.js      WebSocket, room state, clock offset, heartbeat, drift correction
src/popup/{popup.html,popup.css,popup.js}
relay/node/{server.js,test-client.js}      local test relay (dependency: ws)
relay/workers/{src/index.js,wrangler.toml} Cloudflare Worker + Durable Object relay
test/video.html                   convenient two-window test page
test/background-sim.js            headless two-client test of the real background script
test/firefox_e2e.py                real two-Firefox E2E test (needs Selenium)
tools/make-icons.mjs              regenerate PNG icons (no deps)
```

## 1. Run the relay locally

Requires Node 18+ (works on Fedora).

```sh
cd relay/node
npm install
npm start
# ws://127.0.0.1:8787/ws   health check: http://127.0.0.1:8787/health
# PORT=9000 npm start      to change the port
```

Smoke-test two clients without a browser:

```sh
npm test
```

Expected: `room starts paused`, `play event reaches the other client`, `seek event carries position and paused state`, `ping/pong returns server time`, `room user list contains both clients`.

With the relay still running, run the headless two-client simulation from the repo root:

```sh
node test/background-sim.js
```

It loads the real `background.js` twice (only browser APIs and `<video>` are faked) and verifies connection, clock samples, play/seek propagation, resync-to-me and >1 s drift correction.

For a real two-browser test (Firefox 120+, `pip install selenium`):

```sh
py -3 test/firefox_e2e.py
```

It starts the relay and a local web server, installs a test build of the extension into two independent headless Firefox profiles, and verifies play, pause, seek, heartbeat hard-seek and `<video>` replacement. The test build changes only the default connection settings (auto-connect, fixed room/user) because WebDriver cannot automate the popup or navigate to `moz-extension://` URLs; all sync code is the production code. Firefox needs the `ws://*/*` / `wss://*/*` host permissions and `connect-src 'self' ws: wss:` CSP in `manifest.json` — without them Firefox 160 closes the socket with code 1015.

Optional: use the Cloudflare implementation locally instead (`npm install` then `npm run dev` in `relay/workers`). It listens on the same port and speaks the same protocol.

## 2. Load the extension temporarily in Firefox

1. Open `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
2. Select **`manifest.json`** in the project root.
3. Click the SyncPlay toolbar icon. Set **Relay server** to `ws://localhost:8787/ws` and pick a room code (e.g. `movienight`).
4. Click **Connect**. The badge turns green and the room list shows you.
5. On Firefox Android: use a nightly/Firefox build with MV3 extension support (120+) and install via `about:debugging` from the device or an ADB-connected desktop. Temporary add-ons do not survive a browser restart.

Chrome 121+: `chrome://extensions` → Developer mode → **Load unpacked** → select the project root. The manifest's `background.scripts` key is ignored there; `service_worker` is used. Active WebSockets keep an extension service worker alive on Chrome 116+, so the 3 s heartbeat also serves as a keep-alive.

## 3. Test with two browser profiles

Create two independent profiles so they have separate extension storage:

```sh
firefox -P                        # create profiles "syncA" and "syncB"
firefox -profile /tmp/syncplay-a -new-window http://localhost:8080/video.html
firefox -profile /tmp/syncplay-b -new-window https://example.com/other-video-page
```

Serve the included test page from the repo root with `python3 -m http.server 8080` then open `http://localhost:8080/test/video.html`. Load the temporary add-on in **both** profiles, join the same room with different names, and check:

| Test | Expected result |
| --- | --- |
| A plays | B starts playing at ~the same position (within ~1 s) |
| A pauses | B pauses at A's position |
| A seeks | B seeks with no echo back to A |
| B is ~2 s behind | B hard-seeks to the room position on the next heartbeat (≤3 s) |
| B is ~0.4 s behind | B is gently rate-corrected (0.96× / 1.04×), no jump |
| Click **Replace `<video>` element** on the test page | Extension re-attaches; sync keeps working |
| Play in an iframe player | All frames are injected; the first tab with a video becomes active |
| **↻ Resync to me** | Everyone in the room jumps to your current position/state |
| Block autoplay (e.g. pause first, then remote play) | Small **Click to sync** button appears in the video's frame |
| Disconnect / close relay | Popup shows disconnected; client retries with backoff |

Use a different site in the second profile to verify cross-site sync (any page with a plain HTML5 `<video>` works).

## 4. Deploy the relay free on Cloudflare

```sh
cd relay/workers
npm install
npx wrangler login
npm run deploy
# https://syncplay-relay.<your-subdomain>.workers.dev/ws?room=CODE
```

Paste `https://syncplay-relay.<subdomain>.workers.dev/ws` as the **Relay server** in every profile. Each room gets one Durable Object; room state is also written to DO storage so it survives eviction. Free tier limits are far above a two-person MVP. Use `wss://` in production — `ws://` only works with the local relay.

## Protocol (both relays implement the same JSON)

Client → server: `join {user}`, `event {action: play|pause|seek|resync, position, paused, force, serverTime}`, `ping {t0}`, `leave`.
Server → client: `welcome {clientId, room, state, users, serverTime}`, `event {…, updatedAt, from}`, `users`, `pong {t0, t1}`, `error`.

- Room state is `{paused, position, updatedAt}`. While playing, expected position is `position + (serverNow - updatedAt)/1000`.
- Clock offset uses NTP-style samples: `offset = t1 - (t0 + t3)/2`; the sample with the lowest RTT wins.
- A 3 s heartbeat both refreshes the clock estimate and checks drift. Drift > 1 s ⇒ hard seek; 0.15–1 s ⇒ `playbackRate` nudge; < 0.15 s ⇒ rate 1.
- `IsRemote` in the content script suppresses local media events for 800 ms after applying a remote command, so changes never echo.

## Design notes / where later features plug in

- **Buffering pause for everyone:** content script can watch `waiting`/`stalled` and emit a new `event` action; the relay switch in both servers is the single place to allow it.
- **Per-site adapters:** `applyRemote()` and `findVideo()` in `content.js` are the extension points; add an adapter interface there instead of hard-coding site names (VideoTogether's 156 KB script is the cautionary example).
- **Chrome-compatible where easy:** one classic background script works as both Firefox event page and Chrome service worker; runtime/tabs/storage promise APIs used here exist in both. Firefox Android has no persistent background page — the 10 s content-script re-register and reconnect-on-wake logic handle event-page/service-worker restarts.
- **Not built:** permissions, chat, playback controls, playlist sync, DRM sites (where `currentTime`/`play()` may be blocked), WebView host app.

## License / attribution

SyncPlay Lite is MIT licensed. The MIT projects `VideoTogether/VideoTogether` and `Semro/syncwatch` were consulted during research; no source code was copied from them.

## Troubleshooting

- **Popup says "Connection failed":** curl `http://localhost:8787/health`; check the relay is running and the URL includes `/ws`.
- **Two profiles don't see each other:** room codes are case-sensitive and must use letters/numbers/`_`/`-`; both must use the same relay URL.
- **No video detected:** the active frame is the first one that registers a `<video>`. Sites that render video in a closed shadow root or DRM plugin are out of MVP scope.
- **Firefox won't load the add-on:** use Firefox 120+ and select the manifest, not the folder.
