// Probe device-auth scope tests exercise the real probe -> client -> connect-frame path.
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import { storeDeviceAuthToken, storeOriginDeviceToken } from "../infra/device-auth-store.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-utils/temp-dir.js";

type WebSocketEvent = "open" | "message" | "close" | "error" | "unexpected-response";

const webSockets = vi.hoisted((): ProbeWebSocket[] => []);

class ProbeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly sent: string[] = [];
  readyState = ProbeWebSocket.CONNECTING;
  binaryType = "nodebuffer";
  private readonly handlers: Record<WebSocketEvent, Array<(...args: unknown[]) => void>> = {
    open: [],
    message: [],
    close: [],
    error: [],
    "unexpected-response": [],
  };

  constructor(_url: string, _options?: unknown) {
    webSockets.push(this);
  }

  on(event: WebSocketEvent, handler: (...args: unknown[]) => void): void {
    this.handlers[event].push(handler);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === ProbeWebSocket.CLOSED) {
      return;
    }
    this.emitClose(code, reason);
  }

  terminate(): void {
    this.emitClose(1006, "terminated");
  }

  emitOpen(): void {
    this.readyState = ProbeWebSocket.OPEN;
    for (const handler of this.handlers.open) {
      handler();
    }
  }

  emitMessage(data: string): void {
    for (const handler of this.handlers.message) {
      handler(data);
    }
  }

  emitClose(code: number, reason: string): void {
    this.readyState = ProbeWebSocket.CLOSED;
    for (const handler of this.handlers.close) {
      handler(code, Buffer.from(reason));
    }
  }
}

vi.mock("ws", () => ({ WebSocket: ProbeWebSocket }));

const { probeGateway } = await import("./probe.js");

type ConnectFrame = {
  id?: string;
  params?: {
    auth?: { token?: string; deviceToken?: string; password?: string };
    device?: { id?: string };
  };
};

function createEnv(stateDir: string): NodeJS.ProcessEnv {
  return { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" };
}

async function captureProbeConnectFrame(params: {
  url: string;
  env: NodeJS.ProcessEnv;
  auth?: { token?: string; password?: string };
  suppressStoredDeviceAuth?: boolean;
}): Promise<ConnectFrame> {
  const probePromise = probeGateway({
    url: params.url,
    auth: params.auth,
    suppressStoredDeviceAuth: params.suppressStoredDeviceAuth,
    env: params.env,
    timeoutMs: 2_000,
    includeDetails: false,
  });
  await vi.waitFor(() => expect(webSockets).toHaveLength(1));
  const socket = webSockets[0];
  if (!socket) {
    throw new Error("missing probe websocket");
  }
  socket.emitOpen();
  socket.emitMessage(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "probe-scope-nonce", ts: Date.now() },
    }),
  );
  await vi.waitFor(() => {
    expect(socket.sent.some((frame) => frame.includes('"method":"connect"'))).toBe(true);
  });
  const rawConnect = socket.sent.find((frame) => frame.includes('"method":"connect"'));
  if (!rawConnect) {
    throw new Error("missing probe connect frame");
  }
  const connect = JSON.parse(rawConnect) as ConnectFrame;
  socket.emitMessage(
    JSON.stringify({
      type: "res",
      id: connect.id,
      ok: true,
      payload: {
        type: "hello-ok",
        auth: { role: "operator", scopes: ["operator.read"] },
        server: { connId: "probe-scope-test", version: "test" },
      },
    }),
  );
  await probePromise;
  expect(socket.readyState).toBe(ProbeWebSocket.CLOSED);
  return connect;
}

beforeEach(() => {
  webSockets.length = 0;
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("probeGateway device auth scope", () => {
  it("does not serialize origin-A legacy or scoped tokens to remote origin B", async () => {
    await withTempDir("openclaw-probe-origin-scope-", async (stateDir) => {
      const env = createEnv(stateDir);
      const identity = loadOrCreateDeviceIdentity({ env });
      storeDeviceAuthToken({
        deviceId: identity.deviceId,
        role: "operator",
        token: "origin-a-legacy-token",
        env,
      });
      storeOriginDeviceToken({
        gatewayScope: gatewayOriginScope("wss://origin-a.example/rpc"),
        deviceId: identity.deviceId,
        role: "operator",
        token: "origin-a-scoped-token",
        env,
      });

      const connect = await captureProbeConnectFrame({
        url: "wss://origin-b.example/rpc",
        env,
      });

      expect(connect.params?.auth?.token).toBeUndefined();
      expect(connect.params?.auth?.deviceToken).toBeUndefined();
      expect(connect.params?.device).toBeUndefined();
    });
  });

  it("keeps legacy stored device auth available to local loopback probes", async () => {
    await withTempDir("openclaw-probe-local-scope-", async (stateDir) => {
      const env = createEnv(stateDir);
      const identity = loadOrCreateDeviceIdentity({ env });
      storeDeviceAuthToken({
        deviceId: identity.deviceId,
        role: "operator",
        token: "local-device-token",
        env,
      });

      const connect = await captureProbeConnectFrame({
        url: "ws://127.0.0.1:18789",
        env,
      });

      expect(connect.params?.auth).toMatchObject({
        token: "local-device-token",
        deviceToken: "local-device-token",
      });
      expect(connect.params?.device?.id).toBe(identity.deviceId);
    });
  });

  it("keeps explicit tokens authoritative for remote probes", async () => {
    await withTempDir("openclaw-probe-explicit-scope-", async (stateDir) => {
      const env = createEnv(stateDir);
      const identity = loadOrCreateDeviceIdentity({ env });
      storeDeviceAuthToken({
        deviceId: identity.deviceId,
        role: "operator",
        token: "legacy-device-token",
        env,
      });

      const connect = await captureProbeConnectFrame({
        url: "wss://origin-b.example/rpc",
        auth: { token: "explicit-remote-token" },
        env,
      });

      expect(connect.params?.auth?.token).toBe("explicit-remote-token");
      expect(connect.params?.auth?.deviceToken).toBeUndefined();
    });
  });

  it("does not reuse stored auth across SSH targets sharing a forwarded port", async () => {
    await withTempDir("openclaw-probe-ssh-scope-", async (stateDir) => {
      const env = createEnv(stateDir);
      const identity = loadOrCreateDeviceIdentity({ env });
      storeDeviceAuthToken({
        deviceId: identity.deviceId,
        role: "operator",
        token: "local-device-token",
        env,
      });
      storeOriginDeviceToken({
        gatewayScope: gatewayOriginScope("ws://127.0.0.1:18789"),
        deviceId: identity.deviceId,
        role: "operator",
        token: "prior-ssh-target-token",
        env,
      });

      const connect = await captureProbeConnectFrame({
        url: "ws://127.0.0.1:18789",
        suppressStoredDeviceAuth: true,
        env,
      });

      expect(connect.params?.auth?.token).toBeUndefined();
      expect(connect.params?.auth?.deviceToken).toBeUndefined();
      expect(connect.params?.device).toBeUndefined();
    });
  });

  it("keeps explicit auth available through SSH forwarded transports", async () => {
    await withTempDir("openclaw-probe-ssh-explicit-", async (stateDir) => {
      const env = createEnv(stateDir);
      const connect = await captureProbeConnectFrame({
        url: "ws://127.0.0.1:18789",
        auth: { token: "explicit-ssh-token" },
        suppressStoredDeviceAuth: true,
        env,
      });

      expect(connect.params?.auth?.token).toBe("explicit-ssh-token");
      expect(connect.params?.auth?.deviceToken).toBeUndefined();
    });
  });
});
