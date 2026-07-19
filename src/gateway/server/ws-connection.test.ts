// Gateway WebSocket connection tests cover handshake auth, shared sessions, and message-handler attachment.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGatewayAuth } from "../auth.js";
import { MAX_BUFFERED_BYTES } from "../server-constants.js";
import {
  attachGatewayWsForTest,
  createGatewayWsTestLogger,
  createGatewayWsTestRequestContext,
  createGatewayWsTestSocket,
  createResolvedGatewayTokenAuth,
  type GatewayWsTestSocket,
} from "./ws-connection.test-helpers.js";

const {
  attachGatewayWsMessageHandlerMock,
  attachWorkerWsMessageHandlerMock,
  broadcastPresenceSnapshotMock,
  upsertPresenceMock,
} = vi.hoisted(() => ({
  attachGatewayWsMessageHandlerMock: vi.fn(),
  attachWorkerWsMessageHandlerMock: vi.fn((_params: unknown) => vi.fn()),
  broadcastPresenceSnapshotMock: vi.fn(),
  upsertPresenceMock: vi.fn(),
}));

vi.mock("./ws-connection/message-handler.js", () => ({
  attachGatewayWsMessageHandler: attachGatewayWsMessageHandlerMock,
}));
vi.mock("./ws-connection/worker-connection.js", () => ({
  attachWorkerWsMessageHandler: attachWorkerWsMessageHandlerMock,
}));
vi.mock("../../infra/system-presence.js", () => ({
  upsertPresence: upsertPresenceMock,
}));
vi.mock("./presence-events.js", () => ({
  broadcastPresenceSnapshot: broadcastPresenceSnapshotMock,
}));

import { attachGatewayWsConnectionHandler } from "./ws-connection.js";
import { resolveSharedGatewaySessionGeneration } from "./ws-shared-generation.js";
import {
  GATEWAY_WS_CONNECTION_KIND_PROPERTY,
  GATEWAY_WS_PREAUTH_BUDGET_PROPERTY,
} from "./ws-types.js";

async function waitForLazyMessageHandler() {
  await vi.dynamicImportSettled();
}

function firstAttachedHandlerParams(): unknown {
  return attachGatewayWsMessageHandlerMock.mock.calls[0]?.[0];
}

function firstAttachedWorkerHandlerParams(): unknown {
  return attachWorkerWsMessageHandlerMock.mock.calls[0]?.[0];
}

async function connectTestWs(
  params: {
    host?: string;
    headers?: Record<string, string>;
    socket?: GatewayWsTestSocket;
    clients?: Set<unknown>;
    options?: Partial<Parameters<typeof attachGatewayWsConnectionHandler>[0]>;
  } = {},
) {
  const logWsControl = createGatewayWsTestLogger();
  const connected = attachGatewayWsForTest({
    attach: attachGatewayWsConnectionHandler,
    clients: params.clients,
    headers: params.headers,
    host: params.host,
    options: { ...params.options, logWsControl: logWsControl as never },
    socket: params.socket,
  });
  await waitForLazyMessageHandler();

  return {
    clients: connected.clients,
    logWsControl,
    socket: connected.socket,
    passed: firstAttachedHandlerParams(),
  };
}

describe("attachGatewayWsConnectionHandler", () => {
  beforeEach(() => {
    attachGatewayWsMessageHandlerMock.mockReset();
    attachWorkerWsMessageHandlerMock.mockClear();
    broadcastPresenceSnapshotMock.mockReset();
    upsertPresenceMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps worker sockets off the legacy challenge, plugin surface, and gateway budget", async () => {
    const socket = createGatewayWsTestSocket();
    const previous = {
      socket: { terminate: vi.fn() },
      worker: { environmentId: "worker-1" },
    };
    const clients = new Set<unknown>([previous]);
    const gatewayBudget = { release: vi.fn() };
    const workerBudget = { release: vi.fn() };
    const getPluginNodeCapabilities = vi.fn(() => [{ surface: "canvas" }]);
    const buildRequestContext = vi.fn(() => createGatewayWsTestRequestContext() as never);
    Object.assign(socket, {
      [GATEWAY_WS_CONNECTION_KIND_PROPERTY]: "worker",
      [GATEWAY_WS_PREAUTH_BUDGET_PROPERTY]: workerBudget,
      __openclawPreauthBudgetKey: "127.0.0.1",
    });

    await connectTestWs({
      clients,
      socket,
      options: {
        preauthConnectionBudget: gatewayBudget as never,
        getPluginNodeCapabilities,
        buildRequestContext,
      },
    });

    expect(socket.send).not.toHaveBeenCalled();
    expect(getPluginNodeCapabilities).not.toHaveBeenCalled();
    const handler = firstAttachedWorkerHandlerParams() as {
      setClient(client: never): boolean;
    };
    const client = {
      socket,
      connect: { client: { id: "openclaw-worker", mode: "worker" } },
      worker: { environmentId: "worker-1" },
    };
    expect(handler.setClient(client as never)).toBe(true);
    expect(previous).toMatchObject({ invalidated: true });
    expect(previous.socket.terminate).toHaveBeenCalledOnce();
    expect(clients).toEqual(new Set([client]));
    expect(attachGatewayWsMessageHandlerMock).not.toHaveBeenCalled();
    socket.emit("close", 1000, Buffer.alloc(0));
    expect(buildRequestContext).not.toHaveBeenCalled();
    expect(workerBudget.release).toHaveBeenCalledWith("127.0.0.1");
    expect(gatewayBudget.release).not.toHaveBeenCalled();
  });

  it("threads current auth getters into the handshake handler instead of a stale snapshot", async () => {
    const initialAuth = createResolvedGatewayTokenAuth("token-before");
    let currentAuth = initialAuth;

    const { passed } = await connectTestWs({
      options: {
        resolvedAuth: initialAuth,
        getResolvedAuth: () => currentAuth,
      },
    });

    expect(attachGatewayWsMessageHandlerMock).toHaveBeenCalledTimes(1);
    const handlerParams = passed as {
      getResolvedAuth: () => ResolvedGatewayAuth;
      getRequiredSharedGatewaySessionGeneration?: () => string | undefined;
    };

    currentAuth = createResolvedGatewayTokenAuth("token-after");

    expect(handlerParams.getResolvedAuth().token).toBe("token-after");
    expect(handlerParams.getRequiredSharedGatewaySessionGeneration?.()).toBe(
      resolveSharedGatewaySessionGeneration(currentAuth),
    );
  });

  it("threads generic plugin surface URLs into the handshake handler", async () => {
    const { passed } = await connectTestWs({
      host: "gateway.example.com",
      options: {
        port: 18789,
        pluginSurfaceScheme: "https",
        getPluginNodeCapabilities: () => [{ surface: "canvas", ttlMs: 1234 }],
      },
    });

    const handlerParams = passed as {
      pluginSurfaceBaseUrl?: string;
      pluginNodeCapabilities?: Array<{ surface: string; ttlMs?: number }>;
    };
    expect(handlerParams.pluginSurfaceBaseUrl).toBe("https://gateway.example.com:443");
    expect(handlerParams.pluginNodeCapabilities).toEqual([{ surface: "canvas", ttlMs: 1234 }]);
  });

  it("prefers forwarded host over bind host for generic plugin surface URLs", async () => {
    const { passed } = await connectTestWs({
      host: "10.0.0.2:18789",
      headers: {
        "x-forwarded-host": "gateway.example.com",
        "x-forwarded-proto": "https",
      },
      options: {
        gatewayHost: "10.0.0.2",
        port: 18789,
        pluginSurfaceScheme: "http",
        getPluginNodeCapabilities: () => [{ surface: "canvas" }],
      },
    });

    const handlerParams = passed as {
      pluginSurfaceBaseUrl?: string;
    };
    expect(handlerParams.pluginSurfaceBaseUrl).toBe("https://gateway.example.com:443");
  });

  it("rejects late client registration after a pre-connect socket close", async () => {
    const clients = new Set();
    const { passed, socket } = await connectTestWs({ clients });
    const handlerParams = passed as {
      setClient: (client: unknown) => boolean;
    };
    socket.emit("close", 1001, Buffer.from("client left"));

    const registered = handlerParams.setClient({
      socket,
      connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
      connId: "late-client",
      usesSharedGatewayAuth: false,
    });

    expect(registered).toBe(false);
    expect(clients.size).toBe(0);
  });

  it("continues protocol pings after pong and stops when the connection closes", async () => {
    vi.useFakeTimers();
    const socket = Object.assign(createGatewayWsTestSocket({ ping: true }), {
      terminate: vi.fn(),
    });
    const { passed } = await connectTestWs({ socket });
    const handlerParams = passed as {
      setClient: (client: unknown) => boolean;
    };
    expect(
      handlerParams.setClient({
        socket,
        connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
        connId: "ping-client",
        usesSharedGatewayAuth: false,
      }),
    ).toBe(true);

    vi.advanceTimersByTime(25_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    socket.emit("pong");

    vi.advanceTimersByTime(25_000);
    expect(socket.ping).toHaveBeenCalledTimes(2);
    expect(socket.terminate).not.toHaveBeenCalled();

    socket.emit("close", 1000, Buffer.from("done"));
    vi.advanceTimersByTime(25_000);
    expect(socket.ping).toHaveBeenCalledTimes(2);
  });

  it("terminates a connection after one missed protocol pong", async () => {
    vi.useFakeTimers();
    const unregister = vi.fn();
    const clients = new Set<unknown>();
    const socket = Object.assign(createGatewayWsTestSocket({ ping: true }), {
      terminate: vi.fn(),
    });
    socket.terminate.mockImplementation(() => {
      socket.emit("close", 1006, Buffer.from("heartbeat timeout"));
    });
    const { passed } = await connectTestWs({
      clients,
      socket,
      options: {
        buildRequestContext: () =>
          createGatewayWsTestRequestContext({ nodeRegistry: { unregister } }) as never,
      },
    });
    const handlerParams = passed as {
      setClient: (client: unknown) => boolean;
    };
    expect(
      handlerParams.setClient({
        socket,
        connect: {
          role: "node",
          client: { id: "stale-node", mode: "node" },
        },
        connId: "stale-node-conn",
        usesSharedGatewayAuth: false,
      }),
    ).toBe(true);
    expect(clients.size).toBe(1);

    vi.advanceTimersByTime(25_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(socket.terminate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(25_000);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(clients.size).toBe(0);

    vi.advanceTimersByTime(25_000);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });

  it("closes slow consumers before writing direct response frames", async () => {
    const socket = createGatewayWsTestSocket();
    const { passed } = await connectTestWs({ socket });
    const handlerParams = passed as {
      send: (frame: unknown) => void;
    };
    socket.send.mockClear();
    socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;

    handlerParams.send({ type: "res", id: "req-slow", ok: true, payload: { ok: true } });

    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1008, "slow consumer");
  });

  it("keeps handshake phase advancement monotonic", async () => {
    const { socket, logWsControl, passed } = await connectTestWs();
    const handlerParams = passed as {
      advanceHandshakePhase: (phase: string) => void;
    };

    handlerParams.advanceHandshakePhase("auth_credentials_received");
    handlerParams.advanceHandshakePhase("auth_validated");
    handlerParams.advanceHandshakePhase("auth_credentials_received");
    socket.emit("close", 1006, Buffer.from("client disappeared"));

    const [message, context] = logWsControl.warn.mock.calls[0] as [string, { phase?: string }];
    expect(message).toContain("phase=auth_validated");
    expect(context).toMatchObject({ phase: "auth_validated" });
  });

  it("includes the last completed handshake phase in pre-connect close logs", async () => {
    const { socket, logWsControl } = await connectTestWs();

    socket.emit("close", 1006, Buffer.from("client disappeared"));

    expect(logWsControl.warn).toHaveBeenCalled();
    const [message, context] = logWsControl.warn.mock.calls[0] as [string, { phase?: string }];
    expect(message).toContain("closed before connect");
    expect(message).toContain("phase=ws_upgrade_started");
    expect(context).toMatchObject({ phase: "ws_upgrade_started" });
  });

  it.each([1001, 1006])(
    "demotes local app startup abort code %i before the first frame",
    async (closeCode) => {
      const { socket, logWsControl } = await connectTestWs({
        headers: { "user-agent": "OpenClaw/2607000290 CFNetwork/3860 Darwin/25" },
        options: { isStartupPending: () => true },
      });

      socket.emit("close", closeCode, Buffer.alloc(0));

      expect(logWsControl.debug).toHaveBeenCalledWith(
        expect.stringContaining("closed before connect"),
        expect.objectContaining({ phase: "ws_upgrade_started" }),
      );
      expect(logWsControl.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("closed before connect"),
        expect.anything(),
      );
    },
  );

  it("keeps queued local app startup frames at warning level", async () => {
    const logWsControl = createGatewayWsTestLogger();
    const { socket } = attachGatewayWsForTest({
      attach: attachGatewayWsConnectionHandler,
      headers: { "user-agent": "OpenClaw/2607000290 CFNetwork/3860 Darwin/25" },
      options: { isStartupPending: () => true, logWsControl: logWsControl as never },
    });

    socket.emit("message", Buffer.from('{"type":"req","id":"queued"}'));
    socket.emit("close", 1006, Buffer.alloc(0));
    await waitForLazyMessageHandler();

    expect(logWsControl.warn).toHaveBeenCalledWith(
      expect.stringContaining("closed before connect"),
      expect.objectContaining({ phase: "ws_upgrade_started" }),
    );
    expect(logWsControl.debug).not.toHaveBeenCalledWith(
      expect.stringContaining("closed before connect"),
      expect.anything(),
    );
  });

  it("includes the last completed handshake phase on preauth timeout logs", async () => {
    vi.useFakeTimers();
    const { logWsControl } = await connectTestWs({
      options: { preauthHandshakeTimeoutMs: 100 },
    });

    vi.advanceTimersByTime(150);

    expect(logWsControl.warn).toHaveBeenCalledWith(expect.stringContaining("handshake timeout"));
    expect(logWsControl.warn).toHaveBeenCalledWith(
      expect.stringContaining("phase=ws_upgrade_started"),
    );
  });

  it("omits handshake phase metadata after the connection is ready", async () => {
    const { socket, logWsControl, passed } = await connectTestWs();
    const handlerParams = passed as {
      advanceHandshakePhase: (phase: string) => void;
      setClient: (client: never) => boolean;
      setHandshakeState: (state: "pending" | "connected" | "failed") => void;
    };

    handlerParams.advanceHandshakePhase("auth_credentials_received");
    handlerParams.advanceHandshakePhase("auth_validated");
    expect(
      handlerParams.setClient({
        socket,
        connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
        connId: "ready-client",
        usesSharedGatewayAuth: false,
      } as never),
    ).toBe(true);
    handlerParams.setHandshakeState("connected");
    handlerParams.advanceHandshakePhase("session_attached");
    handlerParams.advanceHandshakePhase("hello_payload_prepared");
    handlerParams.advanceHandshakePhase("ready");

    socket.emit("close", 1000, Buffer.from("done"));

    expect(logWsControl.warn).not.toHaveBeenCalled();
  });

  it("logs the authenticated user when a connection closes", async () => {
    const { socket, logWsControl, passed } = await connectTestWs();
    const handlerParams = passed as {
      setClient: (client: never) => boolean;
    };

    expect(
      handlerParams.setClient({
        socket,
        connect: { client: { id: "openclaw-control-ui", mode: "ui" } },
        connId: "conn-authenticated-user",
        authenticatedUserId: "alice@example.com",
        usesSharedGatewayAuth: false,
      } as never),
    ).toBe(true);

    socket.emit("close", 1000, Buffer.from("done"));

    expect(logWsControl.info).toHaveBeenCalledWith(
      expect.stringMatching(
        /^authenticated user disconnected code=1000 reason=done conn=.+ user=alice@example\.com$/,
      ),
    );
  });

  it("skips node presence disconnects for stale reconnected sockets", async () => {
    const unregister = vi.fn(() => null);
    const { socket } = attachGatewayWsForTest({
      attach: attachGatewayWsConnectionHandler,
      options: {
        refreshHealthSnapshot: vi.fn(),
        buildRequestContext: () =>
          createGatewayWsTestRequestContext({ nodeRegistry: { unregister } }) as never,
      },
    });
    await waitForLazyMessageHandler();

    const passed = firstAttachedHandlerParams() as {
      setClient: (client: unknown) => boolean;
    };
    expect(
      passed.setClient({
        socket,
        connect: {
          role: "node",
          client: { id: "openclaw-macos", mode: "node" },
          device: { id: "node-1" },
        },
        connId: "conn-old",
        presenceKey: "node-1",
        usesSharedGatewayAuth: false,
      }),
    ).toBe(true);

    socket.emit("close", 1000, Buffer.from("stale"));

    expect(unregister).toHaveBeenCalledTimes(1);
    expect(upsertPresenceMock).not.toHaveBeenCalled();
    expect(broadcastPresenceSnapshotMock).not.toHaveBeenCalled();
  });
});
