import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { ReadCase } from "./relay-core.mjs";

const [root, output] = process.argv.slice(2);
assert(path.isAbsolute(root) && path.isAbsolute(output));
const require = createRequire(path.join(root, "package.json"));
const { WebSocket, WebSocketServer } = require("ws");
assert.equal(require("ws/package.json").version, "8.21.3");
const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
const token = config.gateway.auth.token;
const controlToken = process.env.F26_CONTROL_TOKEN;
assert(token && controlToken);
const deadline = Number(process.env.F26_DEADLINE);
assert(deadline > Date.now() && deadline - Date.now() <= 3600000);
let sequence = 0;
let connectionID = 0;
let active;
let uncertain = false;
let busy = false;
let stopping = false;
let relay;
let control;
let timer;
const cases = new Map();
const connections = new Map();
const pending = new Map();
const observedDevices = new Set();
const pairingRequests = new Set();

function redact(value) {
  if (typeof value === "string")
    return value
      .replaceAll(token, "[REDACTED]")
      .replaceAll(controlToken, "[REDACTED]")
      .replaceAll(output, "<proof>");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(token|deviceToken|password|apiKey|privateKey|signature|publicKey|recoveryScope)$/i.test(
          key,
        )
          ? "[REDACTED]"
          : redact(item),
      ]),
    );
  return value;
}
function record(event, detail = {}) {
  const entry = { sequence: ++sequence, at: Date.now(), event, ...redact(detail) };
  appendFileSync(path.join(output, "wire.jsonl"), JSON.stringify(entry) + "\n");
  return entry.sequence;
}
function parsed(bytes) {
  return JSON.parse(bytes.toString("utf8"));
}
function send(socket, bytes, binary) {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN)
      return reject(new Error("Socket retired before write"));
    socket.send(bytes, { binary }, (error) => (error ? reject(error) : resolve()));
  });
}
function state() {
  return {
    ready: !stopping && !uncertain,
    uncertain,
    cases: [...cases.values()].map(({ caseState }) => caseState),
    connections: [...connections.values()].map((connection) => ({
      id: connection.id,
      role: connection.role,
      latest: connection.latest,
    })),
  };
}
function fatal(error) {
  if (stopping) return;
  record("fixture-failure", { error: String(error) });
  process.exitCode = 1;
  void stop();
}

const admin = new WebSocket("ws://127.0.0.1:19761");
const challenge = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("No Gateway challenge")), 15000);
  admin.on("message", (bytes) => {
    try {
      const frame = parsed(bytes);
      record("controller-received", { frame });
      if (frame.event === "connect.challenge") {
        clearTimeout(timer);
        resolve();
      }
      if (frame.event === "device.pair.requested") {
        const pairing = frame.payload;
        assert(
          observedDevices.has(pairing.deviceId),
          "Pairing request is not from the observed test app",
        );
        assert(!pairingRequests.has(pairing.requestId), "Pairing request already handled");
        pairingRequests.add(pairing.requestId);
        void call("device.pair.approve", { requestId: pairing.requestId }).catch(fatal);
      }
      const request = pending.get(frame.id);
      if (request) {
        clearTimeout(request.timer);
        pending.delete(frame.id);
        frame.ok
          ? request.resolve(frame.payload)
          : request.reject(new Error(JSON.stringify(frame.error)));
      }
    } catch (error) {
      fatal(error);
    }
  });
  admin.once("error", reject);
});
async function call(method, params) {
  const id = randomUUID();
  const frame = { type: "req", id, method, params };
  record("controller-request", { frame });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Controller request expired: ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    send(admin, JSON.stringify(frame), false).catch((error) => {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    });
  });
}
await challenge;
const hello = await call("connect", {
  minProtocol: 4,
  maxProtocol: 4,
  client: { id: "cli", version: "f26-proof-v1", platform: "darwin", mode: "cli" },
  role: "operator",
  scopes: ["operator.admin"],
  auth: { token },
});
assert.equal(hello.protocol, 4);
assert(hello.features.capabilities.includes("session-scoped-chat-metadata"));
await call("sessions.create", {
  key: "agent:main:main",
  agentId: "main",
  label: "F26 Alpha",
  model: "f26/alpha",
});
await call("chat.inject", {
  sessionKey: "agent:main:main",
  agentId: "main",
  message: "Synthetic F26 history. No inference was requested.",
});
const catalog = await call("chat.metadata", { agentId: "main", sessionKey: "agent:main:main" });
assert(Array.isArray(catalog.models) && catalog.models.some((model) => model.id === "alpha"));

async function forward(connection, bytes, binary, frame, request) {
  await send(connection.client, bytes, binary);
  const responseSequence = record("original-written", { connection: connection.id, frame });
  if (
    frame.ok &&
    request?.frame.method === "chat.metadata" &&
    request.frame.params?.sessionKey &&
    (!connection.latest || request.sequence > connection.latest.requestSequence)
  ) {
    connection.latest = {
      connection: connection.id,
      sessionKey: request.frame.params.sessionKey,
      requestID: frame.id,
      requestSequence: request.sequence,
      responseSequence,
    };
  }
}
async function rejectHeld(entry) {
  assert(Date.now() < entry.caseState.expiresAt);
  const connection = connections.get(entry.caseState.connection);
  assert(connection);
  const frame = {
    type: "res",
    id: entry.caseState.requestID,
    ok: false,
    error: {
      code: "UNAVAILABLE",
      message: `Synthetic F26 metadata rejection: ${entry.caseState.label}`,
    },
  };
  record("injected-response", { connection: connection.id, original: entry.original, frame });
  await send(connection.client, JSON.stringify(frame), false);
  entry.caseState.written();
  record("injected-written", {
    label: entry.caseState.label,
    connection: connection.id,
    requestID: frame.id,
  });
}

relay = new WebSocketServer({ host: "127.0.0.1", port: 19762, maxPayload: 16 * 1024 * 1024 });
const relayReady = new Promise((resolve, reject) => {
  relay.once("listening", resolve);
  relay.once("error", reject);
});
relay.on("connection", (client) => {
  const upstream = new WebSocket("ws://127.0.0.1:19761");
  const connection = {
    id: ++connectionID,
    client,
    upstream,
    requests: new Map(),
    role: null,
    queue: [],
  };
  connections.set(connection.id, connection);
  upstream.once("open", () => {
    for (const [bytes, binary] of connection.queue) void send(upstream, bytes, binary).catch(fatal);
    connection.queue = [];
  });
  client.on("message", (bytes, binary) => {
    try {
      const frame = parsed(bytes);
      const observed = record("ios-request", { connection: connection.id, binary, frame });
      if (frame.type === "req") {
        if (frame.method === "connect") {
          connection.role = frame.params.role;
          if (
            ["node", "operator"].includes(connection.role) &&
            ["ios", "ipados"].includes(frame.params.client.platform.toLowerCase()) &&
            frame.params.auth?.token === token &&
            frame.params.device?.id
          ) {
            observedDevices.add(frame.params.device.id);
          }
        }
        const request = { frame, sequence: observed };
        if (
          connection.role === "operator" &&
          active?.caseState.request(connection.id, frame, observed, Date.now())
        ) {
          request.caseLabel = active.caseState.label;
          record("read-captured", {
            label: request.caseLabel,
            requestID: frame.id,
            connection: connection.id,
          });
        }
        connection.requests.set(frame.id, request);
      }
      if (upstream.readyState === WebSocket.OPEN) void send(upstream, bytes, binary).catch(fatal);
      else {
        assert(connection.queue.length < 32, "Pre-open queue exceeded");
        connection.queue.push([bytes, binary]);
      }
    } catch (error) {
      fatal(error);
    }
  });
  upstream.on("message", (bytes, binary) => {
    void (async () => {
      const frame = parsed(bytes);
      const observed = record("gateway-frame", { connection: connection.id, binary, frame });
      if (frame.type === "event") {
        await send(connection.client, bytes, binary);
        const written = record("event-written", {
          connection: connection.id,
          frame,
          receivedSequence: observed,
        });
        active?.caseState.event(connection.id, frame, written);
        return;
      }
      const request = frame.type === "res" ? connection.requests.get(frame.id) : undefined;
      if (request) connection.requests.delete(frame.id);
      const entry = request?.caseLabel ? cases.get(request.caseLabel) : undefined;
      const disposition = entry?.caseState.response(connection.id, frame, Date.now());
      if (!entry || disposition === "unrelated")
        return await forward(connection, bytes, binary, frame, request);
      entry.original = frame;
      if (disposition === "hold-reject") {
        record("held", {
          label: entry.caseState.label,
          connection: connection.id,
          requestID: frame.id,
        });
      } else if (disposition === "reject") await rejectHeld(entry);
      else {
        await forward(connection, bytes, binary, frame, request);
        if (disposition === "pass") entry.caseState.written();
        else throw new Error("Real upstream failure; no injected success or red classification");
      }
    })().catch(fatal);
  });
  client.on("error", fatal);
  upstream.on("error", fatal);
  client.once("close", () => {
    record("ios-closed", { connection: connection.id });
    connections.delete(connection.id);
    upstream.close();
    if (active && !active.caseState.terminal && active.caseState.connection === connection.id)
      fatal(new Error("Selected connection retired during case"));
  });
  upstream.once("close", () => client.close());
});

control = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  let ownsControl = false;
  try {
    assert.equal(request.headers.authorization, `Bearer ${controlToken}`);
    if (request.method === "GET" && request.url === "/status") {
      response.end(JSON.stringify(state()));
      return;
    }
    assert.equal(request.method, "POST");
    assert(!busy && !uncertain && !stopping, "Control unavailable or uncertain");
    busy = true;
    ownsControl = true;
    let body = "";
    for await (const bytes of request) {
      body += bytes;
      assert(Buffer.byteLength(body) <= 8192);
    }
    const input = JSON.parse(body);
    if (request.url === "/case") {
      assert(!active || active.caseState.terminal, "An earlier case is not terminal");
      assert(!cases.has(input.label), "Case labels cannot repeat");
      const matches = [...connections.values()].filter(
        (connection) =>
          connection.role === "operator" && connection.latest?.sessionKey === input.sessionKey,
      );
      assert.equal(
        matches.length,
        1,
        "Exactly one established operator model-read socket required",
      );
      const caseState = new ReadCase({ ...input, connection: matches[0].id }, Date.now());
      active = { caseState };
      cases.set(input.label, active);
      record("case-armed", { caseState });
      if (input.trigger === "publication") {
        caseState.publish(sequence);
        uncertain = true;
        await call("secrets.reload", {});
        uncertain = false;
        record("publisher-completed", { label: input.label });
      }
    } else if (request.url === "/release") {
      assert.equal(active?.caseState.label, input.label);
      const connection = connections.get(active.caseState.connection);
      active.caseState.release(connection?.latest ?? {}, Date.now());
      await rejectHeld(active);
    } else throw new Error("Unsupported control operation");
    response.end(JSON.stringify(state()));
  } catch (error) {
    record("control-refused", { path: request.url, error: String(error), uncertain });
    response.statusCode = 409;
    response.end(JSON.stringify({ error: String(error), uncertain }));
  } finally {
    if (ownsControl) busy = false;
  }
});
control.requestTimeout = 20000;
control.headersTimeout = 5000;
await new Promise((resolve, reject) => {
  control.once("error", reject);
  control.listen(19763, "127.0.0.1", resolve);
});
await relayReady;
writeFileSync(
  path.join(output, "fixture-ready.json"),
  JSON.stringify({
    protocol: hello.protocol,
    build: hello.server,
    catalog,
    ports: [19761, 19762, 19763],
  }),
);
timer = setInterval(() => {
  if (Date.now() >= deadline) fatal(new Error("Fixture deadline ended"));
  if (active && !active.caseState.terminal && Date.now() >= active.caseState.expiresAt) {
    active.caseState.state = "invalid";
    fatal(new Error("Case deadline ended; no retry or synthetic timeout verdict"));
  }
}, 250);
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error("Fixture stopping"));
  }
  pending.clear();
  admin.terminate();
  for (const connection of connections.values()) {
    connection.client.terminate();
    connection.upstream.terminate();
  }
  await Promise.all([
    relay && new Promise((resolve) => relay.close(resolve)),
    control && new Promise((resolve) => control.close(resolve)),
  ]);
  record("joined-stop", { exitCode: process.exitCode ?? 0 });
}
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
