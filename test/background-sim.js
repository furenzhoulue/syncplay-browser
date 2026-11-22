/**
 * Headless two-client simulation of the real background script against the
 * live local relay. Start the relay first (`cd relay/node && npm start`).
 *
 *   node test/background-sim.js
 *
 * It fakes only the browser APIs + <video>; background.js and the WS protocol
 * are the unmodified production files.
 */
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../relay/node/package.json", import.meta.url));
const WebSocket = require("ws");
const source = fs.readFileSync(new URL("../src/background/background.js", import.meta.url), "utf8");
const ROOM = "sim-" + Math.random().toString(36).slice(2, 8);
const SERVER = process.env.RELAY_URL || "ws://127.0.0.1:8787/ws";

const CONTENT_TO_BG = "syncplay:content-to-bg";
const BG_TO_CONTENT = "syncplay:bg-to-content";
const POPUP_TO_BG = "syncplay:popup-to-bg";

function assert(condition, label) {
  if (!condition) throw new Error("FAIL: " + label);
  console.log("ok - " + label);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(predicate, label, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error("Timeout: " + label);
}

function makePeer(tabId, name) {
  const storage = {
    settings: { serverUrl: SERVER, room: ROOM, user: name, wantConnected: false },
  };
  let onBgMessage = null;
  let onContentMessage = null;
  const video = { position: 0, paused: true, rate: 1, clockOffset: 0 };

  function fromContent(action, extra = {}) {
    onContentMessage?.(
      { type: CONTENT_TO_BG, action, token: "token-" + tabId, ...extra },
      { tab: { id: tabId } },
      () => {},
    );
  }

  function fromContentToBgResponse(action, extra = {}) {
    let result;
    onContentMessage?.(
      { type: CONTENT_TO_BG, action, token: "token-" + tabId, ...extra },
      { tab: { id: tabId } },
      (response) => { result = response; },
    );
    return result;
  }

  const api = {
    storage: {
      local: {
        async get(key) { return key in storage ? { [key]: storage[key] } : {}; },
        async set(obj) { Object.assign(storage, obj); },
      },
    },
    runtime: {
      onMessage: { addListener(fn) { onContentMessage = fn; } },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      sendMessage() { return Promise.resolve(); },
    },
    tabs: {
      async query() { return [{ id: tabId }]; },
      async sendMessage(id, msg) {
        if (id !== tabId || msg.type !== BG_TO_CONTENT) return;
        if (msg.target && msg.target !== "*" && msg.target !== "token-" + tabId) return;
        switch (msg.action) {
          case "clock": video.clockOffset = msg.offset; break;
          case "apply": video.position = msg.position; video.paused = msg.paused; break;
          case "rate": video.rate = msg.rate; break;
          case "get-playback":
            return { type: "playback", position: video.position, paused: video.paused };
          default: break;
        }
      },
    },
  };

  const intervals = new Set();
  const scopedSetInterval = (fn, ms) => {
    const id = setInterval(fn, ms);
    intervals.add(id);
    return id;
  };
  const scopedClearInterval = (id) => {
    clearInterval(id);
    intervals.delete(id);
  };

  vm.runInNewContext(source, {
    browser: api,
    console,
    setTimeout,
    clearTimeout,
    setInterval: scopedSetInterval,
    clearInterval: scopedClearInterval,
    Date,
    Math,
    JSON,
    URL,
    WebSocket,
  });

  const tick = setInterval(() => {
    if (!video.paused) video.position += 0.1 * video.rate;
    fromContent("status", { position: video.position, paused: video.paused });
  }, 100);
  fromContent("register", { hasVideo: true });

  return {
    tabId,
    video,
    fromContent,
    storage,
    state() {
      let result;
      onContentMessage({ type: POPUP_TO_BG, action: "get-state" }, {}, (r) => { result = r; });
      return result;
    },
    popup(action, extra = {}) {
      return new Promise((resolve) => {
        onContentMessage({ type: POPUP_TO_BG, action, ...extra }, {}, resolve);
      });
    },
    response: fromContentToBgResponse,
    close() {
      clearInterval(tick);
      for (const id of intervals) clearInterval(id);
      intervals.clear();
    },
  };
}

const a = makePeer(1, "Alice");
const b = makePeer(2, "Bob");

try {
  await a.popup("connect");
  await b.popup("connect");
  await until(() => a.state().connected && b.state().connected, "both clients connect");
  await until(() => a.state().users.length === 2 && b.state().users.length === 2, "user lists have 2 peers");
  assert(true, "two clients joined the same room");

  await until(() => Number.isFinite(b.video.clockOffset), "clock offset delivered to content frames", 6000);
  await until(() => a.state().rtt !== null && b.state().rtt !== null, "heartbeat produced clock samples", 6000);
  assert(true, "heartbeat produced clock samples");

  // Alice starts playback at 10s.
  a.video.position = 10;
  a.video.paused = false;
  a.fromContent("local-event", { eventType: "play", position: 10, paused: false, serverTime: Date.now() });
  await until(() => !b.video.paused && b.video.position >= 10, "remote play reaches Bob");
  assert(true, "play event is applied by the other client");

  // Alice seeks to 100s.
  await sleep(200);
  a.video.position = 100;
  a.fromContent("local-event", { eventType: "seek", position: 100, paused: false, serverTime: Date.now() });
  await until(() => b.video.position > 99.5, "remote seek reaches Bob");
  assert(true, "seek event is applied by the other client");

  // Manual resync: make Bob drift 45s, then Alice clicks "resync to me".
  b.video.position = 55;
  const resynced = await a.popup("resync");
  assert(resynced.ok, "resync-to-me finds the active frame");
  await until(() => b.video.position > 99.5, "Bob is pulled back by resync");
  assert(true, "manual resync broadcasts local playback");

  // Large drift is corrected on the next heartbeat.
  b.video.position = b.video.position + 4;
  const before = b.video.position;
  await until(() => Math.abs(b.video.position - (a.state().position)) < 1.2, "hard seek fixes >1s drift", 7000);
  assert(b.video.position < before, "drift correction hard-seeks a lagging/fast client");

  await a.popup("disconnect");
  await b.popup("disconnect");
  console.log("All background simulation tests passed.");
} finally {
  a.close();
  b.close();
}
