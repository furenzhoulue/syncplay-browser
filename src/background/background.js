/**
 * SyncPlay Lite background controller.
 *
 * Classic script on purpose: Firefox MV3 uses an event page (`background.scripts`),
 * Chrome MV3 uses a service worker (`background.service_worker`). A classic,
 * self-contained script runs in both. No DOM usage here.
 *
 * Owns: WebSocket connection, room state, server clock offset, heartbeat,
 * drift correction, and routing messages to the one active <video> frame.
 */
(function () {
  "use strict";

  const api = globalThis.browser || globalThis.chrome;
  if (!api) return;

  // Keep in sync with src/shared/protocol.js.
  const CONTENT_TO_BG = "syncplay:content-to-bg";
  const BG_TO_CONTENT = "syncplay:bg-to-content";
  const POPUP_TO_BG = "syncplay:popup-to-bg";
  const BG_TO_POPUP = "syncplay:bg-to-popup";
  const REGISTER = "register";
  const UNREGISTER = "unregister";
  const LOCAL_EVENT = "local-event";
  const STATUS = "status";
  const PLAYBACK = "playback";
  const CLOCK = "clock";
  const APPLY = "apply";
  const RATE = "rate";
  const GET_PLAYBACK = "get-playback";
  const GET_STATE = "get-state";
  const CONNECT = "connect";
  const DISCONNECT = "disconnect";
  const RESYNC = "resync";
  const SET_CONFIG = "set-config";

  const STORAGE_KEY = "settings";
  const HEARTBEAT_MS = 3000;
  const HARD_SEEK_DRIFT = 1.0;
  const SOFT_RATE_DRIFT = 0.15;
  const ROOM_RE = /^[A-Za-z0-9_-]{1,32}$/;

  const defaults = {
    serverUrl: "ws://localhost:8787/ws",
    room: "lobby",
    user: "Guest-" + Math.random().toString(36).slice(2, 6).toUpperCase(),
    wantConnected: false,
  };

  let cfg = { ...defaults };
  let ws = null;
  let connected = false;
  let clientId = null;
  let users = [];
  let roomState = { paused: true, position: 0, updatedAt: Date.now() };
  let clockSamples = [];
  let offset = 0;
  let rtt = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let retry = 0;
  let lastDrift = 0;
  let lastError = "";

  /** @type {Map<number, string>} tabId -> active frame token */
  const activeFrame = new Map();
  /** @type {Map<string, {tabId:number, hasVideo:boolean, lastSeen:number, position?:number, paused?:boolean}>} */
  const frames = new Map();

  // ---------------------------------------------------------------- helpers

  function save() {
    return api.storage.local.set({ [STORAGE_KEY]: cfg });
  }

  function serverNow() {
    return Date.now() + offset;
  }

  function expectedPosition(at = serverNow()) {
    if (roomState.paused) return roomState.position;
    return roomState.position + Math.max(0, (at - roomState.updatedAt) / 1000);
  }

  function publicState() {
    return {
      serverUrl: cfg.serverUrl,
      room: cfg.room,
      user: cfg.user,
      connected,
      clientId,
      users,
      paused: roomState.paused,
      position: expectedPosition(),
      drift: lastDrift,
      offset: Math.round(offset),
      rtt,
      activeVideo: activeFrame.size > 0,
      error: lastError,
    };
  }

  function notifyPopup() {
    try {
      api.runtime.sendMessage({ type: BG_TO_POPUP, state: publicState() })?.catch?.(() => {});
    } catch (_) {
      /* popup may not be open */
    }
  }

  async function sendToTab(tabId, message, token = "*") {
    try {
      await api.tabs.sendMessage(tabId, { ...message, target: token });
    } catch (_) {
      /* no content script in that tab */
    }
  }

  async function broadcastTabs(message, token = "*") {
    try {
      const tabs = await api.tabs.query({});
      await Promise.all(tabs.map((tab) => sendToTab(tab.id, message, token)));
    } catch (_) {
      /* tabs API unavailable */
    }
  }

  function wsUrl() {
    const url = new URL(cfg.serverUrl);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error("Server URL must start with ws:// or wss://");
    }
    if (!url.pathname || url.pathname === "/") url.pathname = "/ws";
    url.searchParams.set("room", cfg.room);
    return url.toString();
  }

  function pushClock(t0, t1) {
    const t3 = Date.now();
    clockSamples.push({ offset: t1 - (t0 + t3) / 2, rtt: t3 - t0 });
    if (clockSamples.length > 8) clockSamples.shift();
    // Lowest round-trip sample gives the least uncertain offset estimate.
    const best = clockSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    offset = best.offset;
    rtt = best.rtt;
    broadcastTabs({ type: BG_TO_CONTENT, action: CLOCK, offset, rtt });
  }

  function startHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping", t0: Date.now() }));
      }
    }, HEARTBEAT_MS);
  }

  function closeSocket() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (ws) {
      try {
        ws.onclose = null;
        ws.close();
      } catch (_) {
        /* already closed */
      }
    }
    ws = null;
    connected = false;
    clientId = null;
    users = [];
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    retry += 1;
    const delay = Math.min(30000, 1000 * 2 ** (retry - 1));
    reconnectTimer = setTimeout(() => {
      if (cfg.wantConnected) connect();
    }, delay);
  }

  // ------------------------------------------------------------- relay I/O

  function sendLocalEvent(action, position, paused, force = false) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const p = Math.max(0, Number(position) || 0);
    roomState = { paused: Boolean(paused), position: p, updatedAt: serverNow() };
    lastDrift = 0;
    ws.send(
      JSON.stringify({
        type: "event",
        action,
        position: p,
        paused: Boolean(paused),
        force,
        serverTime: serverNow(),
      }),
    );
    notifyPopup();
  }

  function applyRemoteEvent(msg) {
    roomState = {
      paused: Boolean(msg.paused),
      position: Math.max(0, Number(msg.position) || 0),
      updatedAt: Number(msg.updatedAt) || serverNow(),
    };
    const target = expectedPosition();
    for (const [tabId, token] of activeFrame) {
      sendToTab(tabId, {
        type: BG_TO_CONTENT,
        action: APPLY,
        mediaAction: msg.action,
        position: target,
        paused: roomState.paused,
        force: Boolean(msg.force),
      }, token);
    }
    notifyPopup();
  }

  function correctDrift() {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;
    const target = expectedPosition();
    for (const [tabId, token] of activeFrame) {
      const frame = frames.get(token);
      if (!frame || !Number.isFinite(frame.position)) continue;
      const drift = frame.position - target;
      lastDrift = drift;
      if (Math.abs(drift) >= HARD_SEEK_DRIFT) {
        sendToTab(tabId, {
          type: BG_TO_CONTENT,
          action: APPLY,
          mediaAction: "seek",
          position: target,
          paused: roomState.paused,
          force: true,
        }, token);
      } else if (!roomState.paused && Math.abs(drift) >= SOFT_RATE_DRIFT) {
        // Gentle rate nudge avoids a visible jump for sub-second drift.
        sendToTab(tabId, { type: BG_TO_CONTENT, action: RATE, rate: drift > 0 ? 0.96 : 1.04 }, token);
      } else {
        sendToTab(tabId, { type: BG_TO_CONTENT, action: RATE, rate: 1 }, token);
      }
    }
  }

  function handleRelayMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    switch (msg.type) {
      case "welcome":
        connected = true;
        retry = 0;
        clientId = msg.clientId;
        users = Array.isArray(msg.users) ? msg.users : [];
        roomState = {
          paused: Boolean(msg.state?.paused),
          position: Math.max(0, Number(msg.state?.position) || 0),
          updatedAt: Number(msg.state?.updatedAt) || Date.now(),
        };
        // Crude first estimate; ping/pong refines it within one heartbeat.
        clockSamples = [];
        offset = (Number(msg.serverTime) || Date.now()) - Date.now();
        startHeartbeat();
        broadcastTabs({ type: BG_TO_CONTENT, action: CLOCK, offset, rtt });
        for (const [tabId, token] of activeFrame) {
          sendToTab(tabId, {
            type: BG_TO_CONTENT,
            action: APPLY,
            mediaAction: "seek",
            position: expectedPosition(),
            paused: roomState.paused,
            force: true,
          }, token);
        }
        notifyPopup();
        break;

      case "event":
        applyRemoteEvent(msg);
        break;

      case "users":
        users = Array.isArray(msg.users) ? msg.users : [];
        notifyPopup();
        break;

      case "pong":
        if (Number.isFinite(Number(msg.t1))) pushClock(Number(msg.t0), Number(msg.t1));
        correctDrift();
        notifyPopup();
        break;

      case "error":
        lastError = String(msg.message || "Relay error");
        notifyPopup();
        break;

      default:
        break;
    }
  }

  async function connect() {
    cfg.wantConnected = true;
    lastError = "";
    await save();
    closeSocket();
    notifyPopup();

    let url;
    try {
      url = wsUrl();
    } catch (err) {
      lastError = err.message;
      cfg.wantConnected = false;
      await save();
      notifyPopup();
      return;
    }

    try {
      ws = new WebSocket(url);
    } catch (err) {
      lastError = String(err.message || err);
      scheduleReconnect();
      notifyPopup();
      return;
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join", user: cfg.user }));
    };
    ws.onmessage = (event) => handleRelayMessage(event.data);
    ws.onerror = () => {
      lastError = "Connection failed — is the relay running?";
      notifyPopup();
    };
    ws.onclose = () => {
      connected = false;
      clientId = null;
      users = [];
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      notifyPopup();
      if (cfg.wantConnected) scheduleReconnect();
    };
  }

  function disconnect() {
    cfg.wantConnected = false;
    save();
    closeSocket();
    lastError = "";
    lastDrift = 0;
    broadcastTabs({ type: BG_TO_CONTENT, action: RATE, rate: 1 });
    notifyPopup();
  }

  async function setConfig(patch = {}) {
    const changedUrl = patch.serverUrl && String(patch.serverUrl).trim() !== cfg.serverUrl;
    const changedRoom = patch.room && String(patch.room).trim() !== cfg.room;
    if (patch.serverUrl) cfg.serverUrl = String(patch.serverUrl).trim();
    if (patch.user) cfg.user = String(patch.user).trim().slice(0, 24) || cfg.user;
    if (patch.room) {
      const room = String(patch.room).trim();
      if (ROOM_RE.test(room)) cfg.room = room;
      else lastError = "Room code: letters, numbers, _ and - only (max 32)";
    }
    await save();
    if (connected && (changedUrl || changedRoom)) connect();
    else notifyPopup();
  }

  async function resyncToMe() {
    for (const [tabId, token] of activeFrame) {
      let result;
      try {
        result = await api.tabs.sendMessage(tabId, { type: BG_TO_CONTENT, action: GET_PLAYBACK, target: token });
      } catch (_) {
        continue;
      }
      if (result && result.type === PLAYBACK && Number.isFinite(result.position)) {
        sendLocalEvent("resync", result.position, Boolean(result.paused), true);
        return true;
      }
    }
    lastError = "No active <video> found on this tab";
    notifyPopup();
    return false;
  }

  function cleanupFrames() {
    const now = Date.now();
    for (const [token, frame] of frames) {
      if (now - frame.lastSeen > 60000) {
        frames.delete(token);
        if (activeFrame.get(frame.tabId) === token) activeFrame.delete(frame.tabId);
      }
    }
  }

  // -------------------------------------------------------- message routing

  async function onMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg !== "object") return false;

    if (msg.type === POPUP_TO_BG) {
      switch (msg.action) {
        case GET_STATE:
          sendResponse(publicState());
          break;
        case CONNECT:
          connect().then(() => sendResponse(publicState()));
          return true;
        case DISCONNECT:
          disconnect();
          sendResponse(publicState());
          break;
        case RESYNC:
          resyncToMe().then((ok) => sendResponse({ ok }));
          return true;
        case SET_CONFIG:
          setConfig(msg.patch).then(() => sendResponse(publicState()));
          return true;
        default:
          break;
      }
      return false;
    }

    if (msg.type !== CONTENT_TO_BG) return false;
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) return false;
    const token = msg.token;

    switch (msg.action) {
      case REGISTER: {
        frames.set(token, {
          tabId,
          hasVideo: Boolean(msg.hasVideo),
          lastSeen: Date.now(),
        });
        if (msg.hasVideo && !activeFrame.has(tabId)) activeFrame.set(tabId, token);
        sendToTab(tabId, { type: BG_TO_CONTENT, action: CLOCK, offset, rtt }, token);
        if (connected && activeFrame.get(tabId) === token) {
          sendToTab(tabId, {
            type: BG_TO_CONTENT,
            action: APPLY,
            mediaAction: "seek",
            position: expectedPosition(),
            paused: roomState.paused,
            force: true,
          }, token);
        }
        notifyPopup();
        break;
      }

      case UNREGISTER:
        frames.delete(token);
        if (activeFrame.get(tabId) === token) activeFrame.delete(tabId);
        notifyPopup();
        break;

      case LOCAL_EVENT:
        if (activeFrame.get(tabId) !== token || !connected) break;
        sendLocalEvent(msg.eventType, msg.position, msg.paused, false);
        break;

      case STATUS: {
        const frame = frames.get(token);
        if (frame) {
          frame.position = msg.position;
          frame.paused = msg.paused;
          frame.lastSeen = Date.now();
        }
        break;
      }

      case PLAYBACK:
        sendResponse({ type: PLAYBACK, position: msg.position, paused: msg.paused });
        break;

      default:
        break;
    }
    return false;
  }

  // Register listeners before any await so a service-worker cold start works.
  api.runtime.onMessage.addListener(onMessage);
  api.runtime.onStartup?.addListener(() => {
    if (cfg.wantConnected) connect();
  });
  api.runtime.onInstalled?.addListener(() => {
    if (cfg.wantConnected) connect();
  });

  setInterval(cleanupFrames, 30000);

  (async function init() {
    try {
      const stored = await api.storage.local.get(STORAGE_KEY);
      if (stored && stored[STORAGE_KEY]) cfg = { ...cfg, ...stored[STORAGE_KEY] };
    } catch (_) {
      /* storage unavailable */
    }
    notifyPopup();
    if (cfg.wantConnected) connect();
  })();
})();
