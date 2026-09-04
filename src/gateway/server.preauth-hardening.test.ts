/**
 * Gateway pre-auth hardening tests.
 */
import http from "node:http";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import { WORKER_PUBLIC_INGRESS_PATH } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { createWorkerConnection } from "../worker/worker-connection.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import { attachGatewayWsConnectionHandler } from "./server/ws-connection.js";
import {
  createGatewayWsTestLogger,
  createGatewayWsTestRequestContext,
} from "./server/ws-connection.test-helpers.js";
import type { WorkerConnectionService } from "./server/ws-connection/worker-connection.js";
import {
  GATEWAY_WS_CONNECTION_KIND_PROPERTY,
  GATEWAY_WS_PREAUTH_BUDGET_PROPERTY,
  type GatewayIngressWebSocket,
  type GatewayWsClient,
} from "./server/ws-types.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  readConnectChallengeNonce,
} from "./test-helpers.server.js";
import { readClientResponseBody } from "./test-http-response.js";
import { withTempConfig } from "./test-temp-config.js";

installGatewayTestHooks({ scope: "suite" });

await import("./server.js");

const PREAUTH_HANDSHAKE_TEST_CLOSE_LIMIT_MS = 5_000;

const cleanupEnv: Array<() => void> = [];

afterEach(async () => {
  resetGatewayWorkAdmission();
  while (cleanupEnv.length > 0) {
    cleanupEnv.pop()?.();
  }
});

function setEnvForTest(name: string, value: string) {
  const envSnapshot = captureEnv([name]);
  setTestEnvValue(name, value);
  cleanupEnv.push(() => envSnapshot.restore());
}

function setGatewayAuthNoneForTest() {
  const previousAuth = testState.gatewayAuth;
  testState.gatewayAuth = { mode: "none" };
  cleanupEnv.push(() => {
    testState.gatewayAuth = previousAuth;
  });
}

async function requestUpgradeRejection(
  port: number,
  path = "/",
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGVzdC1rZXktMDEyMzQ1Ng==",
        "Sec-WebSocket-Version": "13",
        ...headers,
      },
    });
    req.once("upgrade", (_res, socket) => {
      socket.destroy();
      reject(new Error("expected websocket upgrade to be rejected"));
    });
    req.once("response", (res) => {
      void readClientResponseBody(res).then(resolve, reject);
    });
    req.once("error", reject);
    req.end();
  });
}

async function expectIdlePreauthSocketClose() {
  const harness = await createGatewaySuiteHarness({
    serverOptions: { auth: { mode: "none" } },
  });
  try {
    const ws = await harness.openWs();
    await readConnectChallengeNonce(ws);
    const close = await new Promise<{ code: number; elapsedMs: number }>((resolve) => {
      const startedAt = Date.now();
      ws.once("close", (code) => {
        resolve({ code, elapsedMs: Date.now() - startedAt });
      });
    });
    expect(close.code).toBe(1000);
    expect(close.elapsedMs).toBeGreaterThan(0);
    expect(close.elapsedMs).toBeLessThan(PREAUTH_HANDSHAKE_TEST_CLOSE_LIMIT_MS);
  } finally {
    await harness.close();
  }
}

describe("gateway pre-auth hardening", () => {
  it("reserves the public worker path before plugin upgrade routing", async () => {
    const clients = new Set<GatewayWsClient>();
    const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };
    const httpServer = createGatewayHttpServer({
      clients,
      controlUiEnabled: false,
      controlUiBasePath: "/__control__",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      handleHooksRequest: async () => false,
      resolvedAuth,
    });
    const wss = new WebSocketServer({ maxPayload: 1024, noServer: true });
    const pluginUpgrade = vi.fn(async () => false);
    const accepted = new Promise<GatewayIngressWebSocket>((resolve) => {
      wss.once("connection", (socket) => resolve(socket as GatewayIngressWebSocket));
    });
    attachGatewayUpgradeHandler({
      httpServer,
      wss,
      handlePluginUpgrade: pluginUpgrade,
      clients,
      preauthConnectionBudget: createPreauthConnectionBudget(1),
      resolvedAuth,
      workerIngressEnabled: true,
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const client = new WebSocket(`ws://127.0.0.1:${port}${WORKER_PUBLIC_INGRESS_PATH}`);

    try {
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });
      const socket = await accepted;
      expect(socket[GATEWAY_WS_CONNECTION_KIND_PROPERTY]).toBe("worker");
      expect(socket[GATEWAY_WS_PREAUTH_BUDGET_PROPERTY]).toBeUndefined();
      expect(pluginUpgrade).not.toHaveBeenCalled();
    } finally {
      client.close();
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
      });
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects unattributable proxy traffic on the public worker path", async () => {
    const clients = new Set<GatewayWsClient>();
    const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };
    const httpServer = createGatewayHttpServer({
      clients,
      controlUiEnabled: false,
      controlUiBasePath: "/__control__",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      handleHooksRequest: async () => false,
      resolvedAuth,
    });
    const wss = new WebSocketServer({ maxPayload: 1024, noServer: true });
    const accepted = vi.fn();
    wss.on("connection", accepted);
    attachGatewayUpgradeHandler({
      httpServer,
      wss,
      clients,
      preauthConnectionBudget: createPreauthConnectionBudget(1),
      resolvedAuth,
      workerIngressEnabled: true,
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const response = await requestUpgradeRejection(port, WORKER_PUBLIC_INGRESS_PATH, {
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "gateway.example",
      });
      expect(response.status).toBe(403);
      expect(response.body).toContain("proxy_attribution_required");
      expect(accepted).not.toHaveBeenCalled();
    } finally {
      wss.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("admits the production worker client over the public path without a gateway challenge", async () => {
    const clients = new Set<GatewayWsClient>();
    const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };
    const httpServer = createGatewayHttpServer({
      clients,
      controlUiEnabled: false,
      controlUiBasePath: "/__control__",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      handleHooksRequest: async () => false,
      resolvedAuth,
    });
    const wss = new WebSocketServer({ maxPayload: 64 * 1024, noServer: true });
    const preauthConnectionBudget = createPreauthConnectionBudget(1);
    const workerConnectionService: WorkerConnectionService = {
      admitWorker: vi.fn(async () => ({
        ok: true as const,
        identity: {
          environmentId: "worker-public",
          credentialHash: "h".repeat(43),
          bundleHash: "a".repeat(64),
          sessionId: null,
          runId: null,
          turnClaim: null,
          ownerEpoch: 1,
          rpcSetVersion: 1,
          protocolFeatures: [],
          credentialExpiresAtMs: Date.now() + 60_000,
        },
      })),
      validateWorkerConnection: vi.fn(() => null),
      commitTranscript: vi.fn(async () => {
        throw new Error("unexpected transcript commit");
      }),
      pushLiveEvent: vi.fn(async () => {
        throw new Error("unexpected live event");
      }),
    };
    attachGatewayUpgradeHandler({
      httpServer,
      wss,
      clients,
      preauthConnectionBudget,
      resolvedAuth,
      workerIngressEnabled: true,
    });
    const logGateway = createGatewayWsTestLogger();
    const logHealth = createGatewayWsTestLogger();
    const logWsControl = createGatewayWsTestLogger();
    attachGatewayWsConnectionHandler({
      wss,
      clients,
      bootId: "preauth-hardening-test-boot",
      preauthConnectionBudget,
      port: 0,
      getResolvedAuth: () => resolvedAuth,
      preauthHandshakeTimeoutMs: 2_000,
      gatewayMethods: [],
      events: [],
      refreshHealthSnapshot: vi.fn(async () => ({}) as never),
      logGateway: logGateway as never,
      logHealth: logHealth as never,
      logWsControl: logWsControl as never,
      extraHandlers: {},
      broadcast: vi.fn(),
      buildRequestContext: () => createGatewayWsTestRequestContext() as never,
      workerConnectionService,
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const client = createWorkerConnection({
      endpoint: {
        kind: "websocket",
        url: `ws://127.0.0.1:${port}${WORKER_PUBLIC_INGRESS_PATH}`,
      },
      connectParams: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: GATEWAY_CLIENT_IDS.WORKER,
          version: "2026.8.12",
          platform: "linux",
          mode: GATEWAY_CLIENT_MODES.WORKER,
        },
        role: "worker",
        admission: {
          environmentId: "worker-public",
          credential: "public-worker-credential",
          sessionId: null,
          runId: null,
          ownerEpoch: 1,
          rpcSetVersion: 1,
          handshake: {
            bundleHash: "a".repeat(64),
            openclawVersion: "2026.8.12",
            protocolFeatures: [],
          },
        },
      },
      reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
      admissionTimeoutMs: 2_000,
    });

    try {
      await client.start();
      expect(client.state).toMatchObject({
        kind: "ready",
        hello: { type: "worker-hello-ok", environmentId: "worker-public" },
      });
      expect(workerConnectionService.admitWorker).toHaveBeenCalledOnce();
    } finally {
      await client.stop();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects the reserved worker path when worker admission is unavailable", async () => {
    const clients = new Set<GatewayWsClient>();
    const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };
    const httpServer = createGatewayHttpServer({
      clients,
      controlUiEnabled: false,
      controlUiBasePath: "/__control__",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      handleHooksRequest: async () => false,
      resolvedAuth,
    });
    const wss = new WebSocketServer({ maxPayload: 1024, noServer: true });
    wss.on("connection", (socket) => socket.close());
    attachGatewayUpgradeHandler({
      httpServer,
      wss,
      clients,
      preauthConnectionBudget: createPreauthConnectionBudget(1),
      resolvedAuth,
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      await expect(requestUpgradeRejection(port, WORKER_PUBLIC_INGRESS_PATH)).resolves.toEqual({
        status: 503,
        body: "Worker websocket ingress unavailable",
      });
    } finally {
      wss.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each(["draining", "prepared"] as const)(
    "rejects public worker websocket upgrades while suspension is %s",
    async (phase) => {
      const clients = new Set<GatewayWsClient>();
      const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };
      const httpServer = createGatewayHttpServer({
        clients,
        controlUiEnabled: false,
        controlUiBasePath: "/__control__",
        openAiChatCompletionsEnabled: false,
        openResponsesEnabled: false,
        handleHooksRequest: async () => false,
        resolvedAuth,
      });
      const wss = new WebSocketServer({ maxPayload: 1024, noServer: true });
      attachGatewayUpgradeHandler({
        httpServer,
        wss,
        clients,
        preauthConnectionBudget: createPreauthConnectionBudget(1),
        resolvedAuth,
        workerIngressEnabled: true,
      });
      await new Promise<void>((resolve) => {
        httpServer.listen(0, "127.0.0.1", resolve);
      });
      const address = httpServer.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(phase === "draining" ? suspension?.drain() : suspension?.commit()).toBe(true);

      try {
        await expect(requestUpgradeRejection(port, WORKER_PUBLIC_INGRESS_PATH)).resolves.toEqual({
          status: 503,
          body: "Worker websocket admission closed",
        });
      } finally {
        suspension?.release();
        await new Promise<void>((resolve) => {
          wss.close(() => resolve());
        });
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it("rejects upgrades before websocket handlers attach (pre-auth budget enforced, then released)", async () => {
    const clients = new Set<GatewayWsClient>();
    const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };
    const httpServer = createGatewayHttpServer({
      clients,
      controlUiEnabled: false,
      controlUiBasePath: "/__control__",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      handleHooksRequest: async () => false,
      resolvedAuth,
    });
    const wss = new WebSocketServer({ maxPayload: 1024, noServer: true });
    attachGatewayUpgradeHandler({
      httpServer,
      wss,
      clients,
      preauthConnectionBudget: createPreauthConnectionBudget(1),
      resolvedAuth,
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      await expect(requestUpgradeRejection(port)).resolves.toEqual({
        status: 503,
        body: "Gateway websocket handlers unavailable",
      });
      await expect(requestUpgradeRejection(port)).resolves.toEqual({
        status: 503,
        body: "Gateway websocket handlers unavailable",
      });
    } finally {
      wss.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it.each(["draining", "prepared"] as const)(
    "accepts core websocket upgrades while suspension is %s",
    async (phase) => {
      const harness = await createGatewaySuiteHarness();
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(phase === "draining" ? suspension?.drain() : suspension?.commit()).toBe(true);

      try {
        const ws = await harness.openWs();
        await expect(readConnectChallengeNonce(ws)).resolves.toEqual(expect.any(String));
        ws.close();
        await new Promise<void>((resolve) => {
          ws.once("close", () => resolve());
        });
      } finally {
        suspension?.release();
        await harness.close();
      }
    },
  );

  it("rejects core websocket upgrades while suspension is preparing", async () => {
    const harness = await createGatewaySuiteHarness();
    const suspension = tryBeginGatewaySuspendAdmission(() => {});

    try {
      await expect(requestUpgradeRejection(harness.port)).resolves.toEqual({
        status: 503,
        body: "Gateway websocket admission closed",
      });
    } finally {
      suspension?.rollback();
      await harness.close();
    }
  });

  it("rejects core websocket upgrades during restart drain", async () => {
    const harness = await createGatewaySuiteHarness();
    markGatewayRestartDraining();

    try {
      await expect(requestUpgradeRejection(harness.port)).resolves.toEqual({
        status: 503,
        body: "Gateway websocket admission closed",
      });
    } finally {
      await harness.close();
    }
  });

  it("opens only the startup generation core preauth transport during restart drain", async () => {
    const clients = new Set<GatewayWsClient>();
    const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };
    const httpServer = createGatewayHttpServer({
      clients,
      controlUiEnabled: false,
      controlUiBasePath: "/__control__",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      handleHooksRequest: async () => false,
      resolvedAuth,
    });
    const wss = new WebSocketServer({ maxPayload: 1024, noServer: true });
    wss.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "startup-preauth", ts: Date.now() },
        }),
      );
    });
    attachGatewayUpgradeHandler({
      httpServer,
      wss,
      clients,
      preauthConnectionBudget: createPreauthConnectionBudget(1),
      resolvedAuth,
      isStartupPending: () => true,
      workerIngressEnabled: true,
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    markGatewayRestartDraining();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const challenge = new Promise<string>((resolve) => {
      ws.once("message", (data) => {
        const frame = JSON.parse(rawDataToString(data)) as { payload?: { nonce?: unknown } };
        const nonce = frame.payload?.nonce;
        resolve(typeof nonce === "string" ? nonce : "");
      });
    });

    try {
      await new Promise<void>((resolve) => {
        ws.once("open", resolve);
      });
      await expect(challenge).resolves.toBe("startup-preauth");
      await expect(requestUpgradeRejection(port, WORKER_PUBLIC_INGRESS_PATH)).resolves.toEqual({
        status: 503,
        body: "Worker websocket admission closed",
      });
    } finally {
      ws.close();
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
      });
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("closes idle unauthenticated sockets after the handshake timeout", async () => {
    setEnvForTest("OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS", "200");

    await expectIdlePreauthSocketClose();
  });

  it("rejects oversized pre-auth connect frames before application-level auth responses", async () => {
    resetDiagnosticEventsForTest();
    const events: DiagnosticEventPayload[] = [];
    const stopDiagnostics = onDiagnosticEvent((event) => events.push(event));
    const harness = await createGatewaySuiteHarness();
    try {
      const ws = await harness.openWs();
      await readConnectChallengeNonce(ws);

      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.once("close", (code, reason) => {
          resolve({ code, reason: reason.toString() });
        });
      });

      const large = "A".repeat(MAX_PREAUTH_PAYLOAD_BYTES + 1024);
      ws.send(
        JSON.stringify({
          type: "req",
          id: "oversized-connect",
          method: "connect",
          params: {
            minProtocol: 4,
            maxProtocol: 4,
            client: { id: "test", version: "1.0.0", platform: "test", mode: "test" },
            pathEnv: large,
            role: "operator",
          },
        }),
      );

      const result = await closed;
      expect(result.code).toBe(1009);
      const event = events.find((candidate) => candidate.type === "payload.large");
      expect(event?.type).toBe("payload.large");
      expect(event?.surface).toBe("gateway.ws.preauth");
      expect(event?.action).toBe("rejected");
      expect(event?.limitBytes).toBe(MAX_PREAUTH_PAYLOAD_BYTES);
      expect(event?.reason).toBe("preauth_frame_limit");
    } finally {
      stopDiagnostics();
      resetDiagnosticEventsForTest();
      await harness.close();
    }
  });

  it("rejects excess simultaneous unauthenticated sockets from the same client ip", async () => {
    setEnvForTest("OPENCLAW_TEST_MAX_PREAUTH_CONNECTIONS_PER_IP", "1");
    setGatewayAuthNoneForTest();

    const harness = await createGatewaySuiteHarness();
    try {
      const firstWs = await harness.openWs();
      await readConnectChallengeNonce(firstWs);

      const rejected = await requestUpgradeRejection(harness.port);
      expect(rejected.status).toBe(503);

      firstWs.close();
    } finally {
      await harness.close();
    }
  });

  it("rejects excess simultaneous unauthenticated sockets when trusted proxy headers are missing", async () => {
    setEnvForTest("OPENCLAW_TEST_MAX_PREAUTH_CONNECTIONS_PER_IP", "1");
    setGatewayAuthNoneForTest();

    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: ["127.0.0.1"],
        },
      },
      prefix: "openclaw-preauth-proxy-",
      run: async () => {
        const harness = await createGatewaySuiteHarness();
        try {
          const firstWs = await harness.openWs();
          await readConnectChallengeNonce(firstWs);

          const rejected = await requestUpgradeRejection(harness.port);
          expect(rejected).toEqual({
            status: 503,
            body: "Too many unauthenticated sockets",
          });

          firstWs.close();
        } finally {
          await harness.close();
        }
      },
    });
  });
});
