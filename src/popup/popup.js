/** Popup UI: config, connect/disconnect, room users, resync-to-me. */
(function () {
  "use strict";

  const P = globalThis.SyncPlayProtocol;
  const api = globalThis.browser || globalThis.chrome;
  const $ = (id) => document.getElementById(id);
  const els = {
    status: $("status"),
    serverUrl: $("serverUrl"),
    room: $("room"),
    user: $("user"),
    connect: $("connect"),
    disconnect: $("disconnect"),
    resync: $("resync"),
    users: $("users"),
    roomInfo: $("roomInfo"),
    diagnostics: $("diagnostics"),
    error: $("error"),
  };

  function toBackground(action, extra = {}) {
    return api.runtime.sendMessage({ type: P.POPUP_TO_BG, action, ...extra });
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function render(state) {
    if (!state) return;

    els.status.textContent = state.connected ? "connected" : "disconnected";
    els.status.classList.toggle("online", state.connected);

    if (document.activeElement !== els.serverUrl) els.serverUrl.value = state.serverUrl || "";
    if (document.activeElement !== els.room) els.room.value = state.room || "";
    if (document.activeElement !== els.user) els.user.value = state.user || "";

    els.connect.disabled = state.connected;
    els.disconnect.disabled = !state.connected;
    els.resync.disabled = !state.connected || !state.activeVideo;

    els.roomInfo.textContent = state.connected
      ? `${state.room} · ${state.users.length} watching`
      : state.room;

    els.users.replaceChildren();
    if (!state.users.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = state.connected ? "Only you so far" : "No one yet";
      els.users.appendChild(li);
    } else {
      for (const user of state.users) {
        const li = document.createElement("li");
        li.textContent = user.name + (user.id === state.clientId ? " (you)" : "");
        els.users.appendChild(li);
      }
    }

    els.diagnostics.textContent = state.connected
      ? `position ${formatTime(state.position)} · ${state.paused ? "paused" : "playing"} · ` +
        `drift ${state.drift.toFixed(2)}s · clock ${state.offset >= 0 ? "+" : ""}${state.offset}ms` +
        (state.rtt !== null ? ` · rtt ${state.rtt}ms` : "") +
        (state.activeVideo ? "" : " · no video detected on this tab")
      : "Connect, then join the same room from a second browser profile.";

    if (state.error) {
      els.error.textContent = state.error;
      els.error.hidden = false;
    } else {
      els.error.textContent = "";
      els.error.hidden = true;
    }
  }

  async function refresh() {
    try {
      render(await toBackground(P.GET_STATE));
    } catch (_) {
      els.status.textContent = "unavailable";
    }
  }

  function saveConfig() {
    toBackground(P.SET_CONFIG, {
      patch: {
        serverUrl: els.serverUrl.value,
        room: els.room.value,
        user: els.user.value,
      },
    }).then(render).catch(() => {});
  }

  for (const input of [els.serverUrl, els.room, els.user]) {
    input.addEventListener("change", saveConfig);
    input.addEventListener("blur", saveConfig);
  }

  els.connect.addEventListener("click", () => {
    saveConfig();
    toBackground(P.CONNECT).then(render).catch(() => {});
  });
  els.disconnect.addEventListener("click", () => {
    toBackground(P.DISCONNECT).then(render).catch(() => {});
  });
  els.resync.addEventListener("click", () => {
    els.resync.disabled = true;
    toBackground(P.RESYNC).then(refresh).catch(() => {});
  });

  api.runtime.onMessage.addListener((message) => {
    if (message && message.type === P.BG_TO_POPUP) render(message.state);
  });

  refresh();
  setInterval(refresh, 1000);
})();
