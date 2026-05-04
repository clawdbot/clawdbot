import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";
import type { ResolvedGatewayAuth } from "../auth.js";

const { attachGatewayWsMessageHandlerMock } = vi.hoisted(() => ({
  attachGatewayWsMessageHandlerMock: vi.fn(),
}));

vi.mock("./ws-connection/message-handler.js", () => ({
  attachGatewayWsMessageHandler: attachGatewayWsMessageHandlerMock,
}));

import { attachGatewayWsConnectionHandler } from "./ws-connection.js";
import { resolveSharedGatewaySessionGeneration } from "./ws-shared-generation.js";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createResolvedAuth(token: string): ResolvedGatewayAuth {
  return {
    mode: "token",
    allowTailscale: false,
    token,
  };
}

async function waitForLazyMessageHandler() {
  await vi.dynamicImportSettled();
}

describe("attachGatewayWsConnectionHandler", () => {
  beforeEach(() => {
    attachGatewayWsMessageHandlerMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("threads current auth getters into the handshake handler instead of a stale snapshot", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const wss = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners.set(event, handler);
      }),
    } as unknown as WebSocketServer;
    const socket = Object.assign(new EventEmitter(), {
      _socket: {
        remoteAddress: "127.0.0.1",
        remotePort: 1234,
        localAddress: "127.0.0.1",
        localPort: 5678,
      },
      send: vi.fn(),
      close: vi.fn(),
    });
    const upgradeReq = {
      headers: { host: "127.0.0.1:19001" },
      socket: { localAddress: "127.0.0.1" },
    };
    const initialAuth = createResolvedAuth("token-before");
    let currentAuth = initialAuth;

    attachGatewayWsConnectionHandler({
      wss,
      clients: new Set(),
      preauthConnectionBudget: { release: vi.fn() } as never,
      port: 19001,
      canvasHostEnabled: false,
      resolvedAuth: initialAuth,
      getResolvedAuth: () => currentAuth,
      gatewayMethods: [],
      events: [],
      refreshHealthSnapshot: vi.fn(async () => ({}) as never),
      logGateway: createLogger() as never,
      logHealth: createLogger() as never,
      logWsControl: createLogger() as never,
      extraHandlers: {},
      broadcast: vi.fn(),
      buildRequestContext: () =>
        ({
          unsubscribeAllSessionEvents: vi.fn(),
          nodeRegistry: { unregister: vi.fn() },
          nodeUnsubscribeAll: vi.fn(),
        }) as never,
    });

    const onConnection = listeners.get("connection");
    expect(onConnection).toBeTypeOf("function");
    onConnection?.(socket, upgradeReq);
    await waitForLazyMessageHandler();

    expect(attachGatewayWsMessageHandlerMock).toHaveBeenCalledTimes(1);
    const passed = attachGatewayWsMessageHandlerMock.mock.calls[0]?.[0] as {
      getResolvedAuth: () => ResolvedGatewayAuth;
      getRequiredSharedGatewaySessionGeneration?: () => string | undefined;
    };

    currentAuth = createResolvedAuth("token-after");

    expect(passed.getResolvedAuth()).toMatchObject({ token: "token-after" });
    expect(passed.getRequiredSharedGatewaySessionGeneration?.()).toBe(
      resolveSharedGatewaySessionGeneration(currentAuth),
    );
  });

  it("uses the gateway TLS scheme for canvas host URLs", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const wss = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners.set(event, handler);
      }),
    } as unknown as WebSocketServer;
    const socket = Object.assign(new EventEmitter(), {
      _socket: {
        remoteAddress: "127.0.0.1",
        remotePort: 1234,
        localAddress: "127.0.0.1",
        localPort: 5678,
      },
      send: vi.fn(),
      close: vi.fn(),
    });
    const upgradeReq = {
      headers: { host: "gateway.example.com" },
      socket: { localAddress: "127.0.0.1" },
    };

    attachGatewayWsConnectionHandler({
      wss,
      clients: new Set(),
      preauthConnectionBudget: { release: vi.fn() } as never,
      port: 18789,
      canvasHostEnabled: true,
      canvasHostScheme: "https",
      resolvedAuth: createResolvedAuth("token"),
      gatewayMethods: [],
      events: [],
      refreshHealthSnapshot: vi.fn(async () => ({}) as never),
      logGateway: createLogger() as never,
      logHealth: createLogger() as never,
      logWsControl: createLogger() as never,
      extraHandlers: {},
      broadcast: vi.fn(),
      buildRequestContext: () =>
        ({
          unsubscribeAllSessionEvents: vi.fn(),
          nodeRegistry: { unregister: vi.fn() },
          nodeUnsubscribeAll: vi.fn(),
        }) as never,
    });

    const onConnection = listeners.get("connection");
    expect(onConnection).toBeTypeOf("function");
    onConnection?.(socket, upgradeReq);
    await waitForLazyMessageHandler();

    const passed = attachGatewayWsMessageHandlerMock.mock.calls[0]?.[0] as {
      canvasHostUrl?: string;
    };
    expect(passed.canvasHostUrl).toBe("https://gateway.example.com:443");
  });

  it("rejects late client registration after a pre-connect socket close", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const wss = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners.set(event, handler);
      }),
    } as unknown as WebSocketServer;
    const socket = Object.assign(new EventEmitter(), {
      _socket: {
        remoteAddress: "127.0.0.1",
        remotePort: 1234,
        localAddress: "127.0.0.1",
        localPort: 5678,
      },
      send: vi.fn(),
      close: vi.fn(),
    });
    const upgradeReq = {
      headers: { host: "127.0.0.1:19001" },
      socket: { localAddress: "127.0.0.1" },
    };
    const clients = new Set();

    attachGatewayWsConnectionHandler({
      wss,
      clients: clients as never,
      preauthConnectionBudget: { release: vi.fn() } as never,
      port: 19001,
      canvasHostEnabled: false,
      resolvedAuth: createResolvedAuth("token"),
      preauthHandshakeTimeoutMs: 60_000,
      gatewayMethods: [],
      events: [],
      refreshHealthSnapshot: vi.fn(),
      logGateway: createLogger() as never,
      logHealth: createLogger() as never,
      logWsControl: createLogger() as never,
      extraHandlers: {},
      broadcast: vi.fn(),
      buildRequestContext: () =>
        ({
          unsubscribeAllSessionEvents: vi.fn(),
          nodeRegistry: { unregister: vi.fn() },
          nodeUnsubscribeAll: vi.fn(),
        }) as never,
    });

    const onConnection = listeners.get("connection");
    expect(onConnection).toBeTypeOf("function");
    onConnection?.(socket, upgradeReq);
    await waitForLazyMessageHandler();

    const passed = attachGatewayWsMessageHandlerMock.mock.calls[0]?.[0] as {
      setClient: (client: unknown) => boolean;
    };
    socket.emit("close", 1001, Buffer.from("client left"));

    const registered = passed.setClient({
      socket,
      connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
      connId: "late-client",
      usesSharedGatewayAuth: false,
    });

    expect(registered).toBe(false);
    expect(clients.size).toBe(0);
  });

  it("sends protocol pings until the connection closes", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const wss = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners.set(event, handler);
      }),
    } as unknown as WebSocketServer;
    const socket = Object.assign(new EventEmitter(), {
      _socket: {
        remoteAddress: "127.0.0.1",
        remotePort: 1234,
        localAddress: "127.0.0.1",
        localPort: 5678,
      },
      send: vi.fn(),
      ping: vi.fn(),
      close: vi.fn(),
    });
    const upgradeReq = {
      headers: { host: "127.0.0.1:19001" },
      socket: { localAddress: "127.0.0.1" },
    };

    attachGatewayWsConnectionHandler({
      wss,
      clients: new Set(),
      preauthConnectionBudget: { release: vi.fn() } as never,
      port: 19001,
      canvasHostEnabled: false,
      resolvedAuth: createResolvedAuth("token"),
      preauthHandshakeTimeoutMs: 60_000,
      gatewayMethods: [],
      events: [],
      refreshHealthSnapshot: vi.fn(),
      logGateway: createLogger() as never,
      logHealth: createLogger() as never,
      logWsControl: createLogger() as never,
      extraHandlers: {},
      broadcast: vi.fn(),
      buildRequestContext: () =>
        ({
          unsubscribeAllSessionEvents: vi.fn(),
          nodeRegistry: { unregister: vi.fn() },
          nodeUnsubscribeAll: vi.fn(),
        }) as never,
    });

    const onConnection = listeners.get("connection");
    expect(onConnection).toBeTypeOf("function");
    onConnection?.(socket, upgradeReq);
    await waitForLazyMessageHandler();

    const passed = attachGatewayWsMessageHandlerMock.mock.calls[0]?.[0] as {
      setClient: (client: unknown) => boolean;
    };
    expect(
      passed.setClient({
        socket,
        connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
        connId: "ping-client",
        usesSharedGatewayAuth: false,
      }),
    ).toBe(true);

    vi.advanceTimersByTime(25_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);

    socket.emit("close", 1000, Buffer.from("done"));
    vi.advanceTimersByTime(25_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);
  });
});
