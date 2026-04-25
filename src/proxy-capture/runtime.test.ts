import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureHttpExchange,
  finalizeDebugProxyCapture,
  initializeDebugProxyCapture,
} from "./runtime.js";

const storeState = vi.hoisted(() => {
  const events: Record<string, unknown>[] = [];
  const store = {
    upsertSession: vi.fn(),
    endSession: vi.fn(),
    recordEvent: vi.fn((event: Record<string, unknown>) => {
      events.push(event);
    }),
  };
  return {
    events,
    store,
    closeDebugProxyCaptureStore: vi.fn(),
  };
});

vi.mock("./store.sqlite.js", () => ({
  closeDebugProxyCaptureStore: storeState.closeDebugProxyCaptureStore,
  getDebugProxyCaptureStore: () => storeState.store,
  persistEventPayload: (
    _store: unknown,
    payload: { data?: Buffer | string | null; contentType?: string },
  ) => ({
    contentType: payload.contentType,
    ...(typeof payload.data === "string" ? { dataText: payload.data } : {}),
  }),
  safeJsonString: (value: unknown) => (value == null ? undefined : JSON.stringify(value)),
}));

describe("debug proxy runtime", () => {
  const envKeys = [
    "OPENCLAW_DEBUG_PROXY_ENABLED",
    "OPENCLAW_DEBUG_PROXY_DB_PATH",
    "OPENCLAW_DEBUG_PROXY_BLOB_DIR",
    "OPENCLAW_DEBUG_PROXY_SESSION_ID",
    "OPENCLAW_DEBUG_PROXY_SOURCE_PROCESS",
  ] as const;
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    storeState.events.length = 0;
    storeState.store.upsertSession.mockClear();
    storeState.store.endSession.mockClear();
    storeState.store.recordEvent.mockClear();
    storeState.closeDebugProxyCaptureStore.mockClear();
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    process.env.OPENCLAW_DEBUG_PROXY_DB_PATH = "/tmp/openclaw-proxy-runtime-test.sqlite";
    process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR = "/tmp/openclaw-proxy-runtime-test-blobs";
    process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID = "runtime-test-session";
    process.env.OPENCLAW_DEBUG_PROXY_SOURCE_PROCESS = "runtime-test";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const value = savedEnv[key];
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("captures ambient global fetch calls when debug proxy mode is enabled", async () => {
    globalThis.fetch = vi.fn(async () => ({ status: 200 }) as Response) as typeof fetch;

    initializeDebugProxyCapture("test");
    await globalThis.fetch("https://api.minimax.io/anthropic/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"hello"}',
    });
    finalizeDebugProxyCapture();

    const events = storeState.events.filter((event) => event.sessionId === "runtime-test-session");
    expect(events.some((event) => event.host === "api.minimax.io")).toBe(true);
    expect(events.some((event) => event.kind === "request")).toBe(true);
    expect(events.some((event) => event.kind === "response")).toBe(true);
  });

  it("redacts sensitive request and response headers before persistence", async () => {
    initializeDebugProxyCapture("test");
    captureHttpExchange({
      url: "https://discord.com/api/v10/gateway/bot",
      method: "GET",
      requestHeaders: {
        Authorization: "Bot discord-token",
        Cookie: "sid=session-token",
        "x-api-key": "provider-key",
        "content-type": "application/json",
        "x-safe": "visible",
      },
      response: new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "sid=response-token",
        },
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    finalizeDebugProxyCapture();

    const request = storeState.events.find((event) => event.kind === "request");
    expect(JSON.parse(String(request?.headersJson))).toMatchObject({
      Authorization: "[REDACTED]",
      Cookie: "[REDACTED]",
      "x-api-key": "[REDACTED]",
      "content-type": "application/json",
      "x-safe": "visible",
    });
    const response = storeState.events.find((event) => event.kind === "response");
    expect(JSON.parse(String(response?.headersJson))).toMatchObject({
      "content-type": "application/json",
      "set-cookie": "[REDACTED]",
    });
  });
});
