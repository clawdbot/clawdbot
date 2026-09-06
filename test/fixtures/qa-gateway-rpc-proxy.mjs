import { appendFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const [backendPort, repoRoot, recordPath, command, ...args] = process.argv.slice(2);
if (command === "models") {
  for await (const chunk of process.stdin) {
    // The packaged-bootstrap fixture consumes synthetic auth without retaining it.
    void chunk;
  }
} else if (command === "update") {
  if (args.includes("--help")) {
    process.stdout.write("--accept-capabilities\n");
  }
} else if (command === "gateway") {
  const { WebSocket, WebSocketServer } = createRequire(path.join(repoRoot, "package.json"))("ws");
  const peers = new Set();
  let events = [];
  let sequence = 0;
  let connection = 0;
  let dropResponse = false;
  let holdHello = false;
  let held;
  const record = (kind, facts = {}) => {
    if (events.length >= 256) {
      throw new Error("proxy evidence limit exceeded");
    }
    const event = { sequence: ++sequence, kind, ...facts };
    events.push(event);
    appendFileSync(recordPath, `${JSON.stringify(event)}\n`);
  };
  writeFileSync(recordPath, "");
  const server = createServer((req, res) => {
    if (req.url === "/__fixture") {
      if (req.headers["x-qa-fixture-token"] !== process.env.OPENCLAW_GATEWAY_TOKEN) {
        res.writeHead(403).end();
        return;
      }
      void (async () => {
        let text = "";
        for await (const chunk of req) {
          text += chunk;
          if (text.length > 1024) {
            throw new Error("fixture control limit exceeded");
          }
        }
        const action = text ? JSON.parse(text).action : "snapshot";
        if (action === "reset") {
          events = [];
          sequence = 0;
          dropResponse = false;
          writeFileSync(recordPath, "");
        } else if (action === "drop-response") {
          dropResponse = true;
        } else if (action === "hold-reconnect") {
          holdHello = true;
          for (const peer of peers) {
            peer.front.terminate();
            peer.back.terminate();
          }
        } else if (action === "release-hello") {
          if (!held) {
            throw new Error("no held hello");
          }
          record("hello-released", { connection: held.connection });
          const releasing = held;
          held = undefined;
          for (const raw of releasing.frames) {
            releasing.front.send(raw);
          }
        } else if (action !== "snapshot") {
          throw new Error("unknown fixture action");
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ events, held: Boolean(held), pid: process.pid }));
      })().catch(() => res.writeHead(500).end("fixture control failed"));
      return;
    }
    const upstream = request(
      { hostname: "127.0.0.1", port: Number(backendPort), path: req.url, method: req.method },
      (response) => {
        res.writeHead(response.statusCode ?? 503, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => res.writeHead(503).end());
    req.pipe(upstream);
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (front) => {
    const id = ++connection;
    const back = new WebSocket(`ws://127.0.0.1:${backendPort}`);
    const peer = { front, back };
    peers.add(peer);
    const methods = new Map();
    const pending = [];
    front.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "req") {
        methods.set(frame.id, frame.method);
        if (frame.method === "sessions.create") {
          record("mutation-request", { connection: id, requestId: frame.id });
        }
      }
      if (back.readyState === WebSocket.OPEN) {
        back.send(raw);
      } else {
        pending.push(raw);
      }
    });
    back.on("open", () => {
      for (const raw of pending.splice(0)) {
        back.send(raw);
      }
    });
    back.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      const method = methods.get(frame.id);
      if (frame.type === "res" && method === "sessions.create") {
        record(frame.ok ? "mutation-success" : "mutation-error", {
          connection: id,
          requestId: frame.id,
          ...(frame.ok
            ? { key: frame.payload?.key }
            : {
                labelCollision: frame.error?.message?.startsWith("label already in use") === true,
              }),
        });
        if (frame.ok && dropResponse) {
          // A successful real response proves commit before the only injected loss.
          dropResponse = false;
          record("response-dropped", {
            connection: id,
            requestId: frame.id,
            key: frame.payload?.key,
          });
          front.terminate();
          back.terminate();
          return;
        }
      }
      if (frame.type === "res" && method === "connect" && frame.ok && holdHello) {
        holdHello = false;
        held = { connection: id, front, frames: [raw] };
        record("hello-held", { connection: id });
        return;
      }
      if (held?.front === front) {
        if (held.frames.length >= 128) {
          throw new Error("held frame limit exceeded");
        }
        held.frames.push(raw);
      } else if (front.readyState === WebSocket.OPEN) {
        front.send(raw);
      }
    });
    front.on("close", () => {
      back.terminate();
      peers.delete(peer);
      if (held?.front === front) {
        held = undefined;
      }
    });
    back.on("close", () => front.terminate());
    front.on("error", () => back.terminate());
    back.on("error", () => front.terminate());
  });
  const stop = () => {
    for (const peer of peers) {
      peer.front.terminate();
      peer.back.terminate();
    }
    server.closeAllConnections();
    sockets.close(() => server.close(() => process.exit(0)));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  setTimeout(stop, 240_000).unref();
  server.listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1");
} else {
  throw new Error("unexpected proxy fixture command");
}
