import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
// Gateway client tests cover WebSocket protocol negotiation, auth persistence,
// proxy bypass setup, command dispatch, reconnect, and error handling.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  MIN_NODE_PROTOCOL_VERSION,
  MIN_PROBE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../packages/gateway-protocol/src/index.js";
import {
  signDevicePayload as signDevicePayloadWithKey,
  type DeviceIdentity,
} from "../infra/device-identity.js";
import { captureEnv } from "../test-utils/env.js";
import type { GatewayClientOptions } from "./client.js";

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

type MockLoggingConfig = {
  redactPatterns?: string[];
  redactSensitive?: "off" | "tools";
};

const wsInstances = vi.hoisted((): MockWebSocket[] => []);
const wsConstructorObservers = vi.hoisted((): Array<(url: string, options: unknown) => void> => []);
const clearDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const clearOriginDeviceTokenMock = vi.hoisted(() => vi.fn());
const loadDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const loadDeviceAuthTokenReadOnlyMock = vi.hoisted(() => vi.fn());
const loadOriginDeviceTokenMock = vi.hoisted(() => vi.fn());
const loadOriginDeviceTokenReadOnlyMock = vi.hoisted(() => vi.fn());
const storeDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const storeOriginDeviceTokenMock = vi.hoisted(() => vi.fn());
const logDebugMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());
const readLoggingConfigMock = vi.hoisted(() =>
  vi.fn<() => MockLoggingConfig | undefined>(() => undefined),
);
const {
  installGlobalProxyMock,
  proxylineRegisterBypassMock,
  proxylineStopMock,
  proxylineUnregisterBypassMock,
} = vi.hoisted(() => {
  const proxylineStopMockLocal = vi.fn();
  const proxylineUnregisterBypassMockLocal = vi.fn();
  const proxylineRegisterBypassMockLocal = vi.fn(() => proxylineUnregisterBypassMockLocal);
  return {
    proxylineRegisterBypassMock: proxylineRegisterBypassMockLocal,
    proxylineStopMock: proxylineStopMockLocal,
    proxylineUnregisterBypassMock: proxylineUnregisterBypassMockLocal,
    installGlobalProxyMock: vi.fn(() => ({
      active: true,
      createNodeAgent: vi.fn(),
      createUndiciDispatcher: vi.fn(),
      createWebSocketAgent: vi.fn(),
      explain: vi.fn(),
      mode: "managed",
      registerBypass: proxylineRegisterBypassMockLocal,
      stop: proxylineStopMockLocal,
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
      default:
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

vi.mock("../../packages/gateway-client/src/websocket.js", () => ({
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
    loadDeviceAuthTokenReadOnly: (...args: unknown[]) => loadDeviceAuthTokenReadOnlyMock(...args),
    loadOriginDeviceToken: (...args: unknown[]) => loadOriginDeviceTokenMock(...args),
    loadOriginDeviceTokenReadOnly: (...args: unknown[]) =>
      loadOriginDeviceTokenReadOnlyMock(...args),
    storeDeviceAuthToken: (...args: unknown[]) => storeDeviceAuthTokenMock(...args),
    storeOriginDeviceToken: (...args: unknown[]) => storeOriginDeviceTokenMock(...args),
    clearDeviceAuthToken: (...args: unknown[]) => clearDeviceAuthTokenMock(...args),
    clearOriginDeviceToken: (...args: unknown[]) => clearOriginDeviceTokenMock(...args),
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

vi.mock("../logging/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../logging/config.js")>("../logging/config.js");
  return {
    ...actual,
    readLoggingConfig: () => readLoggingConfigMock(),
  };
});

type GatewayClientModule = typeof import("./client.js");
type GatewayClientInstance = InstanceType<GatewayClientModule["GatewayClient"]>;

let GatewayClient: GatewayClientModule["GatewayClient"];
let isGatewayConnectAssemblyError: GatewayClientModule["isGatewayConnectAssemblyError"];

async function loadGatewayClientModule() {
  vi.resetModules();
  ({ GatewayClient, isGatewayConnectAssemblyError } = await import("./client.js"));
}

function getLatestWs(): MockWebSocket {
  const ws = wsInstances.at(-1);
  if (!ws) {
    throw new Error("missing mock websocket instance");
  }
  return ws;
}

const requireRecord = createRequireRecord("record", "expected-label-object");

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
function createClientWithIdentity(
  deviceId: string,
  onClose: (code: number, reason: string) => void,
  overrides: Partial<ConstructorParameters<typeof GatewayClient>[0]> = {},
) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const identity: DeviceIdentity = {
    deviceId,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
  return new GatewayClient({
    url: "ws://127.0.0.1:18789",
    deviceIdentity: identity,
    onClose,
    ...overrides,
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

beforeEach(() => {
  logDebugMock.mockClear();
  logErrorMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
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

  it("does not treat hostnames starting with 127 as loopback", () => {
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.example.com:18789",
      onConnectError,
    });

    client.start();

    expectSecurityConnectError(onConnectError, { expectTailscaleHint: true });
    expect(wsInstances.length).toBe(0);
    client.stop();
  });

  it("allows ws:// to IPv4-mapped loopback addresses", () => {
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://[::ffff:127.0.0.1]:18789",
      onConnectError,
    });

    client.start();

    expect(onConnectError).not.toHaveBeenCalled();
    expect(wsInstances.length).toBe(1);
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

  it("allows ws:// to private addresses for trusted LAN and Tailnet configs", () => {
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

  it("allows ws:// to IPv6 link-local addresses across fe80::/10", () => {
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://[fe90::1]:18789",
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
        payload: { nonce: "nonce-1", ts: 1_777_777_777_000 },
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
          payload: { nonce: "nonce-1", ts: 1_777_777_777_000 },
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
  });

  it("clears stale token on device token mismatch close", () => {
    const onClose = vi.fn();
    const env = { OPENCLAW_HOME: "/tmp/custom-openclaw-home" };
    const client = createClientWithIdentity("dev-1", onClose, { env });

    client.start();
    getLatestWs().emitClose(
      1008,
      "unauthorized: DEVICE token mismatch (rotate/reissue device token)",
    );

    expect(clearDeviceAuthTokenMock).toHaveBeenCalledWith({
      deviceId: "dev-1",
      role: "operator",
      env,
    });
    expect(logDebugMock).toHaveBeenCalledWith("cleared stale device-auth token for device dev-1");
    expect(onClose).toHaveBeenCalledWith(
      1008,
      "unauthorized: DEVICE token mismatch (rotate/reissue device token)",
      {
        phase: "pre-hello",
        socketOpened: false,
        transportValidated: false,
        connectRequestSent: false,
        transientPreHelloCleanClose: false,
      },
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
    expect(onClose).toHaveBeenCalledWith(1008, "unauthorized: device token mismatch", {
      phase: "pre-hello",
      socketOpened: false,
      transportValidated: false,
      connectRequestSent: false,
      transientPreHelloCleanClose: false,
    });
    client.stop();
  });

  it("does not clear auth state for non-mismatch close reasons", () => {
    const onClose = vi.fn();
    const client = createClientWithIdentity("dev-3", onClose);

    client.start();
    getLatestWs().emitClose(1008, "unauthorized: signature invalid");

    expect(clearDeviceAuthTokenMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(1008, "unauthorized: signature invalid", {
      phase: "pre-hello",
      socketOpened: false,
      transportValidated: false,
      connectRequestSent: false,
      transientPreHelloCleanClose: false,
    });
    client.stop();
  });

  it("keeps close callback errors inside websocket dispatch", () => {
    const onClose = vi.fn(() => {
      throw new Error("close callback failed");
    });
    const client = createClientWithIdentity("dev-4", onClose);

    client.start();
    expect(() => getLatestWs().emitClose(1008, "unauthorized: signature invalid")).not.toThrow();

    expect(onClose).toHaveBeenCalledWith(1008, "unauthorized: signature invalid", {
      phase: "pre-hello",
      socketOpened: false,
      transportValidated: false,
      connectRequestSent: false,
      transientPreHelloCleanClose: false,
    });
    expect(logDebugMock).toHaveBeenCalledWith(
      "gateway client close handler error: Error: close callback failed",
    );
    client.stop();
  });

  it("keeps a managed reconnect timer after gateway restart closes", async () => {
    vi.useFakeTimers();
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
  });

  it("reconnects quietly after one clean pre-hello close with a pending connect", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const onConnectError = vi.fn();
    const onHelloOk = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      deviceIdentity: null,
      token: "shared-token",
      onClose,
      onConnectError,
      onHelloOk,
    });
    try {
      client.start();
      const firstWs = getLatestWs();
      firstWs.emitOpen();
      firstWs.emitMessage(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "nonce-1", ts: 1_777_777_777_000 },
        }),
      );
      expect(firstWs.sent.some((frame) => frame.includes('"method":"connect"'))).toBe(true);

      firstWs.emitClose(1000, "");
      await vi.advanceTimersByTimeAsync(0);

      expect(onConnectError).not.toHaveBeenCalled();
      expect(logErrorMock).not.toHaveBeenCalledWith(
        expect.stringContaining("gateway connect failed:"),
      );
      expect(onClose).toHaveBeenCalledWith(1000, "", {
        phase: "pre-hello",
        socketOpened: true,
        transportValidated: true,
        connectRequestSent: true,
        transientPreHelloCleanClose: true,
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(wsInstances).toHaveLength(2);
      const secondWs = getLatestWs();
      secondWs.emitOpen();
      secondWs.emitMessage(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "nonce-2", ts: 1_777_777_778_000 },
        }),
      );
      const connectFrame = JSON.parse(
        secondWs.sent.find((frame) => frame.includes('"method":"connect"')) ?? "{}",
      ) as { id?: string };
      secondWs.emitMessage(
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
      await vi.advanceTimersByTimeAsync(0);

      expect(onHelloOk).toHaveBeenCalledOnce();
    } finally {
      client.stop();
      vi.useRealTimers();
    }
  });

  it("surfaces repeated clean pre-hello closes with a pending connect", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      deviceIdentity: null,
      token: "shared-token",
      onClose,
      onConnectError,
    });
    try {
      client.start();
      const firstWs = getLatestWs();
      firstWs.emitOpen();
      firstWs.emitMessage(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "nonce-1", ts: 1_777_777_777_000 },
        }),
      );
      firstWs.emitClose(1000, "");
      await vi.advanceTimersByTimeAsync(0);

      expect(onConnectError).not.toHaveBeenCalled();
      expect(logErrorMock).not.toHaveBeenCalledWith(
        expect.stringContaining("gateway connect failed:"),
      );

      await vi.advanceTimersByTimeAsync(1_000);

      const secondWs = getLatestWs();
      secondWs.emitOpen();
      secondWs.emitMessage(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "nonce-2", ts: 1_777_777_778_000 },
        }),
      );
      secondWs.emitClose(1000, "");
      await vi.advanceTimersByTimeAsync(0);

      expect(onClose).toHaveBeenNthCalledWith(1, 1000, "", {
        phase: "pre-hello",
        socketOpened: true,
        transportValidated: true,
        connectRequestSent: true,
        transientPreHelloCleanClose: true,
      });
      expect(onClose).toHaveBeenNthCalledWith(2, 1000, "", {
        phase: "pre-hello",
        socketOpened: true,
        transportValidated: true,
        connectRequestSent: true,
        transientPreHelloCleanClose: true,
      });
      expect(onConnectError).toHaveBeenCalledOnce();
      expect(onConnectError.mock.calls[0]?.[0]).toMatchObject({
        message: "gateway closed (1000): ",
      });
      expect(logErrorMock).toHaveBeenCalledWith(expect.stringContaining("gateway connect failed:"));
    } finally {
      client.stop();
      vi.useRealTimers();
    }
  });

  it("clears pending reconnect timers on stop", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
    });

    client.start();
    getLatestWs().emitClose(1012, "service restart");
    client.stop();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(wsInstances).toHaveLength(1);
  });

  it("force-terminates a lingering socket after stop", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
    });

    client.start();
    const ws = getLatestWs();
    ws.autoCloseOnClose = false;

    client.stop();

    expect(ws.closeCalls).toBe(1);
    expect(ws.terminateCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(250);

    expect(ws.terminateCalls).toBe(1);
  });

  it("does not force-terminate a socket that closes during stop", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      onClose,
    });

    client.start();
    const ws = getLatestWs();

    client.stop();

    expect(ws.closeCalls).toBe(1);
    expect(onClose).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);

    expect(ws.terminateCalls).toBe(0);
  });

  it("waits for a lingering socket to terminate in stopAndWait", async () => {
    vi.useFakeTimers();
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
    expect(onClose).toHaveBeenCalledWith(1008, "unauthorized: device token mismatch", {
      phase: "pre-hello",
      socketOpened: false,
      transportValidated: false,
      connectRequestSent: false,
      transientPreHelloCleanClose: false,
    });
    client.stop();
  });
});

describe("GatewayClient message dispatch", () => {
  beforeEach(() => {
    wsInstances.length = 0;
  });

  it("keeps event callback errors inside message dispatch", () => {
    const onEvent = vi.fn(() => {
      throw new Error("event callback failed");
    });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      deviceIdentity: null,
      onEvent,
    });

    try {
      client.start();
      const ws = getLatestWs();

      expect(() =>
        ws.emitMessage(
          JSON.stringify({
            type: "event",
            event: "tick",
            payload: {},
          }),
        ),
      ).not.toThrow();
      expect(onEvent).toHaveBeenCalledOnce();
      expect(logDebugMock).toHaveBeenCalledWith(
        "gateway client event handler error: Error: event callback failed",
      );
    } finally {
      client.stop();
    }
  });
});

describe("GatewayClient connect auth payload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    wsInstances.length = 0;
    clearDeviceAuthTokenMock.mockReset();
    clearOriginDeviceTokenMock.mockReset();
    loadDeviceAuthTokenMock.mockReset();
    loadDeviceAuthTokenReadOnlyMock.mockReset();
    loadOriginDeviceTokenMock.mockReset();
    loadOriginDeviceTokenReadOnlyMock.mockReset();
    storeDeviceAuthTokenMock.mockReset();
    storeOriginDeviceTokenMock.mockReset();
    readLoggingConfigMock.mockReset();
    readLoggingConfigMock.mockReturnValue(undefined);
  });

  type ParsedConnectRequest = {
    id?: string;
    params?: {
      minProtocol?: number;
      maxProtocol?: number;
      scopes?: string[];
      client?: {
        id?: string;
        mode?: string;
        platform?: string;
      };
      auth?: {
        token?: string;
        bootstrapToken?: string;
        deviceToken?: string;
        password?: string;
        approvalRuntimeToken?: string;
        agentRuntimeIdentityToken?: string;
      };
      device?: {
        signedAt?: number;
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

  async function advanceToNextReconnect(): Promise<MockWebSocket> {
    const previousCount = wsInstances.length;
    await vi.advanceTimersToNextTimerAsync();
    expect(wsInstances).toHaveLength(previousCount + 1);
    return getLatestWs();
  }

  type ProtocolCompatibilityOptions = Pick<
    GatewayClientOptions,
    "role" | "mode" | "clientName" | "minProtocol" | "maxProtocol"
  >;

  const protocolCompatibilityCases = [
    {
      name: "general clients",
      options: {},
      expectedMinProtocol: MIN_CLIENT_PROTOCOL_VERSION,
      expectedMaxProtocol: PROTOCOL_VERSION,
    },
    {
      name: "exact node clients",
      options: { role: "node", mode: GATEWAY_CLIENT_MODES.NODE },
      expectedMinProtocol: MIN_NODE_PROTOCOL_VERSION,
      expectedMaxProtocol: PROTOCOL_VERSION,
    },
    {
      name: "built-in node hosts before a v3 mismatch",
      options: {
        role: "node",
        mode: GATEWAY_CLIENT_MODES.NODE,
        clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      },
      expectedMinProtocol: PROTOCOL_VERSION,
      expectedMaxProtocol: PROTOCOL_VERSION,
    },
    {
      name: "built-in node hosts with an explicit spanning range",
      options: {
        role: "node",
        mode: GATEWAY_CLIENT_MODES.NODE,
        clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
        minProtocol: MIN_NODE_PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      },
      expectedMinProtocol: PROTOCOL_VERSION,
      expectedMaxProtocol: PROTOCOL_VERSION,
    },
    {
      name: "built-in node hosts with only the legacy minimum",
      options: {
        role: "node",
        mode: GATEWAY_CLIENT_MODES.NODE,
        clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
        minProtocol: MIN_NODE_PROTOCOL_VERSION,
      },
      expectedMinProtocol: PROTOCOL_VERSION,
      expectedMaxProtocol: PROTOCOL_VERSION,
    },
    {
      name: "built-in node hosts with only the current maximum",
      options: {
        role: "node",
        mode: GATEWAY_CLIENT_MODES.NODE,
        clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
        maxProtocol: PROTOCOL_VERSION,
      },
      expectedMinProtocol: PROTOCOL_VERSION,
      expectedMaxProtocol: PROTOCOL_VERSION,
    },
    {
      name: "node role without node mode",
      options: { role: "node" },
      expectedMinProtocol: MIN_CLIENT_PROTOCOL_VERSION,
      expectedMaxProtocol: PROTOCOL_VERSION,
    },
    {
      name: "node mode without node role",
      options: { mode: GATEWAY_CLIENT_MODES.NODE },
      expectedMinProtocol: MIN_CLIENT_PROTOCOL_VERSION,
      expectedMaxProtocol: PROTOCOL_VERSION,
    },
    {
      name: "probe clients",
      options: { mode: GATEWAY_CLIENT_MODES.PROBE },
      expectedMinProtocol: MIN_PROBE_PROTOCOL_VERSION,
      expectedMaxProtocol: PROTOCOL_VERSION,
    },
    {
      name: "explicit node minimum overrides",
      options: {
        role: "node",
        mode: GATEWAY_CLIENT_MODES.NODE,
        minProtocol: PROTOCOL_VERSION,
      },
      expectedMinProtocol: PROTOCOL_VERSION,
      expectedMaxProtocol: PROTOCOL_VERSION,
    },
    {
      name: "explicit node maximum overrides",
      options: {
        role: "node",
        mode: GATEWAY_CLIENT_MODES.NODE,
        maxProtocol: MIN_NODE_PROTOCOL_VERSION,
      },
      expectedMinProtocol: MIN_NODE_PROTOCOL_VERSION,
      expectedMaxProtocol: MIN_NODE_PROTOCOL_VERSION,
    },
  ] satisfies Array<{
    name: string;
    options: ProtocolCompatibilityOptions;
    expectedMinProtocol: number;
    expectedMaxProtocol: number;
  }>;

  it.each(protocolCompatibilityCases)(
    "advertises the protocol compatibility range for $name",
    ({ options, expectedMinProtocol, expectedMaxProtocol }) => {
      const client = new GatewayClient({
        url: "ws://127.0.0.1:18789",
        deviceIdentity: null,
        ...options,
      });

      const { connect } = startClientAndConnect({ client });

      expect(connect.params?.minProtocol).toBe(expectedMinProtocol);
      expect(connect.params?.maxProtocol).toBe(expectedMaxProtocol);
      client.stop();
    },
  );

  it.each([
    { name: "default operator clients", options: {} },
    {
      name: "TUI clients",
      options: {
        clientName: GATEWAY_CLIENT_NAMES.TUI,
        mode: GATEWAY_CLIENT_MODES.UI,
        minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      },
    },
  ])("pauses $name after a permanent protocol mismatch", async ({ options }) => {
    const onReconnectPaused = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      deviceIdentity: null,
      onReconnectPaused,
      ...options,
    });

    const { ws, connect } = startClientAndConnect({ client });
    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws,
      connectId: connect.id,
      failureDetails: {
        code: "PROTOCOL_MISMATCH",
        expectedProtocol: PROTOCOL_VERSION + 1,
      },
      failureMessage: "incompatible gateway version",
    });

    expect(onReconnectPaused).toHaveBeenCalledWith({
      code: 1008,
      reason: "connect failed",
      detailCode: "PROTOCOL_MISMATCH",
    });
  });

  it("signs device proof with the emitted node client mode", () => {
    const signDevicePayload = vi.fn((_privateKeyPem: string, _payload: string) => "signature");
    const client = createClientWithIdentity("device-node-mode", vi.fn(), {
      role: "node",
      mode: GATEWAY_CLIENT_MODES.NODE,
      hostDeps: { signDevicePayload },
    });

    const { connect } = startClientAndConnect({ client });
    const signedPayload = signDevicePayload.mock.calls[0]?.[1];

    expect(connect.params?.client?.mode).toBe(GATEWAY_CLIENT_MODES.NODE);
    expect(signedPayload?.split("|")[3]).toBe(connect.params?.client?.mode);
    client.stop();
  });

  it.each([
    { canonical: "macos", legacy: "darwin", protocolBounds: {} },
    {
      canonical: "macos",
      legacy: "darwin",
      protocolBounds: { minProtocol: MIN_NODE_PROTOCOL_VERSION },
    },
    {
      canonical: "windows",
      legacy: "win32",
      protocolBounds: { maxProtocol: PROTOCOL_VERSION },
    },
  ])(
    "retries a released-v3 Gateway with the shipped $legacy metadata envelope",
    async ({ canonical, legacy, protocolBounds }) => {
      const signDevicePayload = vi.fn((_privateKeyPem: string, _payload: string) => "signature");
      const deviceFamily = canonical === "macos" ? "Mac" : "Windows";
      const modelIdentifier = "TestMachine1,1";
      const client = createClientWithIdentity(`device-${legacy}`, vi.fn(), {
        role: "node",
        mode: GATEWAY_CLIENT_MODES.NODE,
        clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
        platform: canonical,
        deviceFamily,
        modelIdentifier,
        hostDeps: { signDevicePayload },
        ...protocolBounds,
      });

      const { ws: currentWs, connect: currentConnect } = startClientAndConnect({ client });
      expect(currentConnect.params).toMatchObject({
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: { platform: canonical, deviceFamily, modelIdentifier },
      });
      expect(signDevicePayload.mock.calls[0]?.[1]?.split("|").slice(9)).toEqual([
        canonical,
        deviceFamily.toLowerCase(),
      ]);

      emitConnectFailure(
        currentWs,
        currentConnect.id,
        { code: "PROTOCOL_MISMATCH", expectedProtocol: MIN_NODE_PROTOCOL_VERSION },
        "protocol mismatch",
      );
      const legacyWs = await advanceToNextReconnect();
      legacyWs.emitOpen();
      emitConnectChallenge(legacyWs, "nonce-v3");
      const legacyConnect = connectRequestFrom(legacyWs);

      expect(legacyConnect.params).toMatchObject({
        minProtocol: MIN_NODE_PROTOCOL_VERSION,
        maxProtocol: MIN_NODE_PROTOCOL_VERSION,
        client: { platform: legacy },
      });
      expect(legacyConnect.params?.client).not.toHaveProperty("deviceFamily");
      expect(legacyConnect.params?.client).not.toHaveProperty("modelIdentifier");
      expect(signDevicePayload.mock.calls.at(-1)?.[1]?.split("|").slice(9)).toEqual([legacy, ""]);
      client.stop();
    },
  );

  it.each(["macos", "windows"])(
    "keeps canonical %s platform metadata for v4-only nodes",
    (platform) => {
      const client = createClientWithIdentity(`device-v4-${platform}`, vi.fn(), {
        role: "node",
        mode: GATEWAY_CLIENT_MODES.NODE,
        clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
        minProtocol: PROTOCOL_VERSION,
        platform,
        deviceFamily: platform === "macos" ? "Mac" : "Windows",
      });

      const { connect } = startClientAndConnect({ client });
      expect(connect.params?.client?.platform).toBe(platform);
      client.stop();
    },
  );

  it("reconnects with the current envelope when a legacy probe reaches an upgraded Gateway", async () => {
    const onHelloOk = vi.fn();
    const client = createClientWithIdentity("device-gateway-upgrade", vi.fn(), {
      role: "node",
      mode: GATEWAY_CLIENT_MODES.NODE,
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      platform: "macos",
      deviceFamily: "Mac",
      onHelloOk,
    });

    const { ws: currentWs, connect: currentConnect } = startClientAndConnect({ client });
    emitConnectFailure(
      currentWs,
      currentConnect.id,
      { code: "PROTOCOL_MISMATCH", expectedProtocol: MIN_NODE_PROTOCOL_VERSION },
      "protocol mismatch",
    );
    const v3Ws = await advanceToNextReconnect();
    v3Ws.emitOpen();
    emitConnectChallenge(v3Ws, "nonce-v3-initial");
    const v3Connect = connectRequestFrom(v3Ws);
    emitHelloOk(v3Ws, v3Connect.id, MIN_NODE_PROTOCOL_VERSION);
    await waitForFast(() => expect(onHelloOk).toHaveBeenCalledOnce());

    v3Ws.emitClose(1012, "gateway restarting after upgrade");
    const upgradedProbeWs = await advanceToNextReconnect();
    upgradedProbeWs.emitOpen();
    emitConnectChallenge(upgradedProbeWs, "nonce-v3-upgraded");
    const upgradedProbeConnect = connectRequestFrom(upgradedProbeWs);
    expect(upgradedProbeConnect.params).toMatchObject({
      minProtocol: MIN_NODE_PROTOCOL_VERSION,
      maxProtocol: MIN_NODE_PROTOCOL_VERSION,
    });
    emitConnectFailure(
      upgradedProbeWs,
      upgradedProbeConnect.id,
      { code: "PROTOCOL_MISMATCH", expectedProtocol: PROTOCOL_VERSION },
      "protocol mismatch",
    );

    const currentReconnectWs = await advanceToNextReconnect();
    expect(onHelloOk).toHaveBeenCalledOnce();
    currentReconnectWs.emitOpen();
    emitConnectChallenge(currentReconnectWs, "nonce-v4-upgraded");
    const currentReconnect = connectRequestFrom(currentReconnectWs);
    expect(currentReconnect.params).toMatchObject({
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { platform: "macos", deviceFamily: "Mac" },
    });
    emitHelloOk(currentReconnectWs, currentReconnect.id, PROTOCOL_VERSION);
    await waitForFast(() => expect(onHelloOk).toHaveBeenCalledTimes(2));

    currentReconnectWs.emitClose(1012, "gateway rolled back");
    const rolledBackProbeWs = await advanceToNextReconnect();
    rolledBackProbeWs.emitOpen();
    emitConnectChallenge(rolledBackProbeWs, "nonce-v4-rolled-back");
    const rolledBackProbeConnect = connectRequestFrom(rolledBackProbeWs);
    expect(rolledBackProbeConnect.params).toMatchObject({
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
    });
    emitConnectFailure(
      rolledBackProbeWs,
      rolledBackProbeConnect.id,
      { code: "PROTOCOL_MISMATCH", expectedProtocol: MIN_NODE_PROTOCOL_VERSION },
      "protocol mismatch",
    );
    const rolledBackLegacyWs = await advanceToNextReconnect();
    rolledBackLegacyWs.emitOpen();
    emitConnectChallenge(rolledBackLegacyWs, "nonce-v3-rolled-back");
    expect(connectRequestFrom(rolledBackLegacyWs).params).toMatchObject({
      minProtocol: MIN_NODE_PROTOCOL_VERSION,
      maxProtocol: MIN_NODE_PROTOCOL_VERSION,
    });
    client.stop();
  });

  it("keeps explicitly v3-only node hosts connected when a v4 Gateway accepts them", async () => {
    const onHelloOk = vi.fn();
    const client = createClientWithIdentity("device-v3-only", vi.fn(), {
      role: "node",
      mode: GATEWAY_CLIENT_MODES.NODE,
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      minProtocol: MIN_NODE_PROTOCOL_VERSION,
      maxProtocol: MIN_NODE_PROTOCOL_VERSION,
      onHelloOk,
    });

    const { ws, connect } = startClientAndConnect({ client });
    expect(connect.params).toMatchObject({
      minProtocol: MIN_NODE_PROTOCOL_VERSION,
      maxProtocol: MIN_NODE_PROTOCOL_VERSION,
    });

    emitHelloOk(ws, connect.id, PROTOCOL_VERSION);

    await waitForFast(() => expect(onHelloOk).toHaveBeenCalledOnce());
    expect(ws.closeCalls).toBe(0);
    expect(wsInstances).toHaveLength(1);
    client.stop();
  });

  it("returns to v3 when the Gateway rolls back before v4 readiness", async () => {
    const onHelloOk = vi.fn();
    const client = createClientWithIdentity("device-gateway-rollback-before-ready", vi.fn(), {
      role: "node",
      mode: GATEWAY_CLIENT_MODES.NODE,
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      onHelloOk,
    });

    const { ws: initialWs, connect: initialConnect } = startClientAndConnect({ client });
    emitConnectFailure(
      initialWs,
      initialConnect.id,
      { code: "PROTOCOL_MISMATCH", expectedProtocol: MIN_NODE_PROTOCOL_VERSION },
      "protocol mismatch",
    );
    const v3Ws = await advanceToNextReconnect();
    v3Ws.emitOpen();
    emitConnectChallenge(v3Ws, "nonce-v3-ready");
    const v3Connect = connectRequestFrom(v3Ws);
    emitHelloOk(v3Ws, v3Connect.id, MIN_NODE_PROTOCOL_VERSION);
    await waitForFast(() => expect(onHelloOk).toHaveBeenCalledOnce());

    v3Ws.emitClose(1012, "gateway upgrading");
    const v3UpgradeProbeWs = await advanceToNextReconnect();
    v3UpgradeProbeWs.emitOpen();
    emitConnectChallenge(v3UpgradeProbeWs, "nonce-v3-upgrade-probe");
    const v3UpgradeProbe = connectRequestFrom(v3UpgradeProbeWs);
    emitConnectFailure(
      v3UpgradeProbeWs,
      v3UpgradeProbe.id,
      { code: "PROTOCOL_MISMATCH", expectedProtocol: PROTOCOL_VERSION },
      "protocol mismatch",
    );

    const v4Ws = await advanceToNextReconnect();
    v4Ws.emitOpen();
    emitConnectChallenge(v4Ws, "nonce-v4-before-rollback");
    const v4Connect = connectRequestFrom(v4Ws);
    emitConnectFailure(
      v4Ws,
      v4Connect.id,
      { code: "PROTOCOL_MISMATCH", expectedProtocol: MIN_NODE_PROTOCOL_VERSION },
      "protocol mismatch",
    );

    const recoveredV3Ws = await advanceToNextReconnect();
    recoveredV3Ws.emitOpen();
    emitConnectChallenge(recoveredV3Ws, "nonce-v3-after-rollback");
    expect(connectRequestFrom(recoveredV3Ws).params).toMatchObject({
      minProtocol: MIN_NODE_PROTOCOL_VERSION,
      maxProtocol: MIN_NODE_PROTOCOL_VERSION,
    });
    expect(onHelloOk).toHaveBeenCalledOnce();
    client.stop();
  });

  it("pauses a node host after an unsupported protocol mismatch following a supported transition", async () => {
    const onReconnectPaused = vi.fn();
    const client = createClientWithIdentity("device-unsupported-node-protocol", vi.fn(), {
      role: "node",
      mode: GATEWAY_CLIENT_MODES.NODE,
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      onReconnectPaused,
    });

    const { ws: currentWs, connect: currentConnect } = startClientAndConnect({ client });
    emitConnectFailure(currentWs, currentConnect.id, {
      code: "PROTOCOL_MISMATCH",
      expectedProtocol: MIN_NODE_PROTOCOL_VERSION,
    });
    const legacyWs = await advanceToNextReconnect();
    legacyWs.emitOpen();
    emitConnectChallenge(legacyWs, "nonce-unsupported-node-protocol");
    const legacyConnect = connectRequestFrom(legacyWs);
    expect(legacyConnect.params).toMatchObject({
      minProtocol: MIN_NODE_PROTOCOL_VERSION,
      maxProtocol: MIN_NODE_PROTOCOL_VERSION,
    });
    expect(onReconnectPaused).not.toHaveBeenCalled();

    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: legacyWs,
      connectId: legacyConnect.id,
      failureDetails: {
        code: "PROTOCOL_MISMATCH",
        expectedProtocol: PROTOCOL_VERSION + 1,
      },
      failureMessage: "unsupported gateway protocol",
    });

    expect(onReconnectPaused).toHaveBeenCalledWith({
      code: 1008,
      reason: "connect failed",
      detailCode: "PROTOCOL_MISMATCH",
    });
  });

  it.each([
    { platform: "macos", deviceFamily: "Mac" },
    { platform: "win32", deviceFamily: undefined },
    { platform: "custom-os", deviceFamily: "Workstation" },
  ])("preserves explicit caller metadata: %j", ({ platform, deviceFamily }) => {
    const client = createClientWithIdentity("device-third-party-node", vi.fn(), {
      role: "node",
      mode: GATEWAY_CLIENT_MODES.NODE,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      platform,
      deviceFamily,
    });

    const { connect } = startClientAndConnect({ client });
    expect(connect.params?.client).toMatchObject({
      platform,
      ...(deviceFamily ? { deviceFamily } : {}),
    });
    if (deviceFamily === undefined) {
      expect(connect.params?.client).not.toHaveProperty("deviceFamily");
    }
    client.stop();
  });

  it.each([undefined, "Workstation"])(
    "uses canonical Windows metadata and preserves explicit family %s",
    (deviceFamily) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const client = createClientWithIdentity("device-default-windows", vi.fn(), {
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
        deviceFamily,
      });

      try {
        const { connect } = startClientAndConnect({ client });
        expect(connect.params?.client).toMatchObject({
          platform: "windows",
          deviceFamily: deviceFamily ?? "Windows",
        });
      } finally {
        client.stop();
        platformSpy.mockRestore();
      }
    },
  );

  it("preserves runtime metadata defaults for platforms without canonical aliases", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("freebsd");
    const client = createClientWithIdentity("device-freebsd", vi.fn(), {
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      mode: GATEWAY_CLIENT_MODES.TEST,
    });

    try {
      const { connect } = startClientAndConnect({ client });
      expect(connect.params?.client).toMatchObject({ platform: "freebsd" });
      expect(connect.params?.client).not.toHaveProperty("deviceFamily");
    } finally {
      client.stop();
      platformSpy.mockRestore();
    }
  });

  it("does not advertise node plugin tools in the initial connect frame", () => {
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      deviceIdentity: null,
    });

    const { connect } = startClientAndConnect({ client });

    expect(connect.params).not.toHaveProperty("nodePluginTools");
    client.stop();
  });

  it("signs device proof with Gateway time instead of client wall-clock time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
    const client = createClientWithIdentity("device-gateway-time", vi.fn());
    const challengeTs = 1_700_000_000_123;

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws, "nonce-clock-skew", challengeTs);
    const connect = connectRequestFrom(ws);

    expect(connect.params?.device?.signedAt).toBe(challengeTs);
    client.stop();
    vi.useRealTimers();
  });

  it("fails closed when a device challenge omits its Gateway timestamp", () => {
    const onConnectError = vi.fn();
    const client = createClientWithIdentity("device-missing-challenge-time", vi.fn(), {
      onConnectError,
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    ws.emitMessage(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-missing-time" },
      }),
    );

    expect(ws.sent.some((frame) => frame.includes('"method":"connect"'))).toBe(false);
    expect(firstMockArg(onConnectError, "connect error")).toMatchObject({
      message: "gateway connect challenge timestamp invalid",
    });
    expect(ws.lastClose).toEqual({ code: 1008, reason: "connect failed" });
    client.stop();
  });

  it("fails closed when a device challenge timestamp is malformed", () => {
    const onConnectError = vi.fn();
    const client = createClientWithIdentity("device-invalid-challenge-time", vi.fn(), {
      onConnectError,
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    ws.emitMessage(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-invalid-time", ts: "not-a-number" },
      }),
    );

    expect(ws.sent.some((frame) => frame.includes('"method":"connect"'))).toBe(false);
    expect(firstMockArg(onConnectError, "connect error")).toMatchObject({
      message: "gateway connect challenge timestamp invalid",
    });
    expect(ws.lastClose).toEqual({ code: 1008, reason: "connect failed" });
    client.stop();
  });

  function emitConnectChallenge(ws: MockWebSocket, nonce = "nonce-1", ts = 1_800_000_000_000) {
    ws.emitMessage(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce, ts },
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

  it("surfaces connect assembly errors instead of waiting for the wrapper timeout", async () => {
    vi.useFakeTimers();
    let client: GatewayClientInstance | null | undefined;
    try {
      const onClose = vi.fn();
      const onConnectError = vi.fn();
      client = new GatewayClient({
        url: "ws://127.0.0.1:18789",
        token: "shared-token",
        deviceIdentity: {
          deviceId: "bad-device",
          privateKeyPem: "not a pem",
          publicKeyPem: "not a pem",
        },
        onClose,
        onConnectError,
      });

      client.start();
      const ws = getLatestWs();
      ws.emitOpen();
      emitConnectChallenge(ws);

      expect(ws.sent.some((frame) => frame.includes('"method":"connect"'))).toBe(false);
      const error = firstMockArg(onConnectError, "connect error") as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain("gateway request timeout");
      expect(isGatewayConnectAssemblyError(error)).toBe(true);
      expect(ws.lastClose).toEqual({ code: 1008, reason: "connect failed" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(wsInstances).toHaveLength(1);
      expect(logErrorMock).toHaveBeenCalledWith(expect.stringContaining("gateway connect failed:"));
      expect(logDebugMock).not.toHaveBeenCalledWith(
        expect.stringContaining("gateway client parse error:"),
      );
    } finally {
      client?.stop();
      vi.useRealTimers();
    }
  });

  it("keeps connect error callback throws inside challenge dispatch", () => {
    const onConnectError = vi.fn(() => {
      throw new Error("connect callback failed");
    });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      deviceIdentity: null,
      onConnectError,
    });

    try {
      client.start();
      const ws = getLatestWs();
      ws.emitOpen();

      expect(() => emitConnectChallenge(ws, " ")).not.toThrow();
      expect(onConnectError).toHaveBeenCalledOnce();
      expect(ws.lastClose).toEqual({
        code: 1008,
        reason: "connect challenge missing nonce",
      });
      expect(logDebugMock).toHaveBeenCalledWith(
        "gateway client connect error handler error: Error: connect callback failed",
      );
    } finally {
      client.stop();
    }
  });

  it("keeps hello callback errors inside connect dispatch", async () => {
    const onHelloOk = vi.fn(() => {
      throw new Error("hello callback failed");
    });
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      deviceIdentity: null,
      onHelloOk,
      onConnectError,
    });

    try {
      const { ws, connect } = startClientAndConnect({ client });

      expect(() => emitHelloOk(ws, connect.id)).not.toThrow();
      await waitForFast(() => {
        expect(onHelloOk).toHaveBeenCalledOnce();
      });
      expect(onConnectError).not.toHaveBeenCalled();
      expect(ws.lastClose).toBeNull();
      expect(logDebugMock).toHaveBeenCalledWith(
        "gateway client hello-ok handler error: Error: hello callback failed",
      );
      ws.emitClose(1012, "service restart");
      expect(onConnectError).not.toHaveBeenCalled();
    } finally {
      client.stop();
    }
  });

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

  function emitHelloOk(
    ws: MockWebSocket,
    connectId: string | undefined,
    protocol: number = PROTOCOL_VERSION,
  ) {
    ws.emitMessage(
      JSON.stringify({
        type: "res",
        id: connectId,
        ok: true,
        payload: {
          type: "hello-ok",
          protocol,
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
    const ws = await advanceToNextReconnect();
    ws.emitOpen();
    emitConnectChallenge(ws, "nonce-2");
    return connectFrameFrom(ws);
  }

  async function expectNoReconnectAfterConnectFailure(params: {
    client: GatewayClientInstance;
    firstWs: MockWebSocket;
    connectId: string | undefined;
    failureDetails: Record<string, unknown>;
    failureMessage?: string;
  }) {
    vi.useFakeTimers();
    const socketCount = wsInstances.length;
    try {
      emitConnectFailure(
        params.firstWs,
        params.connectId,
        params.failureDetails,
        params.failureMessage,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(wsInstances).toHaveLength(socketCount);
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

  it("binds stored device auth to the exact gateway origin", () => {
    loadOriginDeviceTokenMock.mockImplementation(({ gatewayScope }: { gatewayScope: string }) =>
      gatewayScope === "wss://one.example/rpc"
        ? { token: "origin-one-token", scopes: ["operator.read"] }
        : null,
    );
    const first = createClientWithIdentity("device-1", () => {}, {
      deviceAuthScope: "wss://one.example/rpc",
    });

    first.start();
    const firstWs = getLatestWs();
    firstWs.emitOpen();
    emitConnectChallenge(firstWs);
    expect(connectFrameFrom(firstWs)).toEqual({
      deviceToken: "origin-one-token",
    });
    first.stop();

    const second = createClientWithIdentity("device-1", () => {}, {
      deviceAuthScope: "wss://two.example/rpc",
    });
    second.start();
    const secondWs = getLatestWs();
    secondWs.emitOpen();
    emitConnectChallenge(secondWs);
    expect(connectFrameFrom(secondWs).token).toBeUndefined();
    expect(connectFrameFrom(secondWs).deviceToken).toBeUndefined();
    expect(loadDeviceAuthTokenMock).not.toHaveBeenCalled();
    second.stop();
  });

  it("uses prepared device auth without rereading the token store", () => {
    const client = createClientWithIdentity("device-1", () => {}, {
      preparedDeviceAuth: {
        token: "prepared-device-token",
        role: "operator",
        scopes: ["operator.read"],
        updatedAtMs: 123,
      },
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    expect(connectFrameFrom(ws)).toEqual({
      deviceToken: "prepared-device-token",
    });
    expect(loadDeviceAuthTokenMock).not.toHaveBeenCalled();
    client.stop();
  });

  it.each([
    { completion: "clear", deviceAuthScope: undefined, store: "device" },
    { completion: "overwrite", deviceAuthScope: undefined, store: "device" },
    { completion: "clear", deviceAuthScope: "wss://one.example/rpc", store: "origin" },
    { completion: "overwrite", deviceAuthScope: "wss://one.example/rpc", store: "origin" },
  ] as const)(
    "does not $completion rotated $store auth after the prepared snapshot",
    async ({ completion, deviceAuthScope }) => {
      const preparedDeviceAuth = {
        token: "prepared-device-token",
        role: "operator",
        scopes: ["operator.read"],
        updatedAtMs: 123,
      };
      let durableToken: string | undefined = preparedDeviceAuth.token;
      const clearTokenMock = deviceAuthScope
        ? clearOriginDeviceTokenMock
        : clearDeviceAuthTokenMock;
      const storeTokenMock = deviceAuthScope
        ? storeOriginDeviceTokenMock
        : storeDeviceAuthTokenMock;
      clearTokenMock.mockImplementation(({ expectedToken }: { expectedToken?: string }) => {
        if (durableToken === expectedToken) {
          durableToken = undefined;
        }
      });
      storeTokenMock.mockImplementation(
        ({ expectedToken, token }: { expectedToken?: string; token: string }) => {
          if (durableToken === expectedToken) {
            durableToken = token;
          }
        },
      );
      const client = createClientWithIdentity("device-1", () => {}, {
        preparedDeviceAuth,
        ...(deviceAuthScope ? { deviceAuthScope } : {}),
      });

      const { ws, connect } = startClientAndConnect({ client });
      durableToken = "rotated-device-token";
      if (completion === "clear") {
        emitConnectFailure(ws, connect.id, { code: "AUTH_DEVICE_TOKEN_MISMATCH" });
        await waitForFast(() => expect(clearTokenMock).toHaveBeenCalledOnce());
      } else {
        ws.emitMessage(
          JSON.stringify({
            type: "res",
            id: connect.id,
            ok: true,
            payload: {
              type: "hello-ok",
              auth: {
                role: "operator",
                scopes: ["operator.write"],
                deviceToken: "stale-request-replacement",
              },
            },
          }),
        );
        await waitForFast(() => expect(storeTokenMock).toHaveBeenCalledOnce());
      }

      expect(durableToken).toBe("rotated-device-token");
      client.stop();
    },
  );

  it("keeps read-only origin auth loads and hello tokens off writable host callbacks", async () => {
    loadOriginDeviceTokenReadOnlyMock.mockReturnValue({
      token: "stored-origin-token",
      scopes: ["operator.read"],
    });
    const client = createClientWithIdentity("device-1", () => {}, {
      deviceAuthScope: "wss://one.example/rpc",
      sharedStateMode: "read-only",
    });

    const { ws, connect } = startClientAndConnect({ client });
    expect(connectFrameFrom(ws)).toEqual({
      deviceToken: "stored-origin-token",
    });
    expect(loadOriginDeviceTokenReadOnlyMock).toHaveBeenCalledOnce();
    expect(loadOriginDeviceTokenMock).not.toHaveBeenCalled();

    ws.emitMessage(
      JSON.stringify({
        type: "res",
        id: connect.id,
        ok: true,
        payload: {
          type: "hello-ok",
          auth: {
            role: "operator",
            scopes: ["operator.admin"],
            deviceToken: "issued-origin-token",
          },
        },
      }),
    );

    await waitForFast(() => expect(ws.lastClose).toBeNull());
    expect(storeOriginDeviceTokenMock).not.toHaveBeenCalled();
    expect(clearOriginDeviceTokenMock).not.toHaveBeenCalled();
    client.stop();
  });

  it("keeps explicit shared auth ahead of origin-scoped auth across reconnects", async () => {
    loadOriginDeviceTokenMock.mockReturnValue({ token: "origin-token" });
    const onReconnectPaused = vi.fn();
    const client = createClientWithIdentity("device-1", () => {}, {
      deviceAuthScope: "wss://one.example/rpc",
      token: "explicit-token",
      onReconnectPaused,
    });

    const { ws, connect } = startClientAndConnect({ client });

    expect(connectFrameFrom(ws)).toMatchObject({ token: "explicit-token" });
    expect(connectFrameFrom(ws).deviceToken).toBeUndefined();
    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws,
      connectId: connect.id,
      failureDetails: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true },
    });
    expect(loadOriginDeviceTokenMock).not.toHaveBeenCalled();
    expect(onReconnectPaused).toHaveBeenCalledWith({
      code: 1008,
      reason: "connect failed",
      detailCode: "AUTH_TOKEN_MISMATCH",
    });
  });

  it("preserves stored scopes when hello returns the same origin-scoped token", async () => {
    loadOriginDeviceTokenMock.mockReturnValue({
      token: "stored-origin-token",
      scopes: ["operator.admin", "operator.read"],
    });
    const client = createClientWithIdentity("device-1", () => {}, {
      deviceAuthScope: "wss://one.example/rpc",
    });

    const { ws, connect } = startClientAndConnect({ client });
    ws.emitMessage(
      JSON.stringify({
        type: "res",
        id: connect.id,
        ok: true,
        payload: {
          type: "hello-ok",
          auth: {
            role: "operator",
            scopes: ["operator.read"],
            deviceToken: "stored-origin-token",
          },
        },
      }),
    );

    await waitForFast(() => {
      expect(storeOriginDeviceTokenMock).toHaveBeenCalledWith({
        gatewayScope: "wss://one.example/rpc",
        deviceId: "device-1",
        role: "operator",
        token: "stored-origin-token",
        scopes: ["operator.admin", "operator.read"],
        env: undefined,
      });
    });
    client.stop();
  });

  it("stores hello scopes for a new token in the bound gateway origin", async () => {
    const client = createClientWithIdentity("device-1", () => {}, {
      deviceAuthScope: "wss://one.example/rpc",
    });

    const { ws, connect } = startClientAndConnect({ client });
    ws.emitMessage(
      JSON.stringify({
        type: "res",
        id: connect.id,
        ok: true,
        payload: {
          type: "hello-ok",
          auth: {
            role: "operator",
            scopes: ["operator.read"],
            deviceToken: "issued-origin-token",
          },
        },
      }),
    );

    await waitForFast(() => {
      expect(storeOriginDeviceTokenMock).toHaveBeenCalledWith({
        gatewayScope: "wss://one.example/rpc",
        deviceId: "device-1",
        role: "operator",
        token: "issued-origin-token",
        scopes: ["operator.read"],
        env: undefined,
      });
    });
    expect(storeDeviceAuthTokenMock).not.toHaveBeenCalled();
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

  it("fails closed when a gateway rejects the required agent runtime identity auth field", async () => {
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
      agentRuntimeIdentityToken: "identity-token",
      deviceIdentity: null,
      onConnectError,
    });

    const { ws, connect } = startClientAndConnect({ client });
    expectRecordFields(
      connect.params?.auth ?? {},
      {
        token: "shared-token",
        agentRuntimeIdentityToken: "identity-token",
      },
      "initial connect auth",
    );

    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws,
      connectId: connect.id,
      failureDetails: {},
      failureMessage:
        "invalid connect params: at /auth: unexpected property 'agentRuntimeIdentityToken'",
    });
    const error = firstMockArg(onConnectError, "connect error") as Error;
    expect(error.message).toBe(
      "gateway rejected required agent runtime identity auth field; refusing to retry without it",
    );
    expect(ws.lastClose).toEqual({ code: 1008, reason: "connect failed" });
    expect(logErrorMock).toHaveBeenCalledWith(
      "gateway connect failed: gateway rejected required agent runtime identity auth field; refusing to retry without it",
    );
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

  it("reports a transport close while the connect request is pending", () => {
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
      onConnectError,
    });

    const { ws } = startClientAndConnect({ client });
    ws.emitClose(1006, "socket lost");

    expect(firstMockArg(onConnectError, "connect error")).toMatchObject({
      message: "gateway closed (1006): socket lost",
    });
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

    await waitForFast(() => {
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

  it("redacts secret-bearing connect failure logs", async () => {
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
      deviceIdentity: null,
    });

    const { ws, connect } = startClientAndConnect({ client });
    emitConnectFailure(
      ws,
      connect.id,
      { code: "AUTH_UNAUTHORIZED" },
      "Authorization: Bearer sk-testsecret1234567890abcd wss://user:pass@gateway.example/ws?token=secret-token", // pragma: allowlist secret
    );

    await waitForFast(() => {
      expect(logErrorMock).toHaveBeenCalledWith(expect.stringContaining("gateway connect failed:"));
    });
    const logged = String(logErrorMock.mock.calls.at(-1)?.[0] ?? "");
    expect(logged).toContain("Authorization: Bearer");
    expect(logged).not.toContain("sk-testsecret1234567890abcd");
    expect(logged).not.toContain("user:pass");
    expect(logged).not.toContain("secret-token");
    client.stop();
  });

  it("preserves trailing diagnostics after redacted connect failure URL query params", async () => {
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
      deviceIdentity: null,
    });

    const { ws, connect } = startClientAndConnect({ client });
    emitConnectFailure(
      ws,
      connect.id,
      { code: "AUTH_UNAUTHORIZED" },
      "wss://gateway.example/ws?token=secret-token failed with 401 from remote gateway", // pragma: allowlist secret
    );

    await waitForFast(() => {
      expect(logErrorMock).toHaveBeenCalledWith(expect.stringContaining("gateway connect failed:"));
    });
    const logged = String(logErrorMock.mock.calls.at(-1)?.[0] ?? "");
    expect(logged).toContain("wss://gateway.example/ws?token=*** failed with 401");
    expect(logged).toContain("from remote gateway");
    expect(logged).not.toContain("secret-token");
    client.stop();
  });

  it("forces secret redaction for connect failure logs when general log redaction is off", async () => {
    readLoggingConfigMock.mockReturnValue({ redactSensitive: "off" });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
      deviceIdentity: null,
    });

    const { ws, connect } = startClientAndConnect({ client });
    emitConnectFailure(
      ws,
      connect.id,
      { code: "AUTH_UNAUTHORIZED" },
      "Authorization: Bearer sk-disabledredaction1234567890abcd", // pragma: allowlist secret
    );

    await waitForFast(() => {
      expect(logErrorMock).toHaveBeenCalledWith(expect.stringContaining("gateway connect failed:"));
    });
    const logged = String(logErrorMock.mock.calls.at(-1)?.[0] ?? "");
    expect(logged).toContain("Authorization: Bearer");
    expect(logged).not.toContain("sk-disabledredaction1234567890abcd");
    client.stop();
  });

  it("never logs a registered edge auth header value from connection errors", async () => {
    const clientSecret = "test-secret";
    const client = new GatewayClient({
      url: "wss://gateway.example",
      edgeAuthHeaders: { "X-Edge-Auth": clientSecret },
      deviceIdentity: null,
    });

    const { ws, connect } = startClientAndConnect({ client });
    emitConnectFailure(
      ws,
      connect.id,
      { code: "AUTH_UNAUTHORIZED" },
      `edge rejected service token ${clientSecret}`,
    );

    await waitForFast(() => {
      expect(logErrorMock).toHaveBeenCalledWith(expect.stringContaining("gateway connect failed:"));
    });
    const logged = String(logErrorMock.mock.calls.at(-1)?.[0] ?? "");
    expect(logged).toContain("edge rejected service token");
    expect(logged).not.toContain(clientSecret);
    client.stop();
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
    const signDevicePayload = vi.fn(signDevicePayloadWithKey);
    const client = createClientWithIdentity("device-stored-scopes", vi.fn(), {
      hostDeps: { signDevicePayload },
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    expect(connectFrameFrom(ws)).toEqual({
      deviceToken: "stored-device-token",
    });
    expect(signDevicePayload.mock.calls[0]?.[1]?.split("|")[7]).toBe("stored-device-token");
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

    expect(connectFrameFrom(ws)).toEqual({
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
    expect(connectFrameFrom(ws)).toEqual({
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

  it("emits only the signed bootstrap credential in a preferred node-host connect frame", () => {
    loadDeviceAuthTokenMock.mockReturnValue({ token: "stale-device-token" });
    const signDevicePayload = vi.fn((_privateKeyPem: string, _payload: string) => "signature");
    const client = createClientWithIdentity("device-pairing-bootstrap", vi.fn(), {
      token: "shared-token",
      bootstrapToken: "bootstrap-token",
      password: "shared-password", // pragma: allowlist secret
      preferBootstrapToken: true,
      role: "node",
      mode: GATEWAY_CLIENT_MODES.NODE,
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      scopes: [],
      hostDeps: { signDevicePayload },
    });

    const { connect } = startClientAndConnect({ client });

    expect(connect.params?.client).toMatchObject({
      id: GATEWAY_CLIENT_NAMES.NODE_HOST,
      mode: GATEWAY_CLIENT_MODES.NODE,
    });
    expect(connect.params?.auth).toEqual({ bootstrapToken: "bootstrap-token" });
    expect(signDevicePayload.mock.calls[0]?.[1]?.split("|")[7]).toBe("bootstrap-token");
    client.stop();
  });

  it("prefers a paired bootstrap token once, then reconnects with stored device auth", async () => {
    loadDeviceAuthTokenMock.mockReturnValue({ token: "stale-device-token" });
    const onHelloOk = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
      bootstrapToken: "bootstrap-token",
      password: "shared-password", // pragma: allowlist secret
      preferBootstrapToken: true,
      onHelloOk,
    });

    const { ws, connect } = startClientAndConnect({ client });
    expect(connectFrameFrom(ws)).toMatchObject({ bootstrapToken: "bootstrap-token" });
    expect(connectFrameFrom(ws).token).toBeUndefined();
    expect(connectFrameFrom(ws).deviceToken).toBeUndefined();

    loadDeviceAuthTokenMock.mockReturnValue({ token: "issued-device-token" });
    emitHelloOk(ws, connect.id);
    await waitForFast(() => expect(onHelloOk).toHaveBeenCalledOnce());
    ws.emitClose(1006, "socket lost");
    const reconnect = await advanceToNextReconnect();
    reconnect.emitOpen();
    emitConnectChallenge(reconnect, "nonce-reconnect");
    expect(connectFrameFrom(reconnect)).toEqual({
      deviceToken: "issued-device-token",
    });
    expect(connectFrameFrom(reconnect).password).toBeUndefined();
    expect(connectFrameFrom(reconnect).bootstrapToken).toBeUndefined();
    client.stop();
  });

  it("prefers explicit deviceToken over stored device token", () => {
    loadDeviceAuthTokenMock.mockReturnValue({
      token: "stored-device-token",
      scopes: ["operator.admin", "operator.read"],
    });
    const signDevicePayload = vi.fn(signDevicePayloadWithKey);
    const client = createClientWithIdentity("device-explicit-token", vi.fn(), {
      deviceToken: "explicit-device-token",
      scopes: ["operator.pairing"],
      hostDeps: { signDevicePayload },
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    expect(connectFrameFrom(ws)).toEqual({
      deviceToken: "explicit-device-token",
    });
    expect(signDevicePayload.mock.calls[0]?.[1]?.split("|")[7]).toBe("explicit-device-token");
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

    expect(connectFrameFrom(ws)).toEqual({
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

  it("reports AUTH_RATE_LIMITED before pausing reconnect on the following close", async () => {
    const onConnectError = vi.fn();
    const onReconnectPaused = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
      onConnectError,
      onReconnectPaused,
    });

    const { ws: ws1, connect: firstConnect } = startClientAndConnect({ client });
    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: {
        code: "AUTH_RATE_LIMITED",
        authReason: "rate_limited",
        recommendedNextStep: "wait_then_retry",
      },
      failureMessage: "unauthorized: too many failed authentication attempts (retry later)",
    });

    expect(onConnectError).toHaveBeenCalledOnce();
    expect(onConnectError.mock.calls[0]?.[0]).toMatchObject({
      name: "GatewayClientRequestError",
      details: {
        code: "AUTH_RATE_LIMITED",
        authReason: "rate_limited",
        recommendedNextStep: "wait_then_retry",
      },
    });
    expect(onReconnectPaused).toHaveBeenCalledWith({
      code: 1008,
      reason: "connect failed",
      detailCode: "AUTH_RATE_LIMITED",
    });
    expect(logDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("gateway connect failed: GatewayClientRequestError"),
    );
    expect(logErrorMock).not.toHaveBeenCalledWith(
      expect.stringContaining("gateway connect failed: GatewayClientRequestError"),
    );
  });

  it("keeps reconnect paused callback errors inside close dispatch", async () => {
    const onReconnectPaused = vi.fn(() => {
      throw new Error("paused callback failed");
    });
    const onClose = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
      onReconnectPaused,
      onClose,
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
    expect(logDebugMock).toHaveBeenCalledWith(
      "gateway client reconnect paused handler error: Error: paused callback failed",
    );
    expect(onClose).toHaveBeenCalledWith(1008, "connect failed", {
      connectError: expect.objectContaining({
        details: { code: "AUTH_TOKEN_MISSING" },
        gatewayCode: "INVALID_REQUEST",
        message: "unauthorized",
      }),
      phase: "pre-hello",
      socketOpened: true,
      transportValidated: true,
      connectRequestSent: true,
      transientPreHelloCleanClose: false,
    });
  });

  it("does not auto-reconnect on CLIENT_VERSION_MISMATCH connect failures", async () => {
    const onReconnectPaused = vi.fn();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      role: "node",
      scopes: [],
      onReconnectPaused,
    });

    const { ws: ws1, connect: firstConnect } = startClientAndConnect({ client });
    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: {
        code: "CLIENT_VERSION_MISMATCH",
        clientVersion: "2026.5.25",
        gatewayVersion: "2026.5.26",
      },
      failureMessage: "client version mismatch",
    });
    expect(onReconnectPaused).toHaveBeenCalledWith({
      code: 1008,
      reason: "connect failed",
      detailCode: "CLIENT_VERSION_MISMATCH",
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
    expect(firstConnect.params?.auth).toEqual({ deviceToken: "stored-device-token" });
    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
    });
    const clearTokenParams = expectRecordFields(
      firstMockArg(clearDeviceAuthTokenMock, "clear device token params"),
      { role: "operator", env: undefined },
      "clear device token params",
    );
    expect(clearTokenParams.deviceId).toBeTypeOf("string");
    expect(onReconnectPaused).toHaveBeenCalledWith({
      code: 1008,
      reason: "connect failed",
      detailCode: "AUTH_DEVICE_TOKEN_MISMATCH",
    });
  });

  it("clears stale stored device tokens from the configured environment store", async () => {
    loadDeviceAuthTokenMock.mockReturnValue({
      token: "stored-device-token",
      scopes: ["operator.read"],
    });
    const env = { OPENCLAW_HOME: "/tmp/custom-openclaw-home" };
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      env,
    });

    const { ws: ws1, connect: firstConnect } = startClientAndConnect({ client });
    expect(firstConnect.params?.auth).toEqual({ deviceToken: "stored-device-token" });
    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
    });

    expect(
      expectRecordFields(
        firstMockArg(clearDeviceAuthTokenMock, "clear device token params"),
        {
          role: "operator",
          env,
        },
        "clear device token params",
      ),
    ).toHaveProperty("deviceId");
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
    expect(firstConnect.params?.auth).toEqual({ deviceToken: "stored-device-token" });
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
