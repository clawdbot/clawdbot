// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../../src/gateway/protocol/version.js";
import { createStorageMock } from "../test-helpers/storage.ts";
import { loadDeviceAuthToken, storeDeviceAuthToken } from "./device-auth.ts";
import type { DeviceIdentity } from "./device-identity.ts";

const wsInstances = vi.hoisted((): MockWebSocket[] => []);
const loadOrCreateDeviceIdentityMock = vi.hoisted(() =>
  vi.fn(
    async (): Promise<DeviceIdentity> => ({
      deviceId: "device-1",
      privateKey: "private-key", // pragma: allowlist secret
      publicKey: "public-key", // pragma: allowlist secret
    }),
  ),
);
const signDevicePayloadMock = vi.hoisted(() =>
  vi.fn(async (_privateKeyBase64Url: string, _payload: string) => "signature"),
);

type HandlerMap = {
  close: MockWebSocketHandler[];
  error: MockWebSocketHandler[];
  message: MockWebSocketHandler[];
  open: MockWebSocketHandler[];
};

type MockWebSocketHandler = (ev?: { code?: number; data?: string; reason?: string }) => void;

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected deferred resolver to be initialized");
  }
  return { promise, resolve };
}

class MockWebSocket {
  static OPEN = 1;

  readonly handlers: HandlerMap = {
    close: [],
    error: [],
    message: [],
    open: [],
  };

  readonly sent: string[] = [];
  lastClose: { code?: number; reason?: string } | null = null;
  readyState = MockWebSocket.OPEN;

  constructor(_url: string) {
    wsInstances.push(this);
  }

  addEventListener(type: keyof HandlerMap, handler: MockWebSocketHandler) {
    this.handlers[type].push(handler);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.lastClose = { code, reason };
    this.readyState = 3;
  }

  emitClose(code = 1000, reason = "") {
    for (const handler of this.handlers.close) {
      handler({ code, reason });
    }
  }

  emitOpen() {
    for (const handler of this.handlers.open) {
      handler();
    }
  }

  emitMessage(data: unknown) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const handler of this.handlers.message) {
      handler({ data: payload });
    }
  }
}

vi.mock("./device-identity.ts", () => ({
  loadOrCreateDeviceIdentity: loadOrCreateDeviceIdentityMock,
  signDevicePayload: signDevicePayloadMock,
}));

const { CONTROL_UI_OPERATOR_SCOPES, GatewayBrowserClient, shouldRetryWithDeviceToken } =
  await import("./gateway.ts");

type ConnectFrame = {
  id?: string;
  method?: string;
  params?: {
    auth?: { token?: string; password?: string; deviceToken?: string };
    maxProtocol?: number;
    minProtocol?: number;
    scopes?: string[];
  };
};

type RequestTimingPayload = {
  id?: string;
  method?: string;
  ok?: boolean;
  durationMs?: number;
  startedAtMs?: number;
  endedAtMs?: number;
  errorCode?: string;
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireFirstMockArg(
  mock: ReturnType<typeof vi.fn>,
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return requireRecord(call[0], `${label} payload`);
}

function requireMockCallArg(
  mock: ReturnType<typeof vi.fn>,
  index: number,
  label: string,
): Record<string, unknown> {
  const resolvedIndex = index < 0 ? mock.mock.calls.length + index : index;
  const call = mock.mock.calls[resolvedIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${index}`);
  }
  return requireRecord(call[0], `${label} payload`);
}

function requireFirstSignCall(): [privateKey: string, payload: string] {
  const [call] = signDevicePayloadMock.mock.calls;
  if (!call) {
    throw new Error("expected device payload signing call");
  }
  const [privateKey, payload] = call;
  if (typeof privateKey !== "string" || typeof payload !== "string") {
    throw new Error("expected device payload signing args");
  }
  return [privateKey, payload];
}

function expectSignedPayloadFields(
  payload: string | undefined,
  params: { scopes: string[]; token: string; nonce: string },
) {
  expect(payload?.split("|")).toEqual([
    "v2",
    "device-1",
    "openclaw-control-ui",
    "webchat",
    "operator",
    params.scopes.join(","),
    expect.stringMatching(/^\d+$/),
    params.token,
    params.nonce,
  ]);
}

function expectLatestRequestTiming(
  onRequestTiming: ReturnType<typeof vi.fn>,
  expected: Partial<RequestTimingPayload>,
) {
  const timing = requireMockCallArg(onRequestTiming, -1, "request timing") as RequestTimingPayload;
  for (const [key, value] of Object.entries(expected)) {
    expect(timing[key as keyof RequestTimingPayload]).toBe(value);
  }
  expect(timing.startedAtMs).toBeTypeOf("number");
  expect(timing.endedAtMs).toBeTypeOf("number");
  expect(timing.durationMs).toBeTypeOf("number");
  if (
    typeof timing.startedAtMs === "number" &&
    typeof timing.endedAtMs === "number" &&
    typeof timing.durationMs === "number"
  ) {
    expect(timing.durationMs).toBe(Math.max(0, timing.endedAtMs - timing.startedAtMs));
  }
}

function stubWindowGlobals(storage?: ReturnType<typeof createStorageMock>) {
  vi.stubGlobal("window", {
    location: { href: "http://127.0.0.1:18789/" },
    localStorage: storage,
    setTimeout: (handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
      // Keep connect debounce behavior testable without paying real 750ms waits per handshake.
      const effectiveTimeout = timeout === 750 ? 0 : timeout;
      return globalThis.setTimeout(() => handler(...args), effectiveTimeout);
    },
    clearTimeout: (timeoutId: number | undefined) => globalThis.clearTimeout(timeoutId),
  });
}

function getLatestWebSocket(): MockWebSocket {
  const ws = wsInstances.at(-1);
  if (!ws) {
    throw new Error("missing websocket instance");
  }
  return ws;
}

function stubInsecureCrypto() {
  vi.stubGlobal("crypto", {
    randomUUID: () => "req-insecure",
  });
}

function useNodeFakeTimers() {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
}

function parseLatestConnectFrame(ws: MockWebSocket): ConnectFrame {
  return JSON.parse(ws.sent.at(-1) ?? "{}") as ConnectFrame;
}

async function continueConnect(ws: MockWebSocket, nonce = "nonce-1") {
  ws.emitOpen();
  ws.emitMessage({
    type: "event",
    event: "connect.challenge",
    payload: { nonce },
  });
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
  } else {
    await vi.waitFor(() => {
      expect(ws.sent.length).toBeGreaterThan(0);
    });
  }
  return { ws, connectFrame: parseLatestConnectFrame(ws) };
}

async function expectSocketClosed(ws: MockWebSocket) {
  await vi.waitFor(() => expect(ws.readyState).toBe(3), { interval: 1, timeout: 50 });
}

async function startConnect(client: InstanceType<typeof GatewayBrowserClient>, nonce = "nonce-1") {
  client.start();
  return await continueConnect(getLatestWebSocket(), nonce);
}

function emitRetryableTokenMismatch(ws: MockWebSocket, connectId: string | undefined) {
  ws.emitMessage({
    type: "res",
    id: connectId,
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "unauthorized",
      details: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true },
    },
  });
}

async function expectRetriedDeviceTokenConnect(params: {
  url: string;
  token: string;
  retryNonce?: string;
}) {
  const client = new GatewayBrowserClient({
    url: params.url,
    token: params.token,
  });
  const { ws: firstWs, connectFrame: firstConnect } = await startConnect(client);
  expect(firstConnect.params?.auth?.token).toBe(params.token);
  expect(firstConnect.params?.auth?.deviceToken).toBeUndefined();

  emitRetryableTokenMismatch(firstWs, firstConnect.id);
  await expectSocketClosed(firstWs);
  firstWs.emitClose(4008, "connect failed");

  await vi.advanceTimersByTimeAsync(800);
  const secondWs = getLatestWebSocket();
  expect(secondWs).not.toBe(firstWs);
  const { connectFrame: secondConnect } = await continueConnect(
    secondWs,
    params.retryNonce ?? "nonce-2",
  );
  expect(secondConnect.params?.auth?.token).toBe(params.token);
  expect(secondConnect.params?.auth?.deviceToken).toBe("stored-device-token");

  return { client, firstWs, secondWs, firstConnect, secondConnect };
}

describe("GatewayBrowserClient", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    const storage = createStorageMock();
    wsInstances.length = 0;
    loadOrCreateDeviceIdentityMock.mockReset();
    signDevicePayloadMock.mockClear();
    loadOrCreateDeviceIdentityMock.mockResolvedValue({
      deviceId: "device-1",
      privateKey: "private-key", // pragma: allowlist secret
      publicKey: "public-key", // pragma: allowlist secret
    });

    vi.stubGlobal("localStorage", storage);
    stubWindowGlobals(storage);
    localStorage.clear();
    vi.stubGlobal("WebSocket", MockWebSocket);

    storeDeviceAuthToken({
      deviceId: "device-1",
      role: "operator",
      token: "stored-device-token",
      scopes: [...CONTROL_UI_OPERATOR_SCOPES],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("requests full control ui operator scopes with explicit shared auth", async () => {
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });

    const { connectFrame } = await startConnect(client);

    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.minProtocol).toBe(MIN_CLIENT_PROTOCOL_VERSION);
    expect(connectFrame.params?.maxProtocol).toBe(PROTOCOL_VERSION);
    expect(connectFrame.params?.scopes).toEqual([...CONTROL_UI_OPERATOR_SCOPES]);
  });

  it("reuses cached device token scopes when connecting from bootstrap handoff", async () => {
    localStorage.clear();
    const storedEntry = storeDeviceAuthToken({
      deviceId: "device-1",
      role: "operator",
      token: "bootstrap-device-token",
      scopes: ["operator.read", "operator.write", "operator.approvals"],
    });
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
    });

    const { connectFrame } = await startConnect(client);

    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.auth?.token).toBe("bootstrap-device-token");
    expect(connectFrame.params?.scopes).toEqual([
      "operator.approvals",
      "operator.read",
      "operator.write",
    ]);
    expect(connectFrame.params?.scopes).toEqual(storedEntry.scopes);
  });

  it("reports browser security errors from WebSocket construction without retrying", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    class ThrowingWebSocket {
      static OPEN = 1;

      constructor(_url: string) {
        const err = new Error("Cannot connect due to a security error.");
        err.name = "SecurityError";
        throw err;
      }
    }
    vi.stubGlobal("WebSocket", ThrowingWebSocket);

    const client = new GatewayBrowserClient({
      url: "ws://gateway.example:18789",
      token: "shared-auth-token",
      onClose,
    });

    expect(() => client.start()).not.toThrow();
    const close = requireFirstMockArg(onClose, "close");
    expect(close.code).toBe(1006);
    expect(close.reason).toBe("security error");
    const closeError = requireRecord(close.error, "close error");
    const closeErrorDetails = requireRecord(closeError.details, "close error details");
    expect(closeError.code).toBe("BROWSER_WEBSOCKET_SECURITY_ERROR");
    expect(closeError.message).toBe(
      "Browser refused the Gateway WebSocket for security reasons. Use wss:// when the Control UI is served over HTTPS/Tailscale Serve, or open the loopback dashboard at http://127.0.0.1:18789.",
    );
    expect(closeErrorDetails.code).toBe("BROWSER_WEBSOCKET_SECURITY_ERROR");
    expect(closeErrorDetails.browserErrorName).toBe("SecurityError");
    expect(wsInstances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onClose).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("reports generic WebSocket construction failures without retrying", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    class ThrowingWebSocket {
      static OPEN = 1;

      constructor(_url: string) {
        throw new TypeError("constructor failed");
      }
    }
    vi.stubGlobal("WebSocket", ThrowingWebSocket);

    const client = new GatewayBrowserClient({
      url: "ws://gateway.example:18789",
      token: "shared-auth-token",
      onClose,
    });

    expect(() => client.start()).not.toThrow();
    const close = requireFirstMockArg(onClose, "close");
    expect(close.code).toBe(1006);
    expect(close.reason).toBe("websocket error");
    const closeError = requireRecord(close.error, "close error");
    const closeErrorDetails = requireRecord(closeError.details, "close error details");
    expect(closeError.code).toBe("BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR");
    expect(closeError.message).toBe("Could not create the Gateway WebSocket: constructor failed");
    expect(closeErrorDetails.code).toBe("BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR");
    expect(closeErrorDetails.browserErrorName).toBe("TypeError");
    expect(closeErrorDetails.browserMessage).toBe("constructor failed");
    expect(wsInstances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onClose).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("reports request timing for attributed RPC latency", async () => {
    const onRequestTiming = vi.fn();
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
      onRequestTiming,
    });

    const { ws, connectFrame } = await startConnect(client);
    ws.emitMessage({
      type: "res",
      id: connectFrame.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: [] },
      },
    });
    onRequestTiming.mockClear();

    const request = client.request("sessions.list", { includeGlobal: true });
    const frame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string; method?: string };
    expect(frame.method).toBe("sessions.list");

    ws.emitMessage({
      type: "res",
      id: frame.id,
      ok: true,
      payload: { sessions: [] },
    });

    await expect(request).resolves.toEqual({ sessions: [] });
    expectLatestRequestTiming(onRequestTiming, {
      id: frame.id,
      method: "sessions.list",
      ok: true,
    });
  });

  it("reports failed request timing without including request params", async () => {
    const onRequestTiming = vi.fn();
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
      onRequestTiming,
    });

    const { ws, connectFrame } = await startConnect(client);
    ws.emitMessage({
      type: "res",
      id: connectFrame.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: [] },
      },
    });
    onRequestTiming.mockClear();

    const request = client.request("config.get", { token: "do-not-log" });
    const frame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string; method?: string };
    expect(frame.method).toBe("config.get");

    ws.emitMessage({
      type: "res",
      id: frame.id,
      ok: false,
      error: { code: "CONFIG_ERROR", message: "config failed" },
    });

    try {
      await request;
      throw new Error("expected config.get request to reject");
    } catch (error) {
      expect((error as { gatewayCode?: string }).gatewayCode).toBe("CONFIG_ERROR");
    }
    expect(onRequestTiming).toHaveBeenCalledTimes(1);
    expect(requireFirstMockArg(onRequestTiming, "request timing")).not.toHaveProperty("params");
    expectLatestRequestTiming(onRequestTiming, {
      id: frame.id,
      method: "config.get",
      ok: false,
      errorCode: "CONFIG_ERROR",
    });
  });

  it("prefers explicit shared auth over cached device tokens", async () => {
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });

    const { connectFrame } = await startConnect(client);

    expect(typeof connectFrame.id).toBe("string");
    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.auth?.token).toBe("shared-auth-token");
    const [privateKey, signedPayload] = requireFirstSignCall();
    expect(privateKey).toBe("private-key");
    expectSignedPayloadFields(signedPayload, {
      scopes: [...CONTROL_UI_OPERATOR_SCOPES],
      token: "shared-auth-token",
      nonce: "nonce-1",
    });
  });

  it("sends explicit shared token on insecure first connect without cached device fallback", async () => {
    stubInsecureCrypto();
    const client = new GatewayBrowserClient({
      url: "ws://gateway.example:18789",
      token: "shared-auth-token",
    });

    const { connectFrame } = await startConnect(client);

    expect(connectFrame.id).toBe("req-insecure");
    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.auth).toEqual({
      token: "shared-auth-token",
      password: undefined,
      deviceToken: undefined,
    });
    expect(loadOrCreateDeviceIdentityMock).not.toHaveBeenCalled();
    expect(signDevicePayloadMock).not.toHaveBeenCalled();
  });

  it("sends explicit shared password on insecure first connect without cached device fallback", async () => {
    stubInsecureCrypto();
    const client = new GatewayBrowserClient({
      url: "ws://gateway.example:18789",
      password: "shared-password", // pragma: allowlist secret
    });

    const { connectFrame } = await startConnect(client);

    expect(connectFrame.id).toBe("req-insecure");
    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.auth).toEqual({
      token: undefined,
      password: "shared-password", // pragma: allowlist secret
      deviceToken: undefined,
    });
    expect(loadOrCreateDeviceIdentityMock).not.toHaveBeenCalled();
    expect(signDevicePayloadMock).not.toHaveBeenCalled();
  });

  it("uses cached device tokens only when no explicit shared auth is provided", async () => {
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
    });

    const { connectFrame } = await startConnect(client);

    expect(typeof connectFrame.id).toBe("string");
    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.auth?.token).toBe("stored-device-token");
    const [privateKey, signedPayload] = requireFirstSignCall();
    expect(privateKey).toBe("private-key");
    expectSignedPayloadFields(signedPayload, {
      scopes: [
        "operator.admin",
        "operator.approvals",
        "operator.pairing",
        "operator.read",
        "operator.write",
      ],
      token: "stored-device-token",
      nonce: "nonce-1",
    });
  });

  it("ignores cached operator device tokens that do not include read access", async () => {
    localStorage.clear();
    storeDeviceAuthToken({
      deviceId: "device-1",
      role: "operator",
      token: "under-scoped-device-token",
      scopes: [],
    });

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
    });

    const { connectFrame } = await startConnect(client);

    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.auth?.token).toBeUndefined();
    const [, signedPayload] = requireFirstSignCall();
    expectSignedPayloadFields(signedPayload, {
      scopes: [...CONTROL_UI_OPERATOR_SCOPES],
      token: "",
      nonce: "nonce-1",
    });
  });

  it("retries once with device token after token mismatch when shared token is explicit", async () => {
    useNodeFakeTimers();
    const { secondWs, secondConnect } = await expectRetriedDeviceTokenConnect({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });

    secondWs.emitMessage({
      type: "res",
      id: secondConnect.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: "AUTH_TOKEN_MISMATCH" },
      },
    });
    await expectSocketClosed(secondWs);
    secondWs.emitClose(4008, "connect failed");
    expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator" })?.token).toBe(
      "stored-device-token",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances).toHaveLength(2);

    vi.useRealTimers();
  });

  it("stops reconnecting on token mismatch for DNS hosts beginning with a 127 label", async () => {
    useNodeFakeTimers();
    const onClose = vi.fn();
    const client = new GatewayBrowserClient({
      url: "ws://127.example.invalid:18789",
      token: "shared-auth-token",
      onClose,
    });

    try {
      const { ws: firstWs, connectFrame: firstConnect } = await startConnect(client);
      expect(firstConnect.params?.auth?.token).toBe("shared-auth-token");
      expect(firstConnect.params?.auth?.deviceToken).toBeUndefined();

      emitRetryableTokenMismatch(firstWs, firstConnect.id);
      await expectSocketClosed(firstWs);
      firstWs.emitClose(4008, "connect failed");

      await vi.advanceTimersByTimeAsync(30_000);
      expect(wsInstances).toHaveLength(1);
      expect(onClose).toHaveBeenCalledWith({
        code: 4008,
        reason: "connect failed",
        error: {
          code: "INVALID_REQUEST",
          message: "unauthorized",
          details: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true },
          retryable: false,
          retryAfterMs: undefined,
        },
      });
    } finally {
      client.stop();
      vi.useRealTimers();
    }
  });

  it("retries startup-unavailable connect responses without terminal callbacks", async () => {
    useNodeFakeTimers();
    const onClose = vi.fn();
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
      onClose,
    });
    try {
      const { ws, connectFrame } = await startConnect(client);

      ws.emitMessage({
        type: "res",
        id: connectFrame.id,
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "gateway starting; retry shortly",
          details: { reason: "startup-sidecars" },
          retryable: true,
          retryAfterMs: 250,
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      await expectSocketClosed(ws);
      expect(ws.lastClose).toEqual({ code: 4013, reason: "gateway starting" });
      ws.emitClose(4013, "gateway starting");
      expect(onClose).not.toHaveBeenCalled();
      expect(wsInstances).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(249);
      expect(wsInstances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(wsInstances).toHaveLength(2);
    } finally {
      client.stop();
      vi.useRealTimers();
    }
  });

  it("treats IPv6 loopback as trusted for bounded device-token retry", async () => {
    useNodeFakeTimers();
    const { client } = await expectRetriedDeviceTokenConnect({
      url: "ws://[::1]:18789",
      token: "shared-auth-token",
    });

    client.stop();
    vi.useRealTimers();
  });

  it("stops reconnecting on token mismatch when no device-token retry is available", async () => {
    useNodeFakeTimers();
    localStorage.clear();
    const onClose = vi.fn();

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
      onClose,
    });

    const { ws: ws1, connectFrame: firstConnect } = await startConnect(client);

    ws1.emitMessage({
      type: "res",
      id: firstConnect.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: "AUTH_TOKEN_MISMATCH" },
      },
    });
    await expectSocketClosed(ws1);
    ws1.emitClose(4008, "connect failed");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances).toHaveLength(1);
    expect(onClose).toHaveBeenCalledWith({
      code: 4008,
      reason: "connect failed",
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: "AUTH_TOKEN_MISMATCH" },
        retryable: false,
        retryAfterMs: undefined,
      },
    });

    client.stop();
    vi.useRealTimers();
  });

  it("cancels a queued connect send when stopped before the timeout fires", async () => {
    useNodeFakeTimers();

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });

    client.start();
    const ws = getLatestWebSocket();
    ws.emitOpen();

    client.stop();
    await vi.advanceTimersByTimeAsync(750);

    expect(ws.sent).toHaveLength(0);

    vi.useRealTimers();
  });

  it("does not send stale connect frames on a replacement socket", async () => {
    vi.useFakeTimers();
    const identity = createDeferred<DeviceIdentity>();
    loadOrCreateDeviceIdentityMock.mockImplementationOnce(() => identity.promise);

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });

    client.start();
    const firstWs = getLatestWebSocket();
    firstWs.emitOpen();
    firstWs.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-stale" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(firstWs.sent).toHaveLength(0);

    firstWs.emitClose(1006, "socket lost");
    await vi.advanceTimersByTimeAsync(800);
    const secondWs = getLatestWebSocket();
    expect(secondWs).not.toBe(firstWs);

    identity.resolve({
      deviceId: "device-1",
      privateKey: "private-key", // pragma: allowlist secret
      publicKey: "public-key", // pragma: allowlist secret
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(secondWs.sent).toHaveLength(0);

    const { connectFrame } = await continueConnect(secondWs, "nonce-current");
    expect(connectFrame.method).toBe("connect");
    const signedPayload =
      signDevicePayloadMock.mock.calls[signDevicePayloadMock.mock.calls.length - 1]?.[1];
    expectSignedPayloadFields(signedPayload, {
      scopes: [...CONTROL_UI_OPERATOR_SCOPES],
      token: "shared-auth-token",
      nonce: "nonce-current",
    });

    client.stop();
    vi.useRealTimers();
  });

  it("cancels a scheduled reconnect when stopped before the retry fires", async () => {
    useNodeFakeTimers();

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });

    client.start();
    const ws = getLatestWebSocket();
    ws.emitClose(1006, "socket lost");

    client.stop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(wsInstances).toHaveLength(1);

    vi.useRealTimers();
  });

  it("does not auto-reconnect on AUTH_TOKEN_MISSING", async () => {
    useNodeFakeTimers();
    localStorage.clear();

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
    });

    const { ws: ws1, connectFrame: connect } = await startConnect(client);

    ws1.emitMessage({
      type: "res",
      id: connect.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: "AUTH_TOKEN_MISSING" },
      },
    });
    await expectSocketClosed(ws1);
    ws1.emitClose(4008, "connect failed");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances).toHaveLength(1);

    vi.useRealTimers();
  });

  it("keeps reconnecting on PAIRING_REQUIRED when retry hints keep reconnect active", async () => {
    useNodeFakeTimers();
    localStorage.clear();

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "setup-token",
    });

    const { ws: ws1, connectFrame: connect } = await startConnect(client);

    ws1.emitMessage({
      type: "res",
      id: connect.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: {
          code: "PAIRING_REQUIRED",
          reason: "not-paired",
          recommendedNextStep: "wait_then_retry",
          pauseReconnect: false,
        },
      },
    });
    await expectSocketClosed(ws1);
    ws1.emitClose(4008, "connect failed");

    await vi.advanceTimersByTimeAsync(799);
    expect(wsInstances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(wsInstances).toHaveLength(2);

    client.stop();
    vi.useRealTimers();
  });

  it("clears stale stored device tokens and does not reconnect on AUTH_DEVICE_TOKEN_MISMATCH", async () => {
    useNodeFakeTimers();

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
    });

    const { ws, connectFrame } = await startConnect(client);
    expect(connectFrame.params?.auth?.token).toBe("stored-device-token");

    ws.emitMessage({
      type: "res",
      id: connectFrame.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
      },
    });
    await expectSocketClosed(ws);
    ws.emitClose(4008, "connect failed");

    expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator" })).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances).toHaveLength(1);

    vi.useRealTimers();
  });

  it("does not clear stored device tokens or reconnect on AUTH_SCOPE_MISMATCH", async () => {
    useNodeFakeTimers();

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
    });

    const { ws, connectFrame } = await startConnect(client);
    expect(connectFrame.params?.auth?.token).toBe("stored-device-token");

    ws.emitMessage({
      type: "res",
      id: connectFrame.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: "AUTH_SCOPE_MISMATCH" },
      },
    });
    await expectSocketClosed(ws);
    ws.emitClose(4008, "connect failed");

    expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator" })?.token).toBe(
      "stored-device-token",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances).toHaveLength(1);

    vi.useRealTimers();
  });
});

describe("shouldRetryWithDeviceToken", () => {
  beforeEach(() => {
    stubWindowGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows a bounded retry for trusted loopback endpoints", () => {
    expect(
      shouldRetryWithDeviceToken({
        deviceTokenRetryBudgetUsed: false,
        authDeviceToken: undefined,
        explicitGatewayToken: "shared-auth-token",
        deviceIdentity: {
          deviceId: "device-1",
          privateKey: "private-key", // pragma: allowlist secret
          publicKey: "public-key", // pragma: allowlist secret
        },
        storedToken: "stored-device-token",
        canRetryWithDeviceTokenHint: true,
        url: "ws://127.0.0.1:18789",
      }),
    ).toBe(true);
  });

  it("allows a bounded retry for loopback IPv4 addresses in the 127 block", () => {
    expect(
      shouldRetryWithDeviceToken({
        deviceTokenRetryBudgetUsed: false,
        authDeviceToken: undefined,
        explicitGatewayToken: "shared-auth-token",
        deviceIdentity: {
          deviceId: "device-1",
          privateKey: "private-key", // pragma: allowlist secret
          publicKey: "public-key", // pragma: allowlist secret
        },
        storedToken: "stored-device-token",
        canRetryWithDeviceTokenHint: true,
        url: "ws://127.255.10.42:18789",
      }),
    ).toBe(true);
  });

  it("blocks the retry for DNS hosts beginning with a 127 label", () => {
    for (const url of ["ws://127.example.invalid:18789", "ws://127.0.0.1.example.invalid:18789"]) {
      expect(
        shouldRetryWithDeviceToken({
          deviceTokenRetryBudgetUsed: false,
          authDeviceToken: undefined,
          explicitGatewayToken: "shared-auth-token",
          deviceIdentity: {
            deviceId: "device-1",
            privateKey: "private-key", // pragma: allowlist secret
            publicKey: "public-key", // pragma: allowlist secret
          },
          storedToken: "stored-device-token",
          canRetryWithDeviceTokenHint: true,
          url,
        }),
      ).toBe(false);
    }
  });

  it("blocks the retry after the one-shot budget is spent", () => {
    expect(
      shouldRetryWithDeviceToken({
        deviceTokenRetryBudgetUsed: true,
        authDeviceToken: undefined,
        explicitGatewayToken: "shared-auth-token",
        deviceIdentity: {
          deviceId: "device-1",
          privateKey: "private-key", // pragma: allowlist secret
          publicKey: "public-key", // pragma: allowlist secret
        },
        storedToken: "stored-device-token",
        canRetryWithDeviceTokenHint: true,
        url: "ws://127.0.0.1:18789",
      }),
    ).toBe(false);
  });
});
