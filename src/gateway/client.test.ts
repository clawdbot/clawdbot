import { Buffer } from "node:buffer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { captureEnv } from "../test-utils/env.js";

const wsInstances = vi.hoisted((): MockWebSocket[] => []);
const clearDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const loadDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const storeDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const logDebugMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());

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

  constructor(_url: string, _options?: unknown) {
    wsInstances.push(this);
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
}

vi.mock("ws", () => ({
  WebSocket: MockWebSocket,
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
  expect(onConnectError).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining("SECURITY ERROR"),
    }),
  );
  const error = onConnectError.mock.calls[0]?.[0] as Error;
  expect(error.message).toContain("openclaw doctor --fix");
  if (params?.expectTailscaleHint) {
    expect(error.message).toContain("Tailscale Serve/Funnel");
  }
}

beforeAll(async () => {
  await loadGatewayClientModule();
});

describe("GatewayClient security checks", () => {
  const envSnapshot = captureEnv(["OPENCLAW_ALLOW_INSECURE_PRIVATE_WS"]);

  beforeEach(() => {
    envSnapshot.restore();
    delete process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS;
    wsInstances.length = 0;
  });

  afterEach(() => {
    envSnapshot.restore();
    delete process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS;
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

    // Should not throw
    expect(() => client.start()).not.toThrow();

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
    client.stop();
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
    expect(() => {
      getLatestWs().emitClose(1008, "unauthorized: device token mismatch");
    }).not.toThrow();

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
    loadDeviceAuthTokenMock.mockReset();
    storeDeviceAuthTokenMock.mockReset();
    logDebugMock.mockClear();
    logErrorMock.mockClear();
  });

  type ParsedConnectRequest = {
    id?: string;
    params?: {
      scopes?: string[];
      auth?: {
        token?: string;
        bootstrapToken?: string;
        deviceToken?: string;
        password?: string;
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
  ) {
    ws.emitMessage(
      JSON.stringify({
        type: "res",
        id: connectId,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "unauthorized",
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
  }) {
    emitConnectFailure(params.firstWs, params.connectId, params.failureDetails);
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

    await vi.waitFor(() =>
      expect(onConnectError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "gateway client stopped" }),
      ),
    );
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
    expect(clearDeviceAuthTokenMock).toHaveBeenCalledWith({
      deviceId: expect.any(String),
      role: "operator",
    });
    expect(onReconnectPaused).toHaveBeenCalledWith({
      code: 1008,
      reason: "connect failed",
      detailCode: "AUTH_DEVICE_TOKEN_MISMATCH",
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
