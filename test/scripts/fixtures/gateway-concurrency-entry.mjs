import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";

function startGatewayConcurrencyFixture({ failure, receiptPath }) {
  const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
  writeFileSync(receiptPath, JSON.stringify({ pid: process.pid, root: process.env.HOME }));
  let agentStarted = false;
  let loadProbeCount = 0;
  let finishTurn;
  const server = createServer((request, response) => {
    response.setHeader("content-type", request.url === "/" ? "text/html" : "application/json");
    response.end(
      request.url === "/"
        ? "<html>synthetic benchmark fixture</html>"
        : JSON.stringify({ eventLoop: { degraded: false, delayP99Ms: 1, delayMaxMs: 2 } }),
    );
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      const reply = (payload) =>
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
      switch (frame.method) {
        case "connect":
        case "sessions.subscribe":
        case "sessions.create":
          reply({});
          break;
        case "status":
          reply({
            processMemory: {
              heapTotalBytes: 8_388_608,
              heapUsedBytes: 4_194_304,
              rssBytes: 16_777_216,
            },
          });
          break;
        case "agent":
          agentStarted = true;
          if (process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH) {
            writeFileSync(
              process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH,
              `${JSON.stringify({
                schemaVersion: "openclaw.diagnostics.v1",
                timestamp: new Date().toISOString(),
                type: "span.end",
                name: "fixture.turn",
                durationMs: 1,
              })}\n`,
            );
          }
          reply({ status: "accepted", runId: "fixture-turn" });
          break;
        case "agent.wait":
          finishTurn = () => {
            if (failure === "history") {
              appendFileSync(
                process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH,
                `${JSON.stringify({
                  schemaVersion: "openclaw.diagnostics.v1",
                  timestamp: new Date().toISOString(),
                  type: "span.end",
                  name: "plugins.metadata.scan",
                  durationMs: 7,
                })}\n`,
              );
            }
            reply({ status: failure === "workload" ? "error" : "ok" });
          };
          if (loadProbeCount >= 2) {
            finishTurn();
          }
          break;
        case "chat.history":
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { message: "fixture history failure" },
            }),
          );
          break;
        case "sessions.list":
          reply({ sessions: [] });
          // The second load probe cannot begin until the first complete sample
          // was recorded. Inject failure after that observable boundary.
          if (agentStarted && ++loadProbeCount === 2) {
            finishTurn?.();
          }
          break;
        default:
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { message: `unexpected fixture RPC: ${frame.method}` },
            }),
          );
      }
    });
  });
  process.on("SIGTERM", () => {
    if (failure === "teardown") {
      return;
    }
    for (const socket of sockets.clients) {
      socket.terminate();
    }
    sockets.close();
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
  server.listen(port, "127.0.0.1", () => {
    console.log("startup trace: sidecars.ready 1ms total=1ms");
  });
}

startGatewayConcurrencyFixture({
  failure: path.basename(process.argv[1], ".mjs"),
  receiptPath: path.join(path.dirname(process.argv[1]), "fixture-receipt.json"),
});
