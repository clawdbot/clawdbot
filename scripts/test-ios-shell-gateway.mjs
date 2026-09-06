// Synthetic loopback Gateway for the native iOS approval-navigation UI tests.
// This fixture never executes commands or resolves approvals.
// First terminal, from the repository root: node scripts/test-ios-shell-gateway.mjs
// Second terminal: pnpm ios:gen, then run the two cases on a fresh owned simulator:
// TEST_RUNNER_OPENCLAW_IOS_LIVE_GATEWAY=1 \
// TEST_RUNNER_OPENCLAW_IOS_LIVE_SETUP_CODE='{"url":"ws://127.0.0.1:19876","token":"synthetic-navigation-token"}' \
// TEST_RUNNER_OPENCLAW_IOS_APPROVAL_FIXTURE_URL=http://127.0.0.1:19876 \
// xcodebuild test -project apps/ios/OpenClaw.xcodeproj -scheme OpenClawUITests \
//   -destination 'platform=iOS Simulator,id=<owned-simulator-udid>' \
//   -derivedDataPath /tmp/openclaw-ios-navigation-proof -jobs 4 -parallel-testing-enabled NO \
//   -only-testing:OpenClawUITests/OpenClawSnapshotUITests/testLiveGatewayApprovalNotificationsFromOverview \
//   -only-testing:OpenClawUITests/OpenClawSnapshotUITests/testLiveGatewayApprovalNotificationsFromSettings
// TEST_RUNNER_ forwards these opt-in settings to XCTest; no real Gateway credentials are used.
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
const requests = [];
let partial = false;
const created = Date.now();
const approval = {
  id: "navigation-proof-approval",
  urlPath: "/approval/navigation-proof-approval",
  createdAtMs: created,
  expiresAtMs: created + 3_600_000,
  status: "pending",
  presentation: {
    kind: "exec",
    commandText: "echo navigation-proof",
    commandPreview: "Synthetic navigation check — no command executes",
    allowedDecisions: ["allow-once", "deny"],
    agentId: "main",
    host: "gateway",
  },
};
const sessions = Array.from({ length: 205 }, (_, i) => ({
  key: i === 0 ? "agent:main:main" : `agent:main:navigation-${i}`,
  displayName: i === 0 ? "Navigation proof" : `Synthetic session ${i}`,
  label: i === 0 ? "Navigation proof" : `Synthetic session ${i}`,
  kind: "direct",
  updatedAt: created - i * 1000,
  totalTokens: 100 + i,
  inputTokens: 80 + i,
  outputTokens: 20,
}));
const methods = [
  "health",
  "config.get",
  "agents.list",
  "sessions.list",
  "chat.history",
  "voicewake.get",
  "approval.get",
  "approval.resolve",
  "cron.list",
  "cron.status",
  "system-presence",
  "node.list",
  "sessions.subscribe",
  "sessions.unsubscribe",
  "session.status",
  "models.list",
  "sessions.preview",
  "chat.send",
];
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/approval") {
    let count = 0;
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN && ws.proofRole === "operator") {
        ws.send(
          JSON.stringify({
            type: "event",
            event: "exec.approval.requested",
            payload: { id: approval.id },
          }),
        );
        count++;
      }
    }
    res.end(JSON.stringify({ sent: count }));
  } else if (req.url === "/partial") {
    partial = true;
    res.end(JSON.stringify({ partial }));
  } else if (req.url === "/complete") {
    partial = false;
    res.end(JSON.stringify({ partial }));
  } else {
    res.end(JSON.stringify({ requests, connections: wss.clients.size, partial }));
  }
});
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "synthetic-proof-nonce", ts: Date.now() },
    }),
  );
  ws.on("message", (raw) => {
    const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
    const req = JSON.parse(data.toString("utf8"));
    if (req.type !== "req") {
      return;
    }
    const params = req.params ?? {};
    requests.push({
      method: req.method,
      offset: params.offset,
      limit: params.limit,
      role: params.role,
    });
    const reply = (payload) =>
      ws.send(JSON.stringify({ type: "res", id: req.id, ok: true, payload }));
    const fail = (message) =>
      ws.send(
        JSON.stringify({
          type: "res",
          id: req.id,
          ok: false,
          error: { code: "INVALID_REQUEST", message },
        }),
      );
    console.log(JSON.stringify(requests.at(-1)));
    switch (req.method) {
      case "connect": {
        ws.proofRole = params.role;
        reply({
          type: "hello-ok",
          protocol: 3,
          server: { version: "navigation-proof", connId: "synthetic" },
          features: { methods, events: ["exec.approval.requested", "tick"] },
          snapshot: {
            presence: [],
            health: { ok: true },
            stateVersion: { presence: 1, health: 1 },
            uptimeMs: 1000,
            sessionDefaults: {
              defaultAgentId: "main",
              mainKey: "main",
              mainSessionKey: "agent:main:main",
              scope: "per-sender",
            },
          },
          auth: {
            role: params.role,
            scopes: params.scopes ?? [],
            deviceToken: `synthetic-${params.role}`,
          },
          policy: { maxPayload: 1048576, maxBufferedBytes: 1048576, tickIntervalMs: 30000 },
        });
        break;
      }
      case "health":
        reply({
          ok: true,
          ts: Date.now(),
          durationMs: 1,
          channels: {},
          agents: [],
          sessions: { count: 205 },
        });
        break;
      case "config.get":
        reply({
          config: {
            agents: { defaults: { model: { primary: "openai/gpt-5" } } },
            gateway: { mode: "local" },
          },
          hash: "synthetic",
          valid: true,
        });
        break;
      case "agents.list":
        reply({
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main", name: "Navigation proof" }],
        });
        break;
      case "sessions.list": {
        const offset = params.offset ?? 0;
        if (partial && offset > 0) {
          fail("Synthetic later-page failure");
          break;
        }
        const rows = sessions.slice(offset, offset + (params.limit ?? 200));
        reply({
          ts: Date.now(),
          count: rows.length,
          totalCount: sessions.length,
          offset,
          nextOffset: offset + rows.length,
          hasMore: offset + rows.length < sessions.length,
          defaults: {},
          sessions: rows,
        });
        break;
      }
      case "chat.history":
        reply({
          sessionKey: params.sessionKey ?? "agent:main:main",
          sessionId: "synthetic-session",
          messages: [],
        });
        break;
      case "voicewake.get":
        reply({ triggers: [] });
        break;
      case "approval.get":
        reply({ approval });
        break;
      case "approval.resolve":
        fail("Navigation proof never executes or approves commands");
        break;
      case "cron.list":
        reply({ jobs: [] });
        break;
      case "cron.status":
        reply({ enabled: true, jobs: 0 });
        break;
      case "system-presence":
        reply([]);
        break;
      case "node.list":
        reply({ nodes: [] });
        break;
      case "sessions.subscribe":
      case "sessions.unsubscribe":
        reply({ ok: true });
        break;
      case "models.list":
        reply({ models: [] });
        break;
      case "sessions.preview":
        reply({ ts: Date.now(), previews: [] });
        break;
      default:
        fail(`Unsupported synthetic method: ${req.method}`);
    }
  });
});
const tick = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "event", event: "tick", payload: { ts: Date.now() } }));
    }
  }
}, 10_000);
server.listen(19876, "127.0.0.1", () =>
  console.log("Synthetic Gateway listening on loopback:19876"),
);
process.on("SIGINT", () => {
  clearInterval(tick);
  // close() waits for existing peers; a connected simulator must not keep this fixture alive.
  for (const ws of wss.clients) {
    ws.terminate();
  }
  wss.close();
  server.close();
});
