/** @vitest-environment node */
import { createHash } from "node:crypto";
import {
  ConnectErrorDetailCodes,
  GATEWAY_CLIENT_CAPS,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadDeviceAuthToken as loadScopedDeviceAuthToken,
  storeDeviceAuthToken as storeScopedDeviceAuthToken,
} from "../lib/nodes/index.ts";
import { createStorageMock } from "../test-helpers/storage.ts";

const wsInstances = vi.hoisted((): MockWebSocket[] => []);
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const LEGACY_DEVICE_AUTH_STORAGE_KEY = "openclaw.device.auth.v1";
const DEFAULT_DEVICE_AUTH_STORAGE_KEY = `${LEGACY_DEVICE_AUTH_STORAGE_KEY}:${DEFAULT_GATEWAY_URL}`;
const STORED_CRED = "stored-device-token";
const ROSITA_CRED = "rosita-device-token";
const WILFRED_CRED = "wilfred-device-token";
const TENANT_A_CRED = "tenant-a-device-token";
const TENANT_B_CRED = "tenant-b-device-token";
type DeviceIdentity = { deviceId: string; privateKey: string; publicKey: string };
const CONTROL_UI_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
] as const;
const CONTROL_UI_BOOTSTRAP_OPERATOR_SCOPES = [
  "operator.approvals",
  "operator.read",
  "operator.talk.secrets",
  "operator.write",
] as const;
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

function loadDeviceAuthToken(params: { deviceId: string; role: string }) {
  return loadScopedDeviceAuthToken({ ...params, gatewayUrl: DEFAULT_GATEWAY_URL });
}

function storeDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
}) {
  return storeScopedDeviceAuthToken({ ...params, gatewayUrl: DEFAULT_GATEWAY_URL });
}

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

vi.mock("../lib/nodes/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/nodes/index.ts")>()),
  loadOrCreateDeviceIdentity: loadOrCreateDeviceIdentityMock,
  signDevicePayload: signDevicePayloadMock,
}));

const { GatewayBrowserClient, GatewayRequestError, resolveGatewayErrorDetailCode } =
  await import("./gateway.ts");

type ConnectFrame = {
  id?: string;
  method?: string;
  params?: {
    auth?: { token?: string; bootstrapToken?: string; password?: string; deviceToken?: string };
    maxProtocol?: number;
    minProtocol?: number;
    caps?: string[];
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

type ConnectTimingPayload = {
  generation?: number;
  phase?: string;
  durationMs?: number;
  phaseDurationMs?: number;
  hasChallenge?: boolean;
  usedFallback?: boolean;
  secureContext?: boolean;
  hasDeviceIdentity?: boolean;
  hasDevice?: boolean;
  hasAuthToken?: boolean;
  hasDeviceToken?: boolean;
  hasPassword?: boolean;
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

function connectTimingPayloads(onConnectTiming: ReturnType<typeof vi.fn>): ConnectTimingPayload[] {
  return onConnectTiming.mock.calls.map(
    ([payload]) => requireRecord(payload, "connect timing") as ConnectTimingPayload,
  );
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
  storeScopedDeviceAuthToken({
    deviceId: "device-1",
    gatewayUrl: params.url,
    role: "operator",
    token: STORED_CRED,
    scopes: [...CONTROL_UI_OPERATOR_SCOPES],
  });
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
  expect(secondConnect.params?.auth?.deviceToken).toBe(STORED_CRED);

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
    expect(connectFrame.params?.caps).toEqual([
      GATEWAY_CLIENT_CAPS.APPROVALS,
      GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS,
      GATEWAY_CLIENT_CAPS.TERMINAL_OFFSET_SEQ,
      GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
      GATEWAY_CLIENT_CAPS.INLINE_WIDGETS,
      GATEWAY_CLIENT_CAPS.UI_COMMANDS,
    ]);
    expect(connectFrame.params?.scopes).toEqual([...CONTROL_UI_OPERATOR_SCOPES]);
  });

  it("requests handoff scopes with bootstrap token auth", async () => {
    const client = new GatewayBrowserClient({
      url: "wss://gateway.example",
      bootstrapToken: "boot-1",
    });

    const { connectFrame } = await startConnect(client);

    expect(connectFrame.params?.auth?.token).toBeUndefined();
    expect(connectFrame.params?.auth?.bootstrapToken).toBe("boot-1");
    expect(connectFrame.params?.scopes).toEqual([...CONTROL_UI_BOOTSTRAP_OPERATOR_SCOPES]);
    const [, signedPayload] = requireFirstSignCall();
    expectSignedPayloadFields(signedPayload, {
      scopes: [...CONTROL_UI_BOOTSTRAP_OPERATOR_SCOPES],
      token: "boot-1",
      nonce: "nonce-1",
    });
  });

  it("adds the current Control UI protocol to bare protocol mismatch errors", () => {
    const error = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "protocol mismatch",
    });

    expect(error.message).toBe(`protocol mismatch: Control UI v${PROTOCOL_VERSION}`);
    expect(resolveGatewayErrorDetailCode(error)).toBe(ConnectErrorDetailCodes.PROTOCOL_MISMATCH);
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
    expect(close.willRetry).toBe(false);
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
    expect(close.willRetry).toBe(false);
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

  it("tracks inbound activity and delegates forced reconnect to the shared socket", async () => {
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "token-oversized",
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
    const activityAfterConnect = client.inboundActivitySeq;

    ws.emitMessage({ type: "event", event: "tick", seq: 1, payload: {} });
    expect(client.inboundActivitySeq).toBe(activityAfterConnect + 1);

    client.forceReconnect("terminal liveness timeout");
    expect(ws.lastClose).toEqual({ code: 4000, reason: "terminal liveness timeout" });
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

  it("reports connect phase timing without credentials or nonce values", async () => {
    const onConnectTiming = vi.fn();
    vi.stubGlobal("performance", {
      now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(35).mockReturnValue(40),
    });
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
      onConnectTiming,
    });

    const { ws, connectFrame } = await startConnect(client, "nonce-secret");
    const sentPayloads = connectTimingPayloads(onConnectTiming);
    expect(sentPayloads.map((payload) => payload.phase)).toEqual([
      "socket-open",
      "challenge",
      "device-identity-ready",
      "connect-plan-ready",
      "request-sent",
    ]);
    expect([sentPayloads[0]?.durationMs, sentPayloads[0]?.phaseDurationMs]).toEqual([25, 25]);
    for (const payload of sentPayloads) {
      expect(payload.generation).toBe(1);
      expect(payload.durationMs).toBeTypeOf("number");
      expect(payload.phaseDurationMs).toBeTypeOf("number");
      expect(payload).not.toHaveProperty("token");
      expect(payload).not.toHaveProperty("passwordValue");
      expect(payload).not.toHaveProperty("nonce");
      expect(JSON.stringify(payload)).not.toContain("shared-auth-token");
      expect(JSON.stringify(payload)).not.toContain("nonce-secret");
    }

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

    await vi.waitFor(() => {
      expect(connectTimingPayloads(onConnectTiming).at(-1)?.phase).toBe("hello");
    });
    expect(connectTimingPayloads(onConnectTiming).at(-1)).toMatchObject({
      generation: 1,
      phase: "hello",
      hasChallenge: true,
      usedFallback: false,
      secureContext: true,
      hasDeviceIdentity: true,
      hasDevice: true,
      hasAuthToken: true,
      hasDeviceToken: false,
      hasPassword: false,
    });
  });

  it("marks fallback connect timing when no challenge arrives", async () => {
    useNodeFakeTimers();
    const onConnectTiming = vi.fn();
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
      onConnectTiming,
    });

    client.start();
    const ws = getLatestWebSocket();
    ws.emitOpen();
    await vi.advanceTimersByTimeAsync(750);

    expect(connectTimingPayloads(onConnectTiming).map((payload) => payload.phase)).toContain(
      "fallback",
    );
    expect(connectTimingPayloads(onConnectTiming).at(-1)).toMatchObject({
      phase: "request-sent",
      hasChallenge: false,
      usedFallback: true,
    });

    client.stop();
    vi.useRealTimers();
  });

  it("reports failed connect timing when the socket closes before hello", async () => {
    const onConnectTiming = vi.fn();
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
      onConnectTiming,
    });

    const { ws } = await startConnect(client);
    ws.emitClose(1006, "socket lost");

    await vi.waitFor(() => {
      expect(connectTimingPayloads(onConnectTiming).at(-1)).toMatchObject({
        phase: "failed",
        errorCode: "SOCKET_CLOSED",
      });
    });

    client.stop();
  });

  it("keeps hello callback errors inside connect dispatch", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onHello = vi.fn(() => {
      throw new Error("hello callback failed");
    });
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
      onHello,
    });

    try {
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

      await vi.waitFor(() => expect(onHello).toHaveBeenCalledOnce());
      await Promise.resolve();
      expect(ws.lastClose).toBeNull();
      expect(consoleError).toHaveBeenCalledWith(
        "[gateway] hello handler error:",
        expect.any(Error),
      );
    } finally {
      client.stop();
      consoleError.mockRestore();
    }
  });

  it("publishes a credential-scoped recovery identity after hello", async () => {
    const onRecoveryScopeChange = vi.fn();
    const client = new GatewayBrowserClient({
      url: DEFAULT_GATEWAY_URL,
      token: "test-auth-token",
      onRecoveryScopeChange,
    });

    const { ws, connectFrame } = await startConnect(client);
    ws.emitMessage({
      type: "res",
      id: connectFrame.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 4,
        auth: {
          role: "operator",
          scopes: [...CONTROL_UI_OPERATOR_SCOPES],
          deviceToken: "test-token-placeholder",
        },
      },
    });

    await vi.waitFor(() => expect(onRecoveryScopeChange).toHaveBeenCalledOnce());
    expect(client.recoveryScopeReady).toBe(true);
    expect(client.recoveryScope).toBe(
      createHash("sha256").update("test-token-placeholder").digest("hex"),
    );
    expect(client.recoveryScope).not.toContain("test-token-placeholder");
    client.stop();
  });

  it("keeps close callback errors from blocking reconnect scheduling", async () => {
    useNodeFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onClose = vi.fn(() => {
      throw new Error("close callback failed");
    });
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
      onClose,
    });

    try {
      const { ws } = await startConnect(client);

      expect(() => ws.emitClose(1006, "socket lost")).not.toThrow();
      await vi.advanceTimersByTimeAsync(800);

      expect(onClose).toHaveBeenCalledWith({
        code: 1006,
        reason: "socket lost",
        error: undefined,
        willRetry: true,
      });
      expect(consoleError).toHaveBeenCalledWith(
        "[gateway] close handler error:",
        expect.any(Error),
      );
      expect(wsInstances).toHaveLength(2);
    } finally {
      client.stop();
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps gap callback errors from blocking event delivery", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onGap = vi.fn(() => {
      throw new Error("gap callback failed");
    });
    const onEvent = vi.fn();
    const listener = vi.fn();
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
      onGap,
      onEvent,
    });

    try {
      client.addEventListener(listener);
      client.start();
      const ws = getLatestWebSocket();

      ws.emitMessage({ type: "event", event: "session.updated", seq: 1 });
      onEvent.mockClear();
      listener.mockClear();

      expect(() =>
        ws.emitMessage({ type: "event", event: "session.updated", seq: 3 }),
      ).not.toThrow();

      expect(onGap).toHaveBeenCalledWith({ expected: 2, received: 3 });
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: "session.updated", seq: 3 }),
      );
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ event: "session.updated", seq: 3 }),
      );
      expect(consoleError).toHaveBeenCalledWith("[gateway] gap handler error:", expect.any(Error));

      onGap.mockClear();
      ws.emitMessage({ type: "event", event: "session.updated", seq: 4 });
      expect(onGap).not.toHaveBeenCalled();
    } finally {
      client.stop();
      consoleError.mockRestore();
    }
  });

  it("keeps event callback errors from blocking event listeners", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onEvent = vi.fn(() => {
      throw new Error("event callback failed");
    });
    const listener = vi.fn();
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
      onEvent,
    });

    try {
      client.addEventListener(listener);
      client.start();
      const ws = getLatestWebSocket();

      expect(() =>
        ws.emitMessage({ type: "event", event: "session.updated", seq: 1 }),
      ).not.toThrow();

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: "session.updated", seq: 1 }),
      );
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ event: "session.updated", seq: 1 }),
      );
      expect(consoleError).toHaveBeenCalledWith(
        "[gateway] event handler error:",
        expect.any(Error),
      );
    } finally {
      client.stop();
      consoleError.mockRestore();
    }
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

  it("uses a scoped device token when legacy cleanup fails", async () => {
    vi.spyOn(localStorage, "removeItem").mockImplementation(() => {
      throw new Error("storage cleanup blocked");
    });
    const client = new GatewayBrowserClient({
      url: DEFAULT_GATEWAY_URL,
    });

    const { connectFrame } = await startConnect(client);

    expect(connectFrame.params?.auth?.token).toBe(STORED_CRED);
  });

  it("migrates the legacy device token store to the first gateway opened after upgrade", async () => {
    const legacyStore = localStorage.getItem(DEFAULT_DEVICE_AUTH_STORAGE_KEY);
    expect(legacyStore).not.toBeNull();
    localStorage.clear();
    localStorage.setItem(LEGACY_DEVICE_AUTH_STORAGE_KEY, legacyStore ?? "");

    const client = new GatewayBrowserClient({
      url: DEFAULT_GATEWAY_URL,
    });
    const { connectFrame } = await startConnect(client);

    expect(connectFrame.params?.auth?.token).toBe(STORED_CRED);
    expect(localStorage.getItem(LEGACY_DEVICE_AUTH_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(DEFAULT_DEVICE_AUTH_STORAGE_KEY)).toBe(legacyStore);
  });

  it("keeps cached device tokens separate for gateways on the same origin", async () => {
    localStorage.clear();
    storeScopedDeviceAuthToken({
      deviceId: "device-1",
      gatewayUrl: "wss://gateway.example/rosita/",
      role: "operator",
      token: ROSITA_CRED,
      scopes: [...CONTROL_UI_OPERATOR_SCOPES],
    });
    storeScopedDeviceAuthToken({
      deviceId: "device-1",
      gatewayUrl: "wss://gateway.example/wilfred",
      role: "operator",
      token: WILFRED_CRED,
      scopes: [...CONTROL_UI_OPERATOR_SCOPES],
    });

    const rositaClient = new GatewayBrowserClient({
      url: "wss://gateway.example/rosita",
    });
    const { connectFrame: rositaConnect } = await startConnect(rositaClient);
    expect(rositaConnect.params?.auth?.token).toBe(ROSITA_CRED);
    rositaClient.stop();

    const wilfredClient = new GatewayBrowserClient({
      url: "wss://gateway.example/wilfred",
    });
    const { connectFrame: wilfredConnect } = await startConnect(wilfredClient, "nonce-2");
    expect(wilfredConnect.params?.auth?.token).toBe(WILFRED_CRED);
    wilfredClient.stop();
  });

  it("keeps cached device tokens separate for gateway query routes", async () => {
    localStorage.clear();
    storeScopedDeviceAuthToken({
      deviceId: "device-1",
      gatewayUrl: "wss://gateway.example/control?tenant=a",
      role: "operator",
      token: TENANT_A_CRED,
      scopes: [...CONTROL_UI_OPERATOR_SCOPES],
    });
    storeScopedDeviceAuthToken({
      deviceId: "device-1",
      gatewayUrl: "wss://gateway.example/control?tenant=b",
      role: "operator",
      token: TENANT_B_CRED,
      scopes: [...CONTROL_UI_OPERATOR_SCOPES],
    });

    const tenantAClient = new GatewayBrowserClient({
      url: "wss://gateway.example/control?tenant=a",
    });
    const { connectFrame: tenantAConnect } = await startConnect(tenantAClient);
    expect(tenantAConnect.params?.auth?.token).toBe(TENANT_A_CRED);
    tenantAClient.stop();

    const tenantBClient = new GatewayBrowserClient({
      url: "wss://gateway.example/control?tenant=b",
    });
    const { connectFrame: tenantBConnect } = await startConnect(tenantBClient, "nonce-2");
    expect(tenantBConnect.params?.auth?.token).toBe(TENANT_B_CRED);
    tenantBClient.stop();
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
    expect(
      loadDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
      })?.token,
    ).toBe("stored-device-token");
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
        willRetry: false,
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

  it("preserves structured connect errors for pending requests", async () => {
    useNodeFakeTimers();
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });

    try {
      const { ws, connectFrame } = await startConnect(client);
      const pendingRequest = client.request("cron.list", { quiet: true });

      ws.emitMessage({
        type: "res",
        id: connectFrame.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "unauthorized",
          details: { code: "PAIRING_REQUIRED" },
        },
      });
      await expectSocketClosed(ws);
      ws.emitClose(4008, "connect failed");

      await expect(pendingRequest).rejects.toMatchObject({
        name: "GatewayRequestError",
        gatewayCode: "INVALID_REQUEST",
        details: { code: "PAIRING_REQUIRED" },
      });
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
      willRetry: false,
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

  it.each([
    ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
    ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID,
    ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
    ConnectErrorDetailCodes.AUTH_RATE_LIMITED,
    ConnectErrorDetailCodes.PAIRING_REQUIRED,
  ])("does not auto-reconnect on %s", async (detailCode) => {
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
        details: { code: detailCode },
      },
    });
    await expectSocketClosed(ws1);
    ws1.emitClose(4008, "connect failed");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances).toHaveLength(1);

    vi.useRealTimers();
  });

  it("does not auto-reconnect on PROTOCOL_MISMATCH", async () => {
    useNodeFakeTimers();

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });

    const { ws: ws1, connectFrame: connect } = await startConnect(client);

    ws1.emitMessage({
      type: "res",
      id: connect.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "protocol mismatch",
        details: { code: "PROTOCOL_MISMATCH" },
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

    expect(
      loadDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
      }),
    ).toBeNull();
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

    expect(
      loadDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
      })?.token,
    ).toBe("stored-device-token");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances).toHaveLength(1);

    vi.useRealTimers();
  });

  it("reports willRetry=false on credential rejections so the UI can fall back to the login gate", async () => {
    useNodeFakeTimers();
    const onClose = vi.fn();
    const onConnectTiming = vi.fn();

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      password: "wrong-password",
      onClose,
      onConnectTiming,
    });

    const { ws, connectFrame } = await startConnect(client);
    ws.emitMessage({
      type: "res",
      id: connectFrame.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: "AUTH_PASSWORD_MISMATCH" },
      },
    });
    await expectSocketClosed(ws);
    ws.emitClose(4008, "connect failed");

    const close = requireFirstMockArg(onClose, "close");
    expect(close.willRetry).toBe(false);
    expect(connectTimingPayloads(onConnectTiming).at(-1)).toMatchObject({
      phase: "failed",
      errorCode: "INVALID_REQUEST",
      hasDeviceIdentity: true,
      hasPassword: true,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances).toHaveLength(1);

    vi.useRealTimers();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
