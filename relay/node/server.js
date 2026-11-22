/**
 * Local test relay. Mirrors relay/workers/src/index.js exactly at the protocol level.
 * Room state: { paused, position, updatedAt } (server-authoritative).
 *
 *   npm install
 *   npm start                 # ws://localhost:8787/ws
 *   PORT=9000 npm start
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const ROOM_RE = /^[A-Za-z0-9_-]{1,32}$/;
const NAME_RE = /^[\p{L}\p{N} _.-]{1,24}$/u;

/** @type {Map<string, {state: object, clients: Set<object>}>} */
const rooms = new Map();

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = {
      state: { paused: true, position: 0, updatedAt: Date.now() },
      clients: new Set(),
    };
    rooms.set(code, room);
  }
  return room;
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(room, payload, except) {
  for (const client of room.clients) {
    if (client.ws !== except) send(client.ws, payload);
  }
}

function userList(room) {
  return [...room.clients].map((c) => ({ id: c.id, name: c.name }));
}

function broadcastUsers(room) {
  broadcast(room, { type: "users", users: userList(room), serverTime: Date.now() });
}

function pruneEmptyRooms() {
  for (const [code, room] of rooms) {
    if (room.clients.size === 0) rooms.delete(code);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url?.startsWith("/health?")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, serverTime: Date.now() }));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 8 * 1024 });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const code = (url.searchParams.get("room") || "").trim();
  if (!ROOM_RE.test(code)) {
    send(ws, { type: "error", message: "Invalid room code" });
    ws.close(1008, "Invalid room code");
    return;
  }

  const room = getRoom(code);
  const client = { id: randomUUID(), name: "Guest", ws, room };
  room.clients.add(client);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", message: "Malformed JSON" });
      return;
    }
    if (!msg || typeof msg !== "object") return;

    switch (msg.type) {
      case "join": {
        const name = String(msg.user || msg.name || "Guest").trim();
        client.name = NAME_RE.test(name) ? name : "Guest";
        send(ws, {
          type: "welcome",
          clientId: client.id,
          room: code,
          state: room.state,
          users: userList(room),
          serverTime: Date.now(),
        });
        broadcastUsers(room);
        break;
      }

      case "event": {
        const action = msg.action;
        if (!["play", "pause", "seek", "resync"].includes(action)) return;
        const position = Number(msg.position);
        if (!Number.isFinite(position) || position < 0) return;

        room.state = {
          paused: action === "pause" ? true : action === "play" ? false : Boolean(msg.paused),
          position,
          updatedAt: Date.now(),
        };
        broadcast(
          room,
          {
            type: "event",
            action,
            position,
            paused: room.state.paused,
            updatedAt: room.state.updatedAt,
            force: Boolean(msg.force),
            from: client.id,
            serverTime: Date.now(),
          },
          ws, // sender already applied its own change locally
        );
        break;
      }

      case "ping": {
        send(ws, { type: "pong", t0: msg.t0, t1: Date.now() });
        break;
      }

      case "leave":
        ws.close(1000, "Leave");
        break;

      default:
        break;
    }
  });

  ws.on("close", () => {
    room.clients.delete(client);
    broadcastUsers(room);
    pruneEmptyRooms();
  });

  ws.on("error", () => {
    // close event handles cleanup
  });
});

server.listen(PORT, HOST, () => {
  console.log(`SyncPlay local relay: ws://${HOST}:${PORT}/ws  (health: http://${HOST}:${PORT}/health)`);
});

process.on("SIGINT", () => {
  wss.close();
  server.close(() => process.exit(0));
});
