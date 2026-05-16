import { Buffer } from "node:buffer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { captureEnv } from "../test-utils/env.js";
import { MIN_CLIENT_PROTOCOL_VERSION, PROTOCOL_VERSION } from "./protocol/index.js";

const wsInstances = vi.hoisted((): MockWebSocket[] => []);
const wsConstructorObservers = vi.hoisted((): Array<(url: string, options: unknown) => void> => []);
const clearDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const loadDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const storeDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const logDebugMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());
const {
  installGlobalProxyMock,
  proxylineRegisterBypassMock,
  proxylineStopMock,
  proxylineUnregisterBypassMock,
} = vi.hoisted(() => {
  const proxylineStopMock = vi.fn();
  const proxylineUnregisterBypassMock = vi.fn();
  const proxylineRegisterBypassMock = vi.fn(() => proxylineUnregisterBypassMock);
  return {
    proxylineRegisterBypassMock,
    proxylineStopMock,
    proxylineUnregisterBypassMock,
    installGlobalProxyMock: vi.fn(() => ({
      active: true,
      createNodeAgent: vi.fn(),
      createUndiciDispatcher: vi.fn(),
      createWebSocketAgent: vi.fn(),
      explain: vi.fn(),
      mode: "managed",
      registerBypass: proxylineRegisterBypassMock,
      stop: proxylineStopMock,
      withBypass: vi.fn(),
    })),
  };
});

type WsEvent = "open" | "message" | "close" | "error";
type WsEventHandlers = {
  open: () => void;
  message: (data: string | Buffer) => void;
  close: (code: number, reason: Buffer) => void;
  error: (err: unknown) => void;
};

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  private openHandlers: WsEventHandlers["open"][] = [];
  private messageHandlers: WsEventHandlers["message"][] = [];
  private closeHandlers: WsEventHandlers["close"][] = [];
  private errorHandlers: WsEventHandlers["error"][] = [];
  readonly sent: string[] = [];
  closeCalls = 0;
  lastClose: { code?: number; reason?: string } | null = null;
  terminateCalls = 0;
  autoCloseOnClose = true;
  readyState = MockWebSocket.CONNECTING;
  readonly options: unknown;

  constructor(_url: string, options?: unknown) {
    this.options = options;
    wsInstances.push(this);
    for (const observer of wsConstructorObservers) {
      observer(_url, options);
    }
  }

  on(event: "open", handler: WsEventHandlers["open"]): void;
  on(event: "message", handler: WsEventHandlers["message"]): void;
  on(event: "close", handler: WsEventHandlers["close"]): void;
  on(event: "error", handler: WsEventHandlers["error"]): void;
  on(event: WsEvent, handler: WsEventHandlers[WsEvent]): void {
    switch (event) {
      case "open":
        this.openHandlers.push(handler as WsEventHandlers["open"]);
        return;
      case "message":
        this.messageHandlers.push(handler as WsEventHandlers["message"]);
        return;
      case "close":
        this.closeHandlers.push(handler as WsEventHandlers["close"]);
        return;
      case "error":
        this.errorHandlers.push(handler as WsEventHandlers["error"]);
        return;
      default:
        return;
    }
  }

  close(code?: number, reason?: string): void {
    this.closeCalls += 1;
    this.lastClose = { code, reason };
    this.readyState = MockWebSocket.CLOSING;
    if (this.autoCloseOnClose) {
      this.emitClose(code ?? 1000, reason ?? "");
    }
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    for (const handler of this.openHandlers) {
      handler();
    }
  }

  emitMessage(data: string): void {
    for (const handler of this.messageHandlers) {
      handler(data);
    }
  }

  emitClose(code: number, reason: string): void {
    this.readyState = MockWebSocket.CLOSED;
    for (const handler of this.closeHandlers) {
      handler(code, Buffer.from(reason));
    }
  }

  emitError(error: unknown): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }
}

vi.mock("ws", () => ({
  WebSocket: MockWebSocket,
}));

vi.mock("@openclaw/proxyline", () => ({
  installGlobalProxy: installGlobalProxyMock,
}));

vi.mock("../infra/device-auth-store.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/device-auth-store.js")>(
    "../infra/device-auth-store.js",
  );
  return {
    ...actual,
    loadDeviceAuthToken: (...args: unknown[]) => loadDeviceAuthTokenMock(...args),
    storeDeviceAuthToken: (...args: unknown[]) => storeDeviceAuthTokenMock(...args),
    clearDeviceAuthToken: (...args: unknown[]) => clearDeviceAuthTokenMock(...args),
  };
});

vi.mock("../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../logger.js")>("../logger.js");
  return {
    ...actual,
    logDebug: (...args: unknown[]) => logDebugMock(...args),
    logError: (...args: unknown[]) => logErrorMock(...args),
  };
});

type GatewayClientModule = typeof import("./client.js");
type GatewayClientInstance = InstanceType<GatewayClientModule["GatewayClient"]>;

let GatewayClient: GatewayClientModule["GatewayClient"];

async function loadGatewayClientModule() {
  vi.resetModules();
  ({ GatewayClient } = await import("./client.js"));
}

function getLatestWs(): MockWebSocket {
  const ws = wsInstances.at(-1);
  if (!ws) {
    throw new Error("missing mock websocket instance");
  }
  return ws;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(
  value: unknown,
  expected: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
  return record;
}

function firstMockArg(mock: ReturnType<typeof vi.fn>, label: string): unknown {
  const [arg] = mock.mock.calls[0] ?? [];
  if (arg === undefined) {
    throw new Error(`expected ${label}`);
  }
  return arg;
}

async function expectGatewayRequestError(
  promise: Promise<unknown>,
  expected: Record<string, unknown>,
): Promise<void> {
  let rejected: unknown;
  try {
    await promise;
  } catch (error) {
    rejected = error;
  }
  const error = expectRecordFields(rejected, expected, "gateway request error");
  expectRecordFields(error.details, { method: "chat.history" }, "gateway request error details");
}

function createClientWithIdentity(
  deviceId: string,
  onClose: (code: number, reason: string) => void,
) {
  const identity: DeviceIdentity = {
    deviceId,
    privateKeyPem: "private-key", // pragma: allowlist secret
    publicKeyPem: "public-key",
  };
  return new GatewayClient({
    url: "ws://127.0.0.1:18789",
    deviceIdentity: identity,
    onClose,
  });
}

function expectSecurityConnectError(
  onConnectError: ReturnType<typeof vi.fn>,
  params?: { expectTailscaleHint?: boolean },
) {
  const error = firstMockArg(onConnectError, "connect error") as Error;
  expect(error.message).toContain("SECURITY ERROR");
  expect(error.message).toContain("openclaw doctor --fix");
  if (params?.expectTailscaleHint) {
    expect(error.message).toContain("Tailscale Serve/Funnel");
  }
}

beforeAll(async () => {
  await loadGatewayClientModule();
});

describe("GatewayClient security checks", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_PROXY_LOOPBACK_MODE",
    "HTTP_PROXY",
  ]);

  beforeEach(async () => {
    envSnapshot.restore();
    delete process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS;
    delete process.env.OPENCLAW_PROXY_ACTIVE;
    delete process.env.OPENCLAW_PROXY_LOOPBACK_MODE;
    delete process.env.HTTP_PROXY;
    const { resetProxyLifecycleForTests } = await import("../infra/net/proxy/proxy-lifecycle.js");
    resetProxyLifecycleForTests();
    installGlobalProxyMock.mockClear();
    proxylineRegisterBypassMock.mockClear();
    proxylineStopMock.mockClear();
    proxylineUnregisterBypassMock.mockClear();
    wsInstances.length = 0;
    wsConstructorObservers.length = 0;
  });

  afterEach(async () => {
    envSnapshot.restore();
    delete process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS;
    delete process.env.OPENCLAW_PROXY_ACTIVE;
    delete process.env.OPENCLAW_PROXY_LOOPBACK_MODE;
    delete process.env.HTTP_PROXY;
    const { resetProxyLifecycleForTests } = await import("../infra/net/proxy/proxy-lifecycle.js");
    resetProxyLifecycleForTests();
    wsConstructorObservers.length = 0;
  });

  it("blocks ws:// to non-loopback addresses (CWE-319)", () => {
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://remote.example.com:18789",
      onConnectError,
    });

    client.start();

    expectSecurityConnectError(onConnectError, { expectTailscaleHint: true });
    expect(wsInstances.length).toBe(0); // No WebSocket created
    client.stop();
  });

  it("handles malformed URLs gracefully without crashing", () => {
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "not-a-valid-url",
      onConnectError,
    });

    expect(client.start()).toBeUndefined();

    expectSecurityConnectError(onConnectError);
    expect(wsInstances.length).toBe(0); // No WebSocket created
    client.stop();
  });

  it("allows ws:// to loopback addresses", () => {
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      onConnectError,
    });

    client.start();

    expect(onConnectError).not.toHaveBeenCalled();
    expect(wsInstances.length).toBe(1); // WebSocket created
    expect(getLatestWs().options).not.toHaveProperty("agent");
    client.stop();
  });

  it("bootstraps inherited managed proxy routing before proxy-mode loopback WebSocket creation", () => {
    process.env.OPENCLAW_PROXY_ACTIVE = "1";
    process.env.OPENCLAW_PROXY_LOOPBACK_MODE = "proxy";
    process.env.HTTP_PROXY = "http://127.0.0.1:3128";
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      onConnectError,
    });

    client.start();

    expect(onConnectError).not.toHaveBeenCalled();
    expect(wsInstances.length).toBe(1);
    expect(getLatestWs().options).not.toMatchObject({ agent: expect.any(Object) });
    expect(installGlobalProxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ifActive: "reuse-compatible",
        mode: "managed",
        proxyUrl: "http://127.0.0.1:3128",
        undici: expect.objectContaining({ allowH2: false }),
      }),
    );
    client.stop();
  });

  it("keeps gateway-only loopback bypass active only during WebSocket construction", () => {
    process.env.OPENCLAW_PROXY_ACTIVE = "1";
    process.env.OPENCLAW_PROXY_LOOPBACK_MODE = "gateway-only";
    process.env.HTTP_PROXY = "http://127.0.0.1:3128";
    const onConnectError = vi.fn();
    const bypassActiveDuringConstruction: boolean[] = [];
    wsConstructorObservers.push(() => {
      bypassActiveDuringConstruction.push(
        proxylineRegisterBypassMock.mock.calls.length === 1 &&
          proxylineUnregisterBypassMock.mock.calls.length === 0,
      );
    });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      onConnectError,
    });

    client.start();

    expect(proxylineRegisterBypassMock).toHaveBeenCalledWith({ url: "ws://127.0.0.1:18789" });
    expect(bypassActiveDuringConstruction).toEqual([true]);
    expect(proxylineUnregisterBypassMock).toHaveBeenCalledOnce();
    const ws = getLatestWs();

    ws.emitOpen();

    expect(proxylineUnregisterBypassMock).toHaveBeenCalledOnce();
    expect(onConnectError).not.toHaveBeenCalled();
    client.stop();
  });

  it("clears gateway-only loopback bypass when WebSocket connection errors before opening", () => {
    process.env.OPENCLAW_PROXY_ACTIVE = "1";
    process.env.OPENCLAW_PROXY_LOOPBACK_MODE = "gateway-only";
    process.env.HTTP_PROXY = "http://127.0.0.1:3128";
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      onConnectError,
    });

    client.start();

    expect(proxylineRegisterBypassMock).toHaveBeenCalledWith({ url: "ws://127.0.0.1:18789" });
    expect(proxylineUnregisterBypassMock).toHaveBeenCalledOnce();
    const ws = getLatestWs();

    ws.emitError(new Error("proxy connection failed"));

    expect(proxylineUnregisterBypassMock).toHaveBeenCalledOnce();
    expect(onConnectError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "proxy connection failed" }),
    );
    client.stop();
  });

  it("proxies ws:// loopback addresses when active proxy loopbackMode is proxy", async () => {
    const { startProxy, stopProxy } = await import("../infra/net/proxy/proxy-lifecycle.js");
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
      loopbackMode: "proxy",
    });
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      onConnectError,
    });

    try {
      client.start();

      expect(onConnectError).not.toHaveBeenCalled();
      expect(wsInstances.length).toBe(1);
      expect(getLatestWs().options).not.toMatchObject({ agent: expect.any(Object) });
    } finally {
      client.stop();
      await stopProxy(handle);
    }
  });

  it("blocks ws:// loopback addresses when active proxy loopbackMode is block", async () => {
    const { startProxy, stopProxy } = await import("../infra/net/proxy/proxy-lifecycle.js");
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
      loopbackMode: "block",
    });
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      onConnectError,
    });

    try {
      expect(() => client.start()).toThrow("blocked by proxy.loopbackMode");
      expect(wsInstances.length).toBe(0);
    } finally {
      client.stop();
      await stopProxy(handle);
    }
  });

  it("allows wss:// to any address", () => {
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "wss://remote.example.com:18789",
      onConnectError,
    });

    client.start();

    expect(onConnectError).not.toHaveBeenCalled();
    expect(wsInstances.length).toBe(1); // WebSocket created
    client.stop();
  });

  it("allows ws:// to private addresses only with OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1", () => {
    process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS = "1";
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://192.168.1.100:18789",
      onConnectError,
    });

    client.start();

    expect(onConnectError).not.toHaveBeenCalled();
    expect(wsInstances.length).toBe(1);
    client.stop();
  });

  it("allows ws:// hostnames with OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1", () => {
    process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS = "1";
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://openclaw-gateway.ai:18789",
      onConnectError,
    });

    client.start();

    expect(onConnectError).not.toHaveBeenCalled();
    expect(wsInstances.length).toBe(1);
    client.stop();
  });
});

describe("GatewayClient request errors", () => {
  it("preserves retry metadata from gateway error responses", async () => {
    const onClose = vi.fn();
    const client = createClientWithIdentity("device-main", onClose);
    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    ws.emitMessage(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-1" },
      }),
    );
    const connectFrame = JSON.parse(
      ws.sent.find((frame) => frame.includes('"method":"connect"')) ?? "{}",
    ) as { id?: string };
    ws.emitMessage(
      JSON.stringify({
        type: "res",
        id: connectFrame.id,
        ok: true,
        payload: {
          type: "hello-ok",
          auth: { role: "operator", scopes: ["operator.admin"] },
        },
      }),
    );

    const requestPromise = client.request("chat.history", { sessionKey: "main" });
    const requestFrame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string };

    ws.emitMessage(
      JSON.stringify({
        type: "res",
        id: requestFrame.id,
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "chat.history unavailable during gateway startup",
          details: { method: "chat.history" },
          retryable: true,
          retryAfterMs: 250,
        },
      }),
    );

    await expect(requestPromise).rejects.toMatchObject({
      name: "GatewayClientRequestError",
      gatewayCode: "UNAVAILABLE",
      retryable: true,
      retryAfterMs: 250,
      details: { method: "chat.history" },
    });

    client.stop();
  });

  it("retries startup-unavailable connect failures without terminal callbacks", async () => {
    vi.useFakeTimers();
    wsInstances.length = 0;
    logDebugMock.mockClear();
    logErrorMock.mockClear();
    const onClose = vi.fn();
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      deviceIdentity: null,
      onClose,
      onConnectError,
    });
    try {
      client.start();
      const ws = getLatestWs();
      ws.emitOpen();
      ws.emitMessage(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "nonce-1" },
        }),
      );
      const connectFrame = JSON.parse(
        ws.sent.find((frame) => frame.includes('"method":"connect"')) ?? "{}",
      ) as { id?: string };

      ws.emitMessage(
        JSON.stringify({
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
        }),
      );

      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }

      expect(onConnectError).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(ws.lastClose).toEqual({ code: 1013, reason: "gateway starting" });
      expect(logDebugMock).toHaveBeenCalledWith(expect.stringContaining("gateway connect failed:"));
      expect(logErrorMock).not.toHaveBeenCalledWith(
        expect.stringContaining("gateway connect failed:"),
      );
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
});

describe("GatewayClient close handling", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    clearDeviceAuthTokenMock.mockClear();
    clearDeviceAuthTokenMock.mockImplementation(() => undefined);
    logDebugMock.mockClear();
  });

  it("clears stale token on device token mismatch close", () => {
    const onClose = vi.fn();
    const client = createClientWithIdentity("dev-1", onClose);

    client.start();
    getLatestWs().emitClose(
      1008,
      "unauthorized: DEVICE token mismatch (rotate/reissue device token)",
    );

    expect(clearDeviceAuthTokenMock).toHaveBeenCalledWith({ deviceId: "dev-1", role: "operator" });
    expect(logDebugMock).toHaveBeenCalledWith("cleared stale device-auth token for device dev-1");
    expect(onClose).toHaveBeenCalledWith(
      1008,
      "unauthorized: DEVICE token mismatch (rotate/reissue device token)",
    );
    client.stop();
  });

  it("does not break close flow when token clear throws", () => {
    clearDeviceAuthTokenMock.mockImplementation(() => {
      throw new Error("disk unavailable");
    });
    const onClose = vi.fn();
    const client = createClientWithIdentity("dev-2", onClose);

    client.start();
    expect(getLatestWs().emitClose(1008, "unauthorized: device token mismatch")).toBeUndefined();

    expect(logDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("failed clearing stale device-auth token"),
    );
    expect(onClose).toHaveBeenCalledWith(1008, "unauthorized: device token mismatch");
    client.stop();
  });

  it("does not clear auth state for non-mismatch close reasons", () => {
    const onClose = vi.fn();
    const client = createClientWithIdentity("dev-3", onClose);

    client.start();
    getLatestWs().emitClose(1008, "unauthorized: signature invalid");

    expect(clearDeviceAuthTokenMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(1008, "unauthorized: signature invalid");
    client.stop();
  });

  it("keeps a managed reconnect timer after gateway restart closes", async () => {
    vi.useFakeTimers();
    try {
      const client = new GatewayClient({
        url: "ws://127.0.0.1:18789",
      });

      client.start();
      getLatestWs().emitClose(1012, "service restart");

      expect(wsInstances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(wsInstances).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);

      expect(wsInstances).toHaveLength(2);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears pending reconnect timers on stop", async () => {
    vi.useFakeTimers();
    try {
      const client = new GatewayClient({
        url: "ws://127.0.0.1:18789",
      });

      client.start();
      getLatestWs().emitClose(1012, "service restart");
      client.stop();

      await vi.advanceTimersByTimeAsync(30_000);

      expect(wsInstances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-terminates a lingering socket after stop", async () => {
    vi.useFakeTimers();
    try {
      const client = new GatewayClient({
        url: "ws://127.0.0.1:18789",
      });

      client.start();
      const ws = getLatestWs();

      client.stop();

      expect(ws.closeCalls).toBe(1);
      expect(ws.terminateCalls).toBe(0);

      await vi.advanceTimersByTimeAsync(250);

      expect(ws.terminateCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a lingering socket to terminate in stopAndWait", async () => {
    vi.useFakeTimers();
    try {
      const client = new GatewayClient({
        url: "ws://127.0.0.1:18789",
      });

      client.start();
      const ws = getLatestWs();
      ws.autoCloseOnClose = false;

      let settled = false;
      const stopPromise = client.stopAndWait().then(() => {
        settled = true;
      });

      expect(ws.closeCalls).toBe(1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(249);
      expect(ws.terminateCalls).toBe(0);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await stopPromise;

      expect(ws.terminateCalls).toBe(1);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clear persisted device auth when explicit shared token is provided", () => {
    const onClose = vi.fn();
    const identity: DeviceIdentity = {
      deviceId: "dev-4",
      privateKeyPem: "private-key", // pragma: allowlist secret
      publicKeyPem: "public-key",
    };
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      deviceIdentity: identity,
      token: "shared-token",
      onClose,
    });

    client.start();
    getLatestWs().emitClose(1008, "unauthorized: device token mismatch");

    expect(clearDeviceAuthTokenMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(1008, "unauthorized: device token mismatch");
    client.stop();
  });
});

describe("GatewayClient connect auth payload", () => {
  beforeEach(() => {
    vi.useRealTimers();
    wsInstances.length = 0;
    clearDeviceAuthTokenMock.mockReset();
    loadDeviceAuthTokenMock.mockReset();
    storeDeviceAuthTokenMock.mockReset();
    logDebugMock.mockClear();
    logErrorMock.mockClear();
  });

  type ParsedConnectRequest = {
    id?: string;
    params?: {
      minProtocol?: number;
      maxProtocol?: number;
      scopes?: string[];
      auth?: {
        token?: string;
        bootstrapToken?: string;
        deviceToken?: string;
        password?: string;
        approvalRuntimeToken?: string;
      };
    };
  };

  function parseConnectRequest(ws: MockWebSocket): ParsedConnectRequest {
    const raw = ws.sent.find((frame) => frame.includes('"method":"connect"'));
    if (!raw) {
      throw new Error("missing connect frame");
    }
    return JSON.parse(raw) as ParsedConnectRequest;
  }

  function connectFrameFrom(ws: MockWebSocket) {
    return parseConnectRequest(ws).params?.auth ?? {};
  }

  function connectScopesFrom(ws: MockWebSocket) {
    return parseConnectRequest(ws).params?.scopes ?? [];
  }

  function connectRequestFrom(ws: MockWebSocket) {
    return parseConnectRequest(ws);
  }

  it("advertises the default protocol compatibility range", () => {
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      deviceIdentity: null,
    });

    const { connect } = startClientAndConnect({ client });

    expect(connect.params?.minProtocol).toBe(MIN_CLIENT_PROTOCOL_VERSION);
    expect(connect.params?.maxProtocol).toBe(PROTOCOL_VERSION);
    client.stop();
  });

  function emitConnectChallenge(ws: MockWebSocket, nonce = "nonce-1") {
    ws.emitMessage(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce },
      }),
    );
  }

  function startClientAndConnect(params: { client: GatewayClientInstance; nonce?: string }) {
    params.client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws, params.nonce);
    return { ws, connect: connectRequestFrom(ws) };
  }

  function startClientWithEarlyChallenge(params: {
    client: GatewayClientInstance;
    nonce?: string;
  }) {
    params.client.start();
    const ws = getLatestWs();
    emitConnectChallenge(ws, params.nonce);
    ws.emitOpen();
    return { ws, connect: connectRequestFrom(ws) };
  }

  function emitConnectFailure(
    ws: MockWebSocket,
    connectId: string | undefined,
    details: Record<string, unknown>,
    message = "unauthorized",
  ) {
    ws.emitMessage(
      JSON.stringify({
        type: "res",
        id: connectId,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message,
          details,
        },
      }),
    );
  }

  function emitHelloOk(ws: MockWebSocket, connectId: string | undefined) {
    ws.emitMessage(
      JSON.stringify({
        type: "res",
        id: connectId,
        ok: true,
        payload: {
          type: "hello-ok",
          auth: { role: "operator", scopes: ["operator.admin"] },
        },
      }),
    );
  }

  async function expectRetriedConnectAuth(params: {
    firstWs: MockWebSocket;
    connectId: string | undefined;
    failureDetails: Record<string, unknown>;
    failureMessage?: string;
  }) {
    emitConnectFailure(
      params.firstWs,
      params.connectId,
      params.failureDetails,
      params.failureMessage,
    );
    await vi.waitFor(() => expect(wsInstances.length).toBeGreaterThan(1), { timeout: 3_000 });
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws, "nonce-2");
    return connectFrameFrom(ws);
  }

  async function expectNoReconnectAfterConnectFailure(params: {
    client: GatewayClientInstance;
    firstWs: MockWebSocket;
    connectId: string | undefined;
    failureDetails: Record<string, unknown>;
  }) {
    vi.useFakeTimers();
    try {
      emitConnectFailure(params.firstWs, params.connectId, params.failureDetails);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(wsInstances).toHaveLength(1);
    } finally {
      params.client.stop();
      vi.useRealTimers();
    }
  }

  it("uses explicit shared token and does not inject stored device token", () => {
    loadDeviceAuthTokenMock.mockReturnValue({ token: "stored-device-token" });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    expect(connectFrameFrom(ws)).toMatchObject({
      token: "shared-token",
    });
    expect(connectFrameFrom(ws).deviceToken).toBeUndefined();
    client.stop();
  });

  it("retries without approval runtime token when a gateway rejects the auth field", async () => {
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
      approvalRuntimeToken: "runtime-token",
      deviceIdentity: null,
    });

    const { ws: ws1, connect: firstConnect } = startClientAndConnect({ client });
    expectRecordFields(
      firstConnect.params?.auth ?? {},
      {
        token: "shared-token",
        approvalRuntimeToken: "runtime-token",
      },
      "initial connect auth",
    );

    const retriedAuth = await expectRetriedConnectAuth({
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: {},
      failureMessage:
        "invalid connect params: at /auth: unexpected property 'approvalRuntimeToken'",
    });
    expectRecordFields(
      retriedAuth,
      {
        token: "shared-token",
      },
      "retried connect auth",
    );
    expect(retriedAuth.approvalRuntimeToken).toBeUndefined();
    client.stop();
  });

  it("waits for socket open before sending connect after an early challenge", () => {
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
    });

    const { ws, connect } = startClientWithEarlyChallenge({ client });

    expect(connectFrameFrom(ws)).toMatchObject({
      token: "shared-token",
    });
    emitHelloOk(ws, connect.id);
    client.stop();
  });

  it("logs stopped connect handshakes at debug level during teardown", async () => {
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
      onConnectError,
    });

    const { ws } = startClientAndConnect({ client });
    ws.autoCloseOnClose = false;
    client.stop();

    await vi.waitFor(() => {
      const error = firstMockArg(onConnectError, "connect error") as Error;
      expect(error?.message).toBe("gateway client stopped");
    });
    expect(logDebugMock).toHaveBeenCalledWith(
      "gateway connect failed: Error: gateway client stopped",
    );
    expect(logErrorMock).not.toHaveBeenCalledWith(
      "gateway connect failed: Error: gateway client stopped",
    );
    expect(ws.closeCalls).toBe(1);
  });

  it("uses explicit shared password and does not inject stored device token", () => {
    loadDeviceAuthTokenMock.mockReturnValue({ token: "stored-device-token" });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      password: "shared-password", // pragma: allowlist secret
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    expect(connectFrameFrom(ws)).toMatchObject({
      password: "shared-password", // pragma: allowlist secret
    });
    expect(connectFrameFrom(ws).token).toBeUndefined();
    expect(connectFrameFrom(ws).deviceToken).toBeUndefined();
    client.stop();
  });

  it("prefers explicit shared password over bootstrap token", () => {
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      bootstrapToken: "stale-bootstrap-token",
      password: "shared-password", // pragma: allowlist secret
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    expect(connectFrameFrom(ws)).toMatchObject({
      password: "shared-password", // pragma: allowlist secret
    });
    expect(connectFrameFrom(ws).bootstrapToken).toBeUndefined();
    expect(connectFrameFrom(ws).token).toBeUndefined();
    client.stop();
  });

  it("uses stored device token scopes when shared token is not provided", () => {
    loadDeviceAuthTokenMock.mockReturnValue({
      token: "stored-device-token",
      scopes: ["operator.read", "operator.write"],
    });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    expect(connectFrameFrom(ws)).toMatchObject({
      token: "stored-device-token",
      deviceToken: "stored-device-token",
    });
    expect(connectScopesFrom(ws)).toEqual(["operator.read", "operator.write"]);
    client.stop();
  });

  it("keeps requested scopes when reusing a stored device token", () => {
    loadDeviceAuthTokenMock.mockReturnValue({
      token: "stored-device-token",
      scopes: ["operator.write"],
    });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      scopes: ["operator.admin"],
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    expect(connectFrameFrom(ws)).toMatchObject({
      token: "stored-device-token",
      deviceToken: "stored-device-token",
    });
    expect(connectScopesFrom(ws)).toEqual(["operator.admin"]);
    client.stop();
  });

  it("loads stored device auth from the provided env", () => {
    loadDeviceAuthTokenMock.mockReturnValue({
      token: "stored-device-token",
      scopes: ["operator.read"],
    });
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: "/tmp/openclaw-client-service-state",
    } as NodeJS.ProcessEnv;
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      env,
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    const loadTokenParams = expectRecordFields(
      firstMockArg(loadDeviceAuthTokenMock, "load device token params"),
      {
        role: "operator",
        env,
      },
      "load device token params",
    );
    expect(loadTokenParams.deviceId).toBeTypeOf("string");
    expect(connectFrameFrom(ws)).toMatchObject({
      token: "stored-device-token",
      deviceToken: "stored-device-token",
    });
    client.stop();
  });

  it("uses bootstrap token when no shared or device token is available", () => {
    loadDeviceAuthTokenMock.mockReturnValue(undefined);
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      bootstrapToken: "bootstrap-token",
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    expect(connectFrameFrom(ws)).toMatchObject({
      bootstrapToken: "bootstrap-token",
    });
    expect(connectFrameFrom(ws).token).toBeUndefined();
    expect(connectFrameFrom(ws).deviceToken).toBeUndefined();
    client.stop();
  });

  it("prefers explicit deviceToken over stored device token", () => {
    loadDeviceAuthTokenMock.mockReturnValue({
      token: "stored-device-token",
      scopes: ["operator.admin", "operator.read"],
    });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      deviceToken: "explicit-device-token",
      scopes: ["operator.pairing"],
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    expect(connectFrameFrom(ws)).toMatchObject({
      token: "explicit-device-token",
      deviceToken: "explicit-device-token",
    });
    expect(connectScopesFrom(ws)).toEqual(["operator.pairing"]);
    client.stop();
  });

  it("falls back to requested scopes when stored device token has no cached scopes", () => {
    loadDeviceAuthTokenMock.mockReturnValue({
      token: "stored-device-token",
      scopes: [],
    });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      scopes: ["operator.approvals"],
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    expect(connectFrameFrom(ws)).toMatchObject({
      token: "stored-device-token",
      deviceToken: "stored-device-token",
    });
    expect(connectScopesFrom(ws)).toEqual(["operator.approvals"]);
    client.stop();
  });

  it("retries with stored device token after shared-token mismatch on trusted endpoints", async () => {
    loadDeviceAuthTokenMock.mockReturnValue({
      token: "stored-device-token",
      scopes: ["operator.read"],
    });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
    });

    const { ws: ws1, connect: firstConnect } = startClientAndConnect({ client });
    expect(firstConnect.params?.auth?.token).toBe("shared-token");
    expect(firstConnect.params?.auth?.deviceToken).toBeUndefined();

    const retriedAuth = await expectRetriedConnectAuth({
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true },
    });
    expect(retriedAuth).toMatchObject({
      token: "shared-token",
      deviceToken: "stored-device-token",
    });
    const ws = getLatestWs();
    expect(connectScopesFrom(ws)).toEqual(["operator.read"]);
    client.stop();
  });

  it("retries with stored device token when server recommends retry_with_device_token", async () => {
    loadDeviceAuthTokenMock.mockReturnValue({ token: "stored-device-token" });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
    });

    const { ws: ws1, connect: firstConnect } = startClientAndConnect({ client });
    const retriedAuth = await expectRetriedConnectAuth({
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: { code: "AUTH_UNAUTHORIZED", recommendedNextStep: "retry_with_device_token" },
    });
    expect(retriedAuth).toMatchObject({
      token: "shared-token",
      deviceToken: "stored-device-token",
    });
    client.stop();
  });

  it("does not auto-reconnect on AUTH_TOKEN_MISSING connect failures", async () => {
    const onReconnectPaused = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
      onReconnectPaused,
    });

    const { ws: ws1, connect: firstConnect } = startClientAndConnect({ client });
    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: { code: "AUTH_TOKEN_MISSING" },
    });
    expect(onReconnectPaused).toHaveBeenCalledWith({
      code: 1008,
      reason: "connect failed",
      detailCode: "AUTH_TOKEN_MISSING",
    });
  });

  it("does not auto-reconnect on token mismatch when no device-token retry is available", async () => {
    loadDeviceAuthTokenMock.mockReturnValue(null);
    const onReconnectPaused = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
      onReconnectPaused,
    });

    const { ws: ws1, connect: firstConnect } = startClientAndConnect({ client });
    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true },
    });
    expect(onReconnectPaused).toHaveBeenCalledWith({
      code: 1008,
      reason: "connect failed",
      detailCode: "AUTH_TOKEN_MISMATCH",
    });
  });

  it("keeps reconnecting on PAIRING_REQUIRED when retry hints keep reconnect active", async () => {
    vi.useFakeTimers();
    const onReconnectPaused = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      bootstrapToken: "setup-bootstrap-token",
      role: "node",
      scopes: [],
      onReconnectPaused,
    });

    try {
      const { ws: ws1, connect: firstConnect } = startClientAndConnect({ client });
      emitConnectFailure(ws1, firstConnect.id, {
        code: "PAIRING_REQUIRED",
        reason: "not-paired",
        recommendedNextStep: "wait_then_retry",
        pauseReconnect: false,
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(wsInstances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(wsInstances).toHaveLength(2);
      expect(onReconnectPaused).not.toHaveBeenCalled();
    } finally {
      client.stop();
      vi.useRealTimers();
    }
  });

  it("clears stale stored device tokens and does not reconnect on AUTH_DEVICE_TOKEN_MISMATCH", async () => {
    loadDeviceAuthTokenMock.mockReturnValue({
      token: "stored-device-token",
      scopes: ["operator.read"],
    });
    const onReconnectPaused = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      onReconnectPaused,
    });

    const { ws: ws1, connect: firstConnect } = startClientAndConnect({ client });
    expect(firstConnect.params?.auth?.token).toBe("stored-device-token");
    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
    });
    const clearTokenParams = expectRecordFields(
      firstMockArg(clearDeviceAuthTokenMock, "clear device token params"),
      { role: "operator" },
      "clear device token params",
    );
    expect(clearTokenParams.deviceId).toBeTypeOf("string");
    expect(onReconnectPaused).toHaveBeenCalledWith({
      code: 1008,
      reason: "connect failed",
      detailCode: "AUTH_DEVICE_TOKEN_MISMATCH",
    });
  });

  it("does not clear stored device tokens or reconnect on AUTH_SCOPE_MISMATCH", async () => {
    loadDeviceAuthTokenMock.mockReturnValue({
      token: "stored-device-token",
      scopes: ["operator.read"],
    });
    const onReconnectPaused = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      onReconnectPaused,
    });

    const { ws: ws1, connect: firstConnect } = startClientAndConnect({ client });
    expect(firstConnect.params?.auth?.token).toBe("stored-device-token");
    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: { code: "AUTH_SCOPE_MISMATCH" },
    });
    expect(clearDeviceAuthTokenMock).not.toHaveBeenCalled();
    expect(onReconnectPaused).toHaveBeenCalledWith({
      code: 1008,
      reason: "connect failed",
      detailCode: "AUTH_SCOPE_MISMATCH",
    });
  });

  it("does not auto-reconnect on token mismatch when retry is not trusted", async () => {
    loadDeviceAuthTokenMock.mockReturnValue({ token: "stored-device-token" });
    const client = new GatewayClient({
      url: "wss://gateway.example.com:18789",
      token: "shared-token",
    });

    const { ws: ws1, connect: firstConnect } = startClientAndConnect({ client });
    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true },
    });
  });
});
