import { writeFile } from "node:fs/promises";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
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
import { withTempConfig } from "./test-temp-config.js";

installGatewayTestHooks({ scope: "suite" });

const PREAUTH_HANDSHAKE_TEST_CLOSE_LIMIT_MS = 5_000;

let cleanupEnv: Array<() => void> = [];

afterEach(async () => {
  while (cleanupEnv.length > 0) {
    cleanupEnv.pop()?.();
  }
});

function setEnvForTest(name: string, value: string) {
  const previous = process.env[name];
  process.env[name] = value;
  cleanupEnv.push(() => {
    if (previous === undefined) {
      delete process.env[name];
      return;
    }
    process.env[name] = previous;
  });
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
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.once("end", () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.once("error", reject);
    req.end();
  });
}

describe("gateway pre-auth hardening", () => {
  it("rejects upgrades before websocket handlers attach (pre-auth budget enforced, then released)", async () => {
    const clients = new Set<GatewayWsClient>();
    const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };
    const httpServer = createGatewayHttpServer({
      canvasHost: null,
      clients,
      controlUiEnabled: false,
      controlUiBasePath: "/__control__",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      handleHooksRequest: async () => false,
      resolvedAuth,
    });
    const wss = new WebSocketServer({ noServer: true });
    attachGatewayUpgradeHandler({
      httpServer,
      wss,
      canvasHost: null,
      clients,
      preauthConnectionBudget: createPreauthConnectionBudget(1),
      resolvedAuth,
    });

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
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
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("closes idle unauthenticated sockets after the handshake timeout", async () => {
    setEnvForTest("OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS", "200");

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
            minProtocol: 3,
            maxProtocol: 3,
            client: { id: "test", version: "1.0.0", platform: "test", mode: "test" },
            pathEnv: large,
            role: "operator",
          },
        }),
      );

      const result = await closed;
      expect(result.code).toBe(1009);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "payload.large",
          surface: "gateway.ws.preauth",
          action: "rejected",
          limitBytes: MAX_PREAUTH_PAYLOAD_BYTES,
          reason: "preauth_frame_limit",
        }),
      );
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

      const rejectedStatus = await new Promise<number>((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: harness.port,
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
          res.resume();
          res.once("end", () => {
            resolve(res.statusCode ?? 0);
          });
        });
        req.once("error", reject);
        req.end();
      });
      expect(rejectedStatus).toBe(503);

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
