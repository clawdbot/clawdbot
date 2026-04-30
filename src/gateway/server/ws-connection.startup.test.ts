import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../protocol/client-info.js";
import { PROTOCOL_VERSION } from "../protocol/index.js";
import { GATEWAY_STARTUP_UNAVAILABLE_REASON } from "../protocol/startup-unavailable.js";
import { attachGatewayWsConnectionHandler } from "./ws-connection.js";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createRequestContext() {
  return {
    unsubscribeAllSessionEvents: vi.fn(),
    nodeRegistry: { unregister: vi.fn() },
    nodeUnsubscribeAll: vi.fn(),
  };
}

describe("attachGatewayWsConnectionHandler startup readiness", () => {
  it("returns a retryable startup-unavailable connect response while sidecars are pending", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const wss = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners.set(event, handler);
      }),
    } as unknown as WebSocketServer;
    const sent: unknown[] = [];
    const socket = Object.assign(new EventEmitter(), {
      _socket: {
        remoteAddress: "127.0.0.1",
        remotePort: 1234,
        localAddress: "127.0.0.1",
        localPort: 5678,
      },
      send: vi.fn((data: string, cb?: (err?: Error) => void) => {
        sent.push(JSON.parse(data));
        cb?.();
      }),
      close: vi.fn((code?: number, reason?: string) => {
        socket.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
      }),
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
      resolvedAuth: { mode: "none", allowTailscale: false },
      isStartupPending: () => true,
      gatewayMethods: [],
      events: [],
      refreshHealthSnapshot: vi.fn(async () => ({}) as never),
      logGateway: createLogger() as never,
      logHealth: createLogger() as never,
      logWsControl: createLogger() as never,
      extraHandlers: {},
      broadcast: vi.fn(),
      buildRequestContext: () => createRequestContext() as never,
    });

    const onConnection = listeners.get("connection");
    expect(onConnection).toBeTypeOf("function");
    onConnection?.(socket, upgradeReq);
    socket.emit(
      "message",
      JSON.stringify({
        type: "req",
        id: "connect-1",
        method: "connect",
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: GATEWAY_CLIENT_NAMES.CLI,
            version: "dev",
            platform: "test",
            mode: GATEWAY_CLIENT_MODES.CLI,
          },
          role: "operator",
          scopes: ["operator.read"],
          caps: [],
        },
      }),
    );

    await vi.waitFor(() => {
      expect(
        sent.some(
          (frame) =>
            typeof frame === "object" &&
            frame !== null &&
            (frame as { type?: unknown; id?: unknown; ok?: unknown }).type === "res" &&
            (frame as { id?: unknown }).id === "connect-1",
        ),
      ).toBe(true);
    });

    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "res",
        id: "connect-1",
        ok: false,
        error: expect.objectContaining({
          code: "UNAVAILABLE",
          retryable: true,
          retryAfterMs: 500,
          details: { reason: GATEWAY_STARTUP_UNAVAILABLE_REASON },
        }),
      }),
    );
    await vi.waitFor(() => {
      expect(socket.close).toHaveBeenCalledWith(1013, "gateway starting");
    });
  });
});
