/**
 * Two-client protocol smoke test. Run with the relay already running:
 *   npm start   (terminal 1)
 *   npm test    (terminal 2)
 */
import WebSocket from "ws";

const URL_BASE = process.env.RELAY_URL || "ws://127.0.0.1:8787/ws";
const ROOM = "test-" + Math.random().toString(36).slice(2, 8);

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${URL_BASE}?room=${ROOM}`);
    const inbox = [];
    ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "join", user: name }));
      resolve({
        ws,
        inbox,
        send: (o) => ws.send(JSON.stringify(o)),
        waitFor: async (predicate, ms = 2000) => {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline) {
            const found = inbox.find(predicate);
            if (found) return found;
            await new Promise((r) => setTimeout(r, 20));
          }
          throw new Error(`Timeout waiting for message in ${name}'s inbox`);
        },
      });
    });
    ws.on("error", reject);
  });
}

function assert(condition, label) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`ok - ${label}`);
}

const a = await client("Alice");
const b = await client("Bob");

const welcomeA = await a.waitFor((m) => m.type === "welcome");
await b.waitFor((m) => m.type === "welcome");
assert(welcomeA.state.paused === true, "room starts paused");

b.send({ type: "event", action: "play", position: 12.5, paused: false });
const event = await a.waitFor((m) => m.type === "event");
assert(event.action === "play" && event.position === 12.5, "play event reaches the other client");

a.send({ type: "event", action: "seek", position: 90, paused: true });
const seek = await b.waitFor((m) => m.type === "event" && m.action === "seek");
assert(seek.position === 90 && seek.paused === true, "seek event carries position and paused state");

const t0 = Date.now();
a.send({ type: "ping", t0 });
const pong = await a.waitFor((m) => m.type === "pong" && m.t0 === t0);
assert(Number.isFinite(pong.t1) && pong.t1 >= t0, "ping/pong returns server time");

await new Promise((r) => setTimeout(r, 50));
const users = await a.inbox.filter((m) => m.type === "users").at(-1);
assert(users.users.length === 2, "room user list contains both clients");

a.ws.close();
b.ws.close();
console.log("All relay tests passed.");
