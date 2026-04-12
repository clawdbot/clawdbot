import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("attachGatewayWsConnectionHandler", () => {
  beforeEach(() => {
    attachGatewayWsMessageHandlerMock.mockReset();
  });

  it("threads current auth getters into the handshake handler instead of a stale snapshot", () => {
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
});
