/**
 * Cloudflare Worker + Durable Object relay for SyncPlay Lite.
 * Same JSON protocol as relay/node/server.js.
 *
 * Endpoint: wss://<your-worker>.<subdomain>.workers.dev/ws?room=CODE
 * One Durable Object instance per room code holds connections + room state.
 */

const ROOM_RE = /^[A-Za-z0-9_-]{1,32}$/;
const NAME_RE = /^[\p{L}\p{N} _.-]{1,24}$/u;
const ACTIONS = new Set(["play", "pause", "seek", "resync"]);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

function roomInfo(ws) {
  try {
    return JSON.parse(ws.deserializeAttachment() || "{}");
  } catch {
    return {};
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, serverTime: Date.now() });
    }
    if (url.pathname !== "/ws") {
      return new Response("Not found", { status: 404 });
    }

    const code = (url.searchParams.get("room") || "").trim();
    if (!ROOM_RE.test(code)) return new Response("Invalid room code", { status: 400 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    return stub.fetch(request);
  },
};

export class RoomDurableObject {
  constructor(state) {
    this.state = state;
    this.roomCode = null;
    this.roomState = { paused: true, position: 0, updatedAt: Date.now() };
  }

  async fetch(request) {
    const stored = await this.state.storage.get("state");
    if (stored && Number.isFinite(stored.position)) this.roomState = stored;
    this.roomCode = new URL(request.url).searchParams.get("room") || "unknown";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment(JSON.stringify({ id: crypto.randomUUID(), name: "Guest", joined: false }));
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // dead socket; webSocketClose will clean it up
    }
  }

  sockets() {
    return this.state.getWebSockets();
  }

  userList() {
    return this.sockets()
      .filter((ws) => roomInfo(ws).joined)
      .map((ws) => {
        const info = roomInfo(ws);
        return { id: info.id, name: info.name };
      });
  }

  broadcast(payload, exceptWs) {
    for (const ws of this.sockets()) {
      if (ws !== exceptWs) this.send(ws, payload);
    }
  }

  broadcastUsers() {
    this.broadcast({ type: "users", users: this.userList(), serverTime: Date.now() });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      this.send(ws, { type: "error", message: "Malformed JSON" });
      return;
    }
    if (!msg || typeof msg !== "object") return;

    const info = roomInfo(ws);

    switch (msg.type) {
      case "join": {
        const name = String(msg.user || msg.name || "Guest").trim();
        ws.serializeAttachment(JSON.stringify({ ...info, name: NAME_RE.test(name) ? name : "Guest", joined: true }));
        this.send(ws, {
          type: "welcome",
          clientId: info.id,
          room: this.roomCode,
          state: this.roomState,
          users: this.userList(),
          serverTime: Date.now(),
        });
        this.broadcastUsers();
        break;
      }

      case "event": {
        if (!info.joined || !ACTIONS.has(msg.action)) return;
        const position = Number(msg.position);
        if (!Number.isFinite(position) || position < 0) return;

        this.roomState = {
          paused: msg.action === "pause" ? true : msg.action === "play" ? false : Boolean(msg.paused),
          position,
          updatedAt: Date.now(),
        };
        await this.state.storage.put("state", this.roomState);
        this.broadcast(
          {
            type: "event",
            action: msg.action,
            position,
            paused: this.roomState.paused,
            updatedAt: this.roomState.updatedAt,
            force: Boolean(msg.force),
            from: info.id,
            serverTime: Date.now(),
          },
          ws,
        );
        break;
      }

      case "ping": {
        this.send(ws, { type: "pong", t0: msg.t0, t1: Date.now() });
        break;
      }

      case "leave":
        ws.close(1000, "Leave");
        break;

      default:
        break;
    }
  }

  webSocketClose(ws) {
    queueMicrotask(() => this.broadcastUsers());
  }

  webSocketError(ws) {
    queueMicrotask(() => this.broadcastUsers());
  }
}
