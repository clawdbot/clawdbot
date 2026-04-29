import { afterEach, describe, expect, it } from "vitest";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { ResolvedGatewayAuth } from "../auth.js";
import { MAX_PAYLOAD_BYTES } from "../server-constants.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "../server-http.js";
import { createPreauthConnectionBudget } from "../server/preauth-connection-budget.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { withTempConfig } from "../test-temp-config.js";
import { VOICECLAW_REALTIME_PATH } from "./paths.js";
import { VOICECLAW_REALTIME_MAX_PAYLOAD_BYTES } from "./upgrade.js";

const previousGeminiApiKey = process.env.GEMINI_API_KEY;
const previousTestHandshakeTimeout = process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS;

afterEach(() => {
  if (previousGeminiApiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = previousGeminiApiKey;
  }
  if (previousTestHandshakeTimeout === undefined) {
    delete process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS;
    return;
  }
  process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS = previousTestHandshakeTimeout;
});

describe("VoiceClaw realtime gateway upgrade", () => {
  it("keeps the realtime websocket payload cap aligned with gateway clients", () => {
    expect(VOICECLAW_REALTIME_MAX_PAYLOAD_BYTES).toBe(MAX_PAYLOAD_BYTES);
  });

  it("accepts the realtime path without the generic gateway websocket handler", async () => {
    delete process.env.GEMINI_API_KEY;
    await withRealtimeGateway(async ({ port }) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${VOICECLAW_REALTIME_PATH}`);

      try {
        await waitForOpen(ws);
        const nextMessage = waitForMessage(ws);
        ws.send(
          JSON.stringify({
            type: "session.config",
            provider: "gemini",
            voice: "Zephyr",
            model: "gemini-3.1-flash-live-preview",
            brainAgent: "enabled",
            apiKey: "",
          }),
        );

        await expect(nextMessage).resolves.toMatchObject({
          type: "error",
          message: "GEMINI_API_KEY is required for VoiceClaw real-time brain mode",
        });
      } finally {
        await closeWebSocket(ws);
      }
    });
  });

  it("closes idle realtime sockets that never send session.config", async () => {
    process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS = "50";
    await withRealtimeGateway(async ({ port }) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${VOICECLAW_REALTIME_PATH}`);

      try {
        await waitForOpen(ws);
        await expect(waitForClose(ws)).resolves.toMatchObject({
          code: 1000,
          reason: "handshake timeout",
        });
      } finally {
        await closeWebSocket(ws);
      }
    });
  });

  it("uses gateway.handshakeTimeoutMs for idle realtime sockets", async () => {
    await withRealtimeGateway(
      async ({ port }) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${VOICECLAW_REALTIME_PATH}`);

        try {
          await waitForOpen(ws);
          await expect(waitForClose(ws)).resolves.toMatchObject({
            code: 1000,
            reason: "handshake timeout",
          });
        } finally {
          await closeWebSocket(ws);
        }
      },
      { gateway: { auth: { mode: "none" }, handshakeTimeoutMs: 60 } },
    );
  });
});

async function withRealtimeGateway(
  run: (params: { port: number }) => Promise<void>,
  cfg: Record<string, unknown> = { gateway: { auth: { mode: "none" } } },
) {
  const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };
  await withTempConfig({
    cfg,
    run: async () => {
      const clients = new Set<GatewayWsClient>();
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
        await run({ port });
      } finally {
        wss.close();
        await new Promise<void>((resolve, reject) =>
          httpServer.close((err) => (err ? reject(err) : resolve())),
        );
      }
    },
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(JSON.parse(rawDataToString(data)) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

function closeWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

function rawDataToString(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return Buffer.from(raw).toString("utf8");
}
