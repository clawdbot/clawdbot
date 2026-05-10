import { beforeEach, describe, expect, it } from "vitest";
import type { DebugProxySettings } from "./env.js";
import {
  captureHttpExchange,
  finalizeDebugProxyCapture,
  initializeDebugProxyCapture,
  type DebugProxyCaptureRuntimeDeps,
} from "./runtime.js";

type StoreCall = { name: string; args: unknown[] };

const settings: DebugProxySettings = {
  enabled: true,
  required: false,
  dbPath: "/tmp/openclaw-proxy-runtime-test.sqlite",
  blobDir: "/tmp/openclaw-proxy-runtime-test-blobs",
  certDir: "/tmp/openclaw-proxy-runtime-test-certs",
  sessionId: "runtime-test-session",
  sourceProcess: "runtime-test",
};

const fetchTarget: typeof globalThis = {
  ...globalThis,
  fetch: async () => new Response("{}", { status: 200 }),
};

const events: Record<string, unknown>[] = [];
const calls: StoreCall[] = [];
const store = {
  upsertSession: (...args: unknown[]) => {
    calls.push({ name: "upsertSession", args });
  },
  endSession: (...args: unknown[]) => {
    calls.push({ name: "endSession", args });
  },
  recordEvent: (event: Record<string, unknown>) => {
    events.push(event);
  },
};

const deps: DebugProxyCaptureRuntimeDeps = {
  fetchTarget,
  getStore: () => store,
  closeStore: () => {
    calls.push({ name: "closeStore", args: [] });
  },
  persistEventPayload: (
    _store: unknown,
    payload: { data?: Buffer | string | null; contentType?: string },
  ) => ({
    contentType: payload.contentType,
    ...(typeof payload.data === "string" ? { dataText: payload.data } : {}),
  }),
  safeJsonString: (value: unknown) => (value == null ? undefined : JSON.stringify(value)),
};

describe("debug proxy runtime", () => {
  beforeEach(() => {
    finalizeDebugProxyCapture(settings, deps);
    events.length = 0;
    calls.length = 0;
    fetchTarget.fetch = async () => new Response("{}", { status: 200 });
  });

  it("captures ambient global fetch calls when debug proxy mode is enabled", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    await fetchTarget.fetch("https://api.minimax.io/anthropic/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"hello"}',
    });
    await new Promise((resolve) => setImmediate(resolve));
    finalizeDebugProxyCapture(settings, deps);

    const sessionEvents = events.filter((event) => event.sessionId === "runtime-test-session");
    expect(sessionEvents.map((event) => event.host)).toContain("api.minimax.io");
    expect(sessionEvents.map((event) => event.kind)).toEqual(["request", "response"]);
  });

  it("normalizes symbol-bearing request headers before calling patched fetch targets", async () => {
    fetchTarget.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-hidden")).toBe("yes");
      return new Response("{}", { status: 200 });
    };
    const headers = { "content-type": "application/json" } as Record<string, string> & {
      [key: symbol]: unknown;
    };
    Object.defineProperty(headers, "x-hidden", {
      value: "yes",
      enumerable: false,
    });
    Object.defineProperty(headers, Symbol("sensitiveHeaders"), {
      value: new Set(["content-type"]),
      enumerable: false,
    });

    initializeDebugProxyCapture("test", settings, deps);
    await fetchTarget.fetch("https://api.example.com/messages", {
      method: "POST",
      headers,
      body: "{}",
    });
    await new Promise((resolve) => setImmediate(resolve));
    finalizeDebugProxyCapture(settings, deps);

    const request = events.find((event) => event.kind === "request");
    expect(JSON.parse(String(request?.headersJson))).toStrictEqual({
      "content-type": "application/json",
      "x-hidden": "yes",
    });
    expect(Object.getOwnPropertySymbols(headers)).toHaveLength(1);
  });

  it("redacts sensitive request and response headers before persistence", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    captureHttpExchange(
      {
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
      },
      settings,
      deps,
    );
    await new Promise((resolve) => setImmediate(resolve));
    finalizeDebugProxyCapture(settings, deps);

    const request = events.find((event) => event.kind === "request");
    expect(JSON.parse(String(request?.headersJson))).toStrictEqual({
      Authorization: "[REDACTED]",
      Cookie: "[REDACTED]",
      "x-api-key": "[REDACTED]",
      "content-type": "application/json",
      "x-safe": "visible",
    });
    const response = events.find((event) => event.kind === "response");
    expect(JSON.parse(String(response?.headersJson))).toStrictEqual({
      "content-type": "application/json",
      "set-cookie": "[REDACTED]",
    });
  });
});
