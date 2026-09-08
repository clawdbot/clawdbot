import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { Context, Model } from "../types.js";
import { isTransientNetworkError } from "../utils/retryable-network-errors.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

const model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.test/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 256,
} satisfies Model<"openai-chatgpt-responses">;

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

function createJwt(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-loopback" },
  })}.signature`;
}

describe("ChatGPT Responses WebSocket failures", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    resetOpenAICodexWebSocketStateForTest();
    vi.unstubAllGlobals();
  });

  it("classifies an abrupt Node WebSocket disconnect as transient", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.once("connection", (socket) => {
      socket.once("message", () => socket.terminate());
    });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await streamOpenAICodexResponses(
        { ...model, baseUrl: `http://127.0.0.1:${port}/backend-api` },
        context,
        { apiKey: createJwt(), transport: "websocket" },
      ).result();

      expect(result).toMatchObject({
        stopReason: "error",
        errorMessage: "WebSocket error",
        errorCode: "ERR_WEBSOCKET_TRANSPORT",
      });
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ type: "provider_transport_failure" }),
      ]);
      expect(
        isTransientNetworkError({ message: result.errorMessage, code: result.errorCode }),
      ).toBe(true);
    } finally {
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("preserves nested socket error codes from WebSocket error events", async () => {
    class FailedWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(): void {
        const cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("error"), {
              error: cause,
              message: "WebSocket request failed",
            }),
          );
        });
      }

      close(): void {}
    }
    vi.stubGlobal("WebSocket", FailedWebSocket);

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: createJwt(),
      transport: "websocket",
    }).result();

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "WebSocket request failed",
      errorCode: "ECONNRESET",
    });
    expect(isTransientNetworkError({ message: result.errorMessage, code: result.errorCode })).toBe(
      true,
    );
  });

  it("does not classify a permanent WebSocket close as transient", async () => {
    class PolicyClosedWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(): void {
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("close"), {
              code: 1008,
              reason: "policy violation: ECONNRESET",
              wasClean: true,
            }),
          );
        });
      }

      close(): void {}
    }
    vi.stubGlobal("WebSocket", PolicyClosedWebSocket);

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: createJwt(),
      transport: "websocket",
    }).result();

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "WebSocket closed 1008 policy violation: ECONNRESET",
      errorCode: "ERR_WEBSOCKET_NON_RETRYABLE_CLOSE",
    });
    expect(isTransientNetworkError({ message: result.errorMessage, code: result.errorCode })).toBe(
      false,
    );
  });

  it.each([
    { closeCode: 1001, closeReason: "going away" },
    { closeCode: 1005, closeReason: "no status received" },
    { closeCode: 1011, closeReason: "internal error" },
    { closeCode: 1012, closeReason: "service restart" },
    { closeCode: 1013, closeReason: "try again later" },
    { closeCode: 1014, closeReason: "bad gateway" },
    { closeCode: 1015, closeReason: "TLS handshake failure" },
  ])(
    "classifies retry-directed WebSocket close $closeCode as transient",
    async ({ closeCode, closeReason }) => {
      class RetryClosedWebSocket extends EventTarget {
        constructor() {
          super();
          queueMicrotask(() => this.dispatchEvent(new Event("open")));
        }

        send(): void {
          queueMicrotask(() => {
            this.dispatchEvent(
              Object.assign(new Event("close"), {
                code: closeCode,
                reason: closeReason,
                wasClean: true,
              }),
            );
          });
        }

        close(): void {}
      }
      vi.stubGlobal("WebSocket", RetryClosedWebSocket);

      const result = await streamOpenAICodexResponses(model, context, {
        apiKey: createJwt(),
        transport: "websocket",
      }).result();

      expect(result).toMatchObject({
        stopReason: "error",
        errorMessage: `WebSocket closed ${closeCode} ${closeReason}`,
        errorCode: "ERR_WEBSOCKET_TRANSPORT",
      });
      expect(
        isTransientNetworkError({ message: result.errorMessage, code: result.errorCode }),
      ).toBe(true);
    },
  );
});
