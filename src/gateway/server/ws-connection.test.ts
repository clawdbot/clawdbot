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
  cleanupTalkConnectionMock,
  recordPairedNodeDisconnectionMock,
  touchPresenceMock,
  upsertPresenceMock,
} = vi.hoisted(() => ({
  attachGatewayWsMessageHandlerMock: vi.fn(),
  attachWorkerWsMessageHandlerMock: vi.fn((_params: unknown) => vi.fn()),
  broadcastPresenceSnapshotMock: vi.fn(),
  cleanupTalkConnectionMock: vi.fn(),
  recordPairedNodeDisconnectionMock: vi.fn(async () => ({ recorded: true })),
  touchPresenceMock: vi.fn(),
  upsertPresenceMock: vi.fn(),
}));

vi.mock("./ws-connection/message-handler.js", () => ({
  attachGatewayWsMessageHandler: attachGatewayWsMessageHandlerMock,
}));
vi.mock("./ws-connection/worker-connection.js", () => ({
  attachWorkerWsMessageHandler: attachWorkerWsMessageHandlerMock,
}));
vi.mock("../../infra/device-pairing-node.js", () => ({
  recordPairedNodeDisconnection: recordPairedNodeDisconnectionMock,
}));
vi.mock("../../infra/system-presence.js", () => ({
  touchPresence: touchPresenceMock,
  upsertPresence: upsertPresenceMock,
}));
vi.mock("./presence-events.js", () => ({
  broadcastPresenceSnapshot: broadcastPresenceSnapshotMock,
}));
vi.mock("../talk-session-registry.js", () => ({
  cleanupTalkConnection: cleanupTalkConnectionMock,
}));

import { markPublicWorkerIngress } from "./public-worker-ingress-context.js";
import { attachGatewayWsConnectionHandler } from "./ws-connection.js";
import { resolveSharedGatewaySessionGeneration } from "./ws-shared-generation.js";
import { GATEWAY_WS_CONNECTION_KIND_PROPERTY } from "./ws-types.js";

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
    trustedProxies?: string[];
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
    trustedProxies: params.trustedProxies,
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
    cleanupTalkConnectionMock.mockReset();
    recordPairedNodeDisconnectionMock.mockReset();
    recordPairedNodeDisconnectionMock.mockResolvedValue({ recorded: true });
    touchPresenceMock.mockReset();
    upsertPresenceMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps public worker sockets off the legacy challenge and plugin surface", async () => {
    const socket = createGatewayWsTestSocket();
    const previous = {
      socket: { terminate: vi.fn() },
      worker: { environmentId: "worker-1" },
    };
    const clients = new Set<unknown>([previous]);
    const gatewayBudget = { release: vi.fn() };
    const rateLimiter = { check: vi.fn() };
    const getPluginNodeCapabilities = vi.fn(() => [{ surface: "canvas" }]);
    const buildRequestContext = vi.fn(() => createGatewayWsTestRequestContext() as never);
    Object.assign(socket, {
      [GATEWAY_WS_CONNECTION_KIND_PROPERTY]: "worker",
      __openclawPreauthBudgetKey: "203.0.113.10",
    });
    markPublicWorkerIngress(socket as never, {
      clientIp: "203.0.113.10",
      rateLimiter: rateLimiter as never,
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
      publicAdmission: { clientIp: string; rateLimiter: unknown };
      setClient(client: never): boolean;
    };
    expect(handler).toMatchObject({
      publicAdmission: { clientIp: "203.0.113.10", rateLimiter },
    });
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
    expect(gatewayBudget.release).toHaveBeenCalledWith("203.0.113.10");
  });

  it("threads current auth getters into the handshake handler instead of a stale snapshot", async () => {
    const initialAuth = createResolvedGatewayTokenAuth("token-before");
    let currentAuth = initialAuth;

    const { passed } = await connectTestWs({
      options: {
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
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-host": "gateway.example.com",
        "x-forwarded-proto": "https",
      },
      trustedProxies: ["127.0.0.1"],
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

  it("allows only one authenticated client registration per socket", async () => {
    vi.useFakeTimers();
    const clients = new Set();
    const socket = createGatewayWsTestSocket({ ping: true });
    const { passed } = await connectTestWs({ clients, socket });
    const handlerParams = passed as {
      setClient: (client: unknown) => boolean;
    };
    const firstClient = {
      socket,
      connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
      connId: "first-client",
      usesSharedGatewayAuth: false,
    };
    const racedClient = {
      ...firstClient,
      connId: "raced-client",
    };

    expect(handlerParams.setClient(firstClient)).toBe(true);
    expect(handlerParams.setClient(racedClient)).toBe(false);
    expect(clients).toEqual(new Set([firstClient]));

    vi.advanceTimersByTime(25_000);
    expect(socket.ping).toHaveBeenCalledOnce();

    socket.emit("close", 1000, Buffer.from("done"));
    expect(clients.size).toBe(0);
    vi.advanceTimersByTime(25_000);
    expect(socket.ping).toHaveBeenCalledOnce();
  });

  it("runs connection-owned Talk cleanup when a gateway connection closes", async () => {
    const { passed, socket } = await connectTestWs();
    const handlerParams = passed as {
      connId: string;
      setClient: (client: unknown) => boolean;
    };
    expect(
      handlerParams.setClient({
        socket,
        connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
        connId: handlerParams.connId,
        usesSharedGatewayAuth: false,
      }),
    ).toBe(true);

    socket.emit("close", 1000, Buffer.from("done"));

    expect(cleanupTalkConnectionMock).toHaveBeenCalledOnce();
    expect(cleanupTalkConnectionMock).toHaveBeenCalledWith(
      handlerParams.connId,
      expect.objectContaining({ warn: expect.any(Function) }),
    );
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
        presenceKey: "ping-client",
        usesSharedGatewayAuth: false,
      }),
    ).toBe(true);

    vi.advanceTimersByTime(25_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(touchPresenceMock).not.toHaveBeenCalled();
    socket.emit("pong");
    expect(touchPresenceMock).toHaveBeenCalledWith("ping-client");

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
    const get = vi.fn(() => undefined);
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
          createGatewayWsTestRequestContext({
            nodeRegistry: { get, unregister } as never,
          }) as never,
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
      send: (frame: unknown) => { kind: string };
    };
    socket.send.mockClear();
    socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;

    expect(
      handlerParams.send({ type: "res", id: "req-slow", ok: true, payload: { ok: true } }),
    ).toEqual({ kind: "unavailable" });

    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1008, "slow consumer");
  });

  it("distinguishes serialization failure from unavailable transports", async () => {
    const socket = createGatewayWsTestSocket();
    const { passed } = await connectTestWs({ socket });
    const handlerParams = passed as {
      send: (frame: unknown) => { kind: string; error?: unknown };
    };
    socket.send.mockClear();

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(handlerParams.send(cyclic)).toMatchObject({
      kind: "serialization",
      error: expect.any(TypeError),
    });
    expect(socket.send).not.toHaveBeenCalled();

    socket.send.mockImplementationOnce(() => {
      throw new Error("socket unavailable");
    });
    expect(handlerParams.send({ type: "event", event: "tick" })).toEqual({
      kind: "unavailable",
    });

    socket.emit("close", 1000, Buffer.from("done"));
    expect(handlerParams.send({ type: "event", event: "tick" })).toEqual({
      kind: "unavailable",
    });
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

  it("records disconnect history for the current node connection", async () => {
    const unregister = vi.fn(() => "node-1");
    const get = vi.fn();
    const { socket, passed } = await connectTestWs({
      options: {
        refreshHealthSnapshot: vi.fn(),
        buildRequestContext: () =>
          createGatewayWsTestRequestContext({
            nodeRegistry: { get, unregister } as never,
          }) as never,
      },
    });
    const handler = passed as {
      connId: string;
      setClient: (client: unknown) => boolean;
    };
    get.mockReturnValue({
      nodeId: "node-1",
      connId: handler.connId,
      connectedAtMs: 1_000,
      pairingGeneration: "generation-1",
    });
    expect(
      handler.setClient({
        socket,
        connect: {
          role: "node",
          client: { id: "openclaw-macos", mode: "node" },
          device: { id: "node-1" },
        },
        connId: handler.connId,
        presenceKey: "node-1",
        usesSharedGatewayAuth: false,
      }),
    ).toBe(true);

    socket.emit("close", 1000, Buffer.from("done"));

    await vi.waitFor(() => expect(unregister).toHaveBeenCalledOnce());
    expect(get).toHaveBeenCalledWith("node-1");
    await vi.waitFor(() => expect(recordPairedNodeDisconnectionMock).toHaveBeenCalledOnce());
    expect(recordPairedNodeDisconnectionMock).toHaveBeenCalledWith({
      nodeId: "node-1",
      connectedAtMs: 1_000,
      disconnectedAtMs: expect.any(Number),
      expectedPairingGeneration: { nodeId: "node-1", key: "generation-1" },
    });
  });

  it("skips node presence disconnects for stale reconnected sockets", async () => {
    const unregister = vi.fn(() => null);
    const get = vi.fn(() => undefined);
    const { socket, passed } = await connectTestWs({
      options: {
        refreshHealthSnapshot: vi.fn(),
        buildRequestContext: () =>
          createGatewayWsTestRequestContext({
            nodeRegistry: { get, unregister } as never,
          }) as never,
      },
    });
    const handler = passed as {
      setClient: (client: unknown) => boolean;
    };
    expect(
      handler.setClient({
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

    await vi.waitFor(() => expect(unregister).toHaveBeenCalledTimes(1));
    expect(recordPairedNodeDisconnectionMock).not.toHaveBeenCalled();
    expect(upsertPresenceMock).not.toHaveBeenCalled();
    expect(broadcastPresenceSnapshotMock).not.toHaveBeenCalled();
  });
});
