// Minimal Gateway websocket test helpers.
// Provides small fake-server frames plus an isolated real-Gateway boundary harness.
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { WebSocket, type WebSocketServer } from "ws";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import { toAgentRequestSessionKey } from "../routing/session-key.js";
import { getFreePort } from "../test-utils/ports.js";

type MinimalGatewayRequestFrame = {
  type?: string;
  id?: string;
  method?: string;
  params?: Record<string, unknown> & {
    auth?: { token?: string };
    device?: { nonce?: string };
  };
};

/** Parses a raw WebSocket frame into the small request shape used by tests. */
export function parseMinimalGatewayRequestFrame(
  data: WebSocket.RawData,
): MinimalGatewayRequestFrame {
  return JSON.parse(rawDataToString(data)) as MinimalGatewayRequestFrame;
}

/** Sends the connect challenge event expected by minimal gateway clients. */
export function sendMinimalGatewayConnectChallenge(ws: WebSocket, nonce = "test-nonce"): void {
  ws.send(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce, ts: Date.now() },
    }),
  );
}

/** Builds a minimal hello-ok payload for fake gateway servers. */
export function buildMinimalGatewayHelloOkPayload(params?: {
  connId?: string;
  methods?: string[];
  snapshot?: Record<string, unknown>;
  auth?: { role: string; scopes: string[] };
  policy?: {
    maxPayload: number;
    maxBufferedBytes: number;
    tickIntervalMs: number;
  };
}) {
  return {
    type: "hello-ok",
    protocol: PROTOCOL_VERSION,
    server: { version: "test", connId: params?.connId ?? "conn-test" },
    features: { methods: params?.methods ?? [], events: ["connect.challenge"] },
    snapshot: params?.snapshot ?? {},
    ...(params?.auth ? { auth: params.auth } : {}),
    policy: params?.policy ?? {
      maxPayload: 1_000_000,
      maxBufferedBytes: 1_000_000,
      tickIntervalMs: 60_000,
    },
  };
}

/** Sends a successful response frame from a fake gateway server. */
export function sendMinimalGatewayResponse(ws: WebSocket, id: string, payload: unknown): void {
  ws.send(JSON.stringify({ type: "res", id, ok: true, payload }));
}

/** Terminates all clients and closes a fake WebSocket gateway server. */
export async function closeMinimalGatewayServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve, reject) => {
    wss.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startMinimalRealGateway(
  sessions: Array<{
    agentId: string;
    key: string;
    visibility?: import("../config/sessions.js").SessionEntry["visibility"];
  }> = [],
) {
  const [bootstrap, profiles, sessionStore, testState] = await Promise.all([
    import("../infra/device-bootstrap.js"),
    import("../shared/device-bootstrap-profile.js"),
    import("../config/sessions/session-accessor.sqlite-entry.js"),
    import("../test-utils/openclaw-test-state.js"),
  ]);
  const token = "minimal-real-gateway-token";
  const state = await testState.createOpenClawTestState({
    env: {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
    },
  });
  const sessionListRequests: Record<string, unknown>[] = [];
  const hellos: unknown[] = [];
  const connectFailures: unknown[] = [];
  const clients: WebSocket[] = [];
  let server: Awaited<ReturnType<(typeof import("./server.js"))["startGatewayServer"]>> | undefined;
  let port = await getFreePort();
  while (port === 18789) {
    port = await getFreePort();
  }
  try {
    for (const session of sessions) {
      await sessionStore.upsertSessionEntry(
        {
          agentId: session.agentId,
          sessionKey: toAgentRequestSessionKey(session.key)!,
          storePath: path.join(state.agentDir(session.agentId), "openclaw-agent.sqlite"),
        },
        { sessionId: session.key, updatedAt: Date.now(), visibility: session.visibility },
      );
    }
    const methods = await import("./server-methods.js");
    const original = methods.coreGatewayHandlers["sessions.list"]!;
    methods.coreGatewayHandlers["sessions.list"] = async (options) => {
      sessionListRequests.push(options.params as Record<string, unknown>);
      return await original(options);
    };
    const gateway = await import("./server.js");
    server = await gateway
      .startGatewayServer(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      })
      .finally(() => (methods.coreGatewayHandlers["sessions.list"] = original));
  } catch (error) {
    await state.cleanup();
    throw error;
  }
  const dropConnections = () => clients.forEach((client) => client.terminate());
  return {
    url: `ws://127.0.0.1:${port}`,
    token,
    sessionListRequests,
    hellos,
    connectFailures,
    connectBootstrap: async (mismatched = false) => {
      const helpers = await import("./test-helpers.js");
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      clients.push(ws);
      const bootstrapToken = (
        await bootstrap.issueDeviceBootstrapToken({
          baseDir: state.stateDir,
          profile: profiles.NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
        })
      ).token;
      const response = await helpers.connectReq(ws, {
        bootstrapToken,
        ...(mismatched ? { deviceToken: "mismatched-device-token" } : {}),
        skipDefaultAuth: true,
        role: "node",
        scopes: [],
        client: { id: "node-host", version: "test", platform: "test", mode: "node" },
        deviceIdentityPath: state.statePath(`device-${mismatched ? "bad" : "ok"}.sqlite`),
        timeoutMs: 2_000,
      });
      (response.ok ? hellos : connectFailures).push(
        response.ok ? response.payload : response.error,
      );
      return response;
    },
    dropConnections,
    close: async () => {
      dropConnections();
      try {
        await server!.close();
      } finally {
        await state.cleanup();
      }
    },
  };
}
