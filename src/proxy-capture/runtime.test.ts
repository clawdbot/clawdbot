// Proxy capture runtime tests cover session creation and capture lifecycle.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import type { DebugProxySettings } from "./env.js";
import {
  captureHttpExchange,
  captureWsEvent,
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
    ...(typeof payload.data === "string"
      ? { dataText: payload.data }
      : Buffer.isBuffer(payload.data)
        ? { dataText: payload.data.toString("utf8") }
        : {}),
  }),
  safeJsonString: (value: unknown) => (value == null ? undefined : JSON.stringify(value)),
};

const ONE_MIB = 1024 * 1024;

// Builds a chunked (no Content-Length) response that streams `totalBytes` so the
// bounded body reader exercises its real overflow/cancel path on the clone.
function makeStreamingResponse(totalBytes: number, headers: Record<string, string> = {}): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(ONE_MIB, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/octet-stream", ...headers },
  });
}

async function waitForResponseSettled(): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (events.some((event) => event.kind === "response" || event.kind === "error")) {
      return;
    }
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

describe("debug proxy runtime", () => {
  beforeEach(() => {
    finalizeDebugProxyCapture(settings, deps);
    events.length = 0;
    calls.length = 0;
    resetSecretRedactionRegistryForTest();
    fetchTarget.fetch = async () => new Response("{}", { status: 200 });
  });

  it("captures ambient global fetch calls when debug proxy mode is enabled", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    await fetchTarget.fetch("https://api.minimax.io/anthropic/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"hello"}',
    });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
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
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
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
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
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

  it("redacts registered exact values in custom headers and URL queries", async () => {
    const secret = "capture-managed-secret";
    const pathSecret = "capture/path secret";
    registerSecretValueForRedaction(secret);
    registerSecretValueForRedaction(pathSecret);
    captureHttpExchange(
      {
        url: `https://api.example.com/models/${encodeURIComponent(pathSecret)}?key=${encodeURIComponent(secret)}`,
        method: "GET",
        requestHeaders: { "X-Managed": `Bearer ${secret}` },
        response: new Response("{}", { status: 200 }),
      },
      settings,
      deps,
    );
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    const request = events.find((event) => event.kind === "request");
    expect(request?.path).toBe("/models/%5BREDACTED%5D?key=%5BREDACTED%5D");
    expect(JSON.parse(String(request?.headersJson))).toStrictEqual({
      "X-Managed": "Bearer [REDACTED]",
    });
  });

  it("redacts registered values from every persisted WebSocket field", () => {
    const secret = 'mattermost-"capture\\secret\nline';
    registerSecretValueForRedaction(secret);

    captureWsEvent(
      {
        url: `wss://chat.example.test/api/v4/websocket?token=${encodeURIComponent(secret)}`,
        direction: "outbound",
        kind: "ws-frame",
        flowId: "mattermost-auth",
        payload: JSON.stringify({ action: "authentication_challenge", data: { token: secret } }),
        errorText: `failed with ${secret}`,
        meta: { subsystem: "mattermost-websocket", detail: secret },
      },
      settings,
      deps,
    );
    captureWsEvent(
      {
        url: "wss://chat.example.test/api/v4/websocket",
        direction: "inbound",
        kind: "ws-frame",
        flowId: "mattermost-auth",
        payload: Buffer.from(JSON.stringify({ echoedToken: secret })),
      },
      settings,
      deps,
    );

    const [outbound, inbound] = events;
    expect(outbound?.path).toBe("/api/v4/websocket?token=%5BREDACTED%5D");
    expect(outbound?.dataText).toContain('"token":"[REDACTED]"');
    expect(outbound?.errorText).toBe("failed with [REDACTED]");
    expect(JSON.parse(String(outbound?.metaJson))).toStrictEqual({
      subsystem: "mattermost-websocket",
      detail: "[REDACTED]",
    });
    expect(inbound?.dataText).toContain('"echoedToken":"[REDACTED]"');
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(JSON.stringify(secret).slice(1, -1));
  });

  it("redacts registered credential bytes from otherwise non-UTF-8 frames", () => {
    const secret = "binary-frame-capture-secret";
    registerSecretValueForRedaction(secret);
    const payload = Buffer.concat([
      Buffer.from([0xff, 0x00]),
      Buffer.from(secret, "utf8"),
      Buffer.from([0xfe]),
    ]);

    captureWsEvent(
      {
        url: "wss://chat.example.test/api/v4/websocket",
        direction: "outbound",
        kind: "ws-frame",
        flowId: "binary-auth",
        payload,
      },
      settings,
      deps,
    );

    expect(events[0]?.dataText).toBe("[REDACTED BINARY PAYLOAD]");
    expect(events[0]?.dataText).not.toContain(secret);
  });

  it("redacts registered values from HTTP payloads and metadata", async () => {
    const secret = 'http-"capture\\secret\nline';
    const contentTypeSecret = "http-content-type-secret";
    registerSecretValueForRedaction(secret);
    registerSecretValueForRedaction(contentTypeSecret);

    captureHttpExchange(
      {
        url: "https://api.example.test/v1/messages",
        method: "POST",
        requestHeaders: { "content-type": `application/json; token=${contentTypeSecret}` },
        requestBody: JSON.stringify({ credential: secret }),
        response: new Response(JSON.stringify({ echoedCredential: secret }), {
          status: 200,
          headers: { "content-type": `application/json; token=${contentTypeSecret}` },
        }),
        meta: { credential: secret },
      },
      settings,
      deps,
    );
    await waitForResponseSettled();

    const request = events.find((event) => event.kind === "request");
    const response = events.find((event) => event.kind === "response");
    expect(request?.dataText).toContain('"credential":"[REDACTED]"');
    expect(request?.metaJson).toContain('"credential":"[REDACTED]"');
    expect(request?.contentType).toBe("application/json; token=[REDACTED]");
    expect(response?.dataText).toContain('"echoedCredential":"[REDACTED]"');
    expect(response?.metaJson).toContain('"credential":"[REDACTED]"');
    expect(response?.contentType).toBe("application/json; token=[REDACTED]");
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("redacts registered values from failed global-fetch capture events", async () => {
    const secret = "capture-failure/secret";
    registerSecretValueForRedaction(secret);
    fetchTarget.fetch = vi.fn(async () => {
      throw new Error(`request failed for ${secret}`);
    }) as typeof fetch;
    initializeDebugProxyCapture("test", settings, deps);

    await expect(
      fetchTarget.fetch(`https://api.example.com/models/${encodeURIComponent(secret)}`),
    ).rejects.toThrow("request failed");

    const event = events.find((candidate) => candidate.kind === "error");
    expect(event?.path).toBe("/models/%5BREDACTED%5D");
    expect(event?.errorText).toBe("request failed for [REDACTED]");
  });

  it("keeps capture URLs valid when the full URL is a registered secret", () => {
    const secretUrl = "https://signed.example/v1/callback";
    registerSecretValueForRedaction(secretUrl);

    captureHttpExchange(
      {
        url: secretUrl,
        method: "GET",
        response: new Response("{}", { status: 200 }),
      },
      settings,
      deps,
    );

    const request = events.find((candidate) => candidate.kind === "request");
    expect(request?.host).toBe("redacted.invalid");
    expect(request?.path).toBe("/%5BREDACTED%5D");
  });

  it("does not fail capture on malformed percent escapes", async () => {
    registerSecretValueForRedaction("capture-secret");
    initializeDebugProxyCapture("test", settings, deps);

    await expect(fetchTarget.fetch("https://api.example.com/x#%")).resolves.toBeInstanceOf(
      Response,
    );
  });

  it("skips capturing the body when Content-Length exceeds the cap", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    captureHttpExchange(
      {
        url: "https://api.openai.com/v1/files/big",
        method: "GET",
        response: new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(32 * 1024 * 1024),
          },
        }),
      },
      settings,
      deps,
    );
    await waitForResponseSettled();
    finalizeDebugProxyCapture(settings, deps);

    const response = events.find((event) => event.kind === "response");
    expect(response).toBeDefined();
    expect(response?.status).toBe(200);
    // Metadata is recorded, but the oversized body is never buffered/persisted.
    expect(JSON.parse(String(response?.metaJson))).toMatchObject({ bodyCapture: "too-large" });
    expect(response).not.toHaveProperty("dataText");
    expect(events.some((event) => event.kind === "error")).toBe(false);
  });

  it("skips capturing decimal Content-Length values above the safe integer range", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    captureHttpExchange(
      {
        url: "https://api.openai.com/v1/files/huge",
        method: "GET",
        response: new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": "9007199254740993",
          },
        }),
      },
      settings,
      deps,
    );
    await waitForResponseSettled();
    finalizeDebugProxyCapture(settings, deps);

    const response = events.find((event) => event.kind === "response");
    expect(JSON.parse(String(response?.metaJson))).toMatchObject({ bodyCapture: "too-large" });
    expect(response).not.toHaveProperty("dataText");
    expect(events.some((event) => event.kind === "error")).toBe(false);
  });

  it("streams non-decimal Content-Length values through the body cap", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    captureHttpExchange(
      {
        url: "https://api.openai.com/v1/files/small",
        method: "GET",
        response: new Response("captured", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "content-length": "1e9",
          },
        }),
      },
      settings,
      deps,
    );
    await waitForResponseSettled();
    finalizeDebugProxyCapture(settings, deps);

    const response = events.find((event) => event.kind === "response");
    expect(response).toBeDefined();
    expect(response?.dataText).toBe("captured");
    expect(response?.metaJson).toBeUndefined();
    expect(events.some((event) => event.kind === "error")).toBe(false);
  });

  it("fails closed on chunked responses that stream past the cap", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    // 20 MiB streamed without a Content-Length header: the bounded reader must
    // cancel the clone at the cap and record metadata instead of buffering it.
    captureHttpExchange(
      {
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        response: makeStreamingResponse(20 * ONE_MIB),
      },
      settings,
      deps,
    );
    await waitForResponseSettled();
    finalizeDebugProxyCapture(settings, deps);

    const response = events.find((event) => event.kind === "response");
    expect(response).toBeDefined();
    expect(JSON.parse(String(response?.metaJson))).toMatchObject({ bodyCapture: "too-large" });
    expect(response).not.toHaveProperty("dataText");
    expect(events.some((event) => event.kind === "error")).toBe(false);
  });

  it("captures small chunked bodies normally (under the cap)", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    captureHttpExchange(
      {
        url: "https://api.anthropic.com/v1/models",
        method: "GET",
        response: makeStreamingResponse(64 * 1024),
      },
      settings,
      deps,
    );
    await waitForResponseSettled();
    finalizeDebugProxyCapture(settings, deps);

    const response = events.find((event) => event.kind === "response");
    expect(response).toBeDefined();
    expect(response?.status).toBe(200);
    // Under the cap the body is read in full via the normal persist path, so no
    // fail-closed metadata marker is set and the payload content-type is kept.
    expect(response?.metaJson).toBeUndefined();
    expect(response?.contentType).toBe("application/octet-stream");
    expect(events.some((event) => event.kind === "error")).toBe(false);
  });

  it("captures empty chunked bodies normally (zero-length edge)", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    // A streaming response that closes immediately must not be mistaken for an
    // overflow: the bounded reader sees total=0, never trips the cap.
    captureHttpExchange(
      {
        url: "https://api.anthropic.com/v1/empty",
        method: "GET",
        response: makeStreamingResponse(0),
      },
      settings,
      deps,
    );
    await waitForResponseSettled();
    finalizeDebugProxyCapture(settings, deps);

    const response = events.find((event) => event.kind === "response");
    expect(response).toBeDefined();
    expect(response?.status).toBe(200);
    expect(response?.metaJson).toBeUndefined();
    expect(events.some((event) => event.kind === "error")).toBe(false);
  });

  it("captures a spec-compliant null response body as empty", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    captureHttpExchange(
      {
        url: "https://api.example.test/no-content",
        method: "HEAD",
        response: new Response(null, { status: 204 }),
      },
      settings,
      deps,
    );
    await waitForResponseSettled();
    finalizeDebugProxyCapture(settings, deps);

    const response = events.find((event) => event.kind === "response");
    expect(response?.status).toBe(204);
    expect(response?.dataText).toBe("");
    expect(response?.metaJson).toBeUndefined();
    expect(events.some((event) => event.kind === "error")).toBe(false);
  });

  it("captures a clone-only Response-like readable body", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    const headers = new Headers({ "content-type": "text/plain" });
    const clone = vi.fn(() => new Response("captured", { headers }));
    captureHttpExchange(
      {
        url: "https://api.example.test/clone-only",
        method: "GET",
        response: { status: 200, headers, clone } as unknown as Response,
      },
      settings,
      deps,
    );
    await waitForResponseSettled();
    finalizeDebugProxyCapture(settings, deps);

    const response = events.find((event) => event.kind === "response");
    expect(clone).toHaveBeenCalledOnce();
    expect(response?.dataText).toBe("captured");
    expect(response?.metaJson).toBeUndefined();
    expect(events.some((event) => event.kind === "error")).toBe(false);
  });

  it("records metadata-only for non-cloneable Response-like objects", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    // Some seams hand capture a Response-like object that cannot be cloned. It
    // must still be observable (status/headers) via the shared metadata path,
    // tagged bodyCapture: "unavailable" (distinct from the "too-large" cap path).
    const secret = "metadata-only-content-type-secret";
    registerSecretValueForRedaction(secret);
    const headers = new Headers({ "content-type": `application/json; token=${secret}` });
    captureHttpExchange(
      {
        url: "https://api.openai.com/v1/uncloneable",
        method: "GET",
        response: { status: 503, headers } as unknown as Response,
      },
      settings,
      deps,
    );
    await waitForResponseSettled();
    finalizeDebugProxyCapture(settings, deps);

    const response = events.find((event) => event.kind === "response");
    expect(response).toBeDefined();
    expect(response?.status).toBe(503);
    expect(response?.contentType).toBe("application/json; token=[REDACTED]");
    expect(JSON.parse(String(response?.metaJson))).toMatchObject({ bodyCapture: "unavailable" });
    expect(response).not.toHaveProperty("dataText");
    expect(events.some((event) => event.kind === "error")).toBe(false);
  });

  it("records Response-like status metadata when the Headers API is absent", async () => {
    initializeDebugProxyCapture("test", settings, deps);
    captureHttpExchange(
      {
        url: "https://api.openai.com/v1/no-headers-api",
        method: "GET",
        response: { status: 204 } as unknown as Response,
      },
      settings,
      deps,
    );
    await waitForResponseSettled();
    finalizeDebugProxyCapture(settings, deps);

    const response = events.find((event) => event.kind === "response");
    expect(response?.status).toBe(204);
    expect(response?.contentType).toBeUndefined();
    expect(JSON.parse(String(response?.metaJson))).toMatchObject({ bodyCapture: "unavailable" });
  });
});
