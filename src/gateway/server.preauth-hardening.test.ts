/**
 * Gateway pre-auth hardening tests.
 */
import { writeFile } from "node:fs/promises";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { tryBeginGatewaySuspendAdmission } from "../process/gateway-work-admission.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import type { GatewayWsClient } from "./server/ws-types.js";
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

async function requestUpgradeRejection(port: number): Promise<{ status: number; body: string }> {
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGVzdC1rZXktMDEyMzQ1Ng==",
        "Sec-WebSocket-Version": "13",
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

  it("rejects core websocket upgrades while suspension admission is closed", async () => {
    const harness = await createGatewaySuiteHarness();
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    try {
      await expect(requestUpgradeRejection(harness.port)).resolves.toEqual({
        status: 503,
        body: "Gateway websocket admission closed",
      });
    } finally {
      suspension?.release();
      await harness.close();
    }
  });

  it("closes idle unauthenticated sockets after the handshake timeout", async () => {
    setEnvForTest("OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS", "200");

    await expectIdlePreauthSocketClose();
  });

  it("uses gateway.handshakeTimeoutMs for idle unauthenticated sockets", async () => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH missing in gateway preauth test");
    }
    await writeFile(
      configPath,
      JSON.stringify(
        {
          gateway: {
            handshakeTimeoutMs: 250,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    try {
      await expectIdlePreauthSocketClose();
    } finally {
      await writeFile(configPath, "{}\n", "utf-8");
    }
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
