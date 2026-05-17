import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../protocol/client-info.js";
import { PROTOCOL_VERSION } from "../protocol/index.js";
import {
  GATEWAY_STARTUP_CLOSE_CODE,
  GATEWAY_STARTUP_CLOSE_REASON,
  GATEWAY_STARTUP_PENDING_CLOSE_CAUSE,
  GATEWAY_STARTUP_UNAVAILABLE_REASON,
} from "../protocol/startup-unavailable.js";
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
    const logWsControl = createLogger();

    attachGatewayWsConnectionHandler({
      wss,
      clients: new Set(),
      preauthConnectionBudget: { release: vi.fn() } as never,
      port: 19001,
      resolvedAuth: { mode: "none", allowTailscale: false },
      isStartupPending: () => true,
      gatewayMethods: [],
      events: [],
      refreshHealthSnapshot: vi.fn(async () => ({}) as never),
      logGateway: createLogger() as never,
      logHealth: createLogger() as never,
      logWsControl: logWsControl as never,
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

    const response = sent.find(
      (frame) =>
        typeof frame === "object" &&
        frame !== null &&
        (frame as { type?: unknown; id?: unknown }).type === "res" &&
        (frame as { id?: unknown }).id === "connect-1",
    ) as
      | {
          type?: unknown;
          id?: unknown;
          ok?: unknown;
          error?: {
            code?: unknown;
            retryable?: unknown;
            retryAfterMs?: unknown;
            details?: unknown;
          };
        }
      | undefined;
    expect(response?.type).toBe("res");
    expect(response?.id).toBe("connect-1");
    expect(response?.ok).toBe(false);
    expect(response?.error?.code).toBe("UNAVAILABLE");
    expect(response?.error?.retryable).toBe(true);
    expect(response?.error?.retryAfterMs).toBe(500);
    expect(response?.error?.details).toEqual({ reason: GATEWAY_STARTUP_UNAVAILABLE_REASON });
    await vi.waitFor(() => {
      expect(socket.close).toHaveBeenCalledWith(
        GATEWAY_STARTUP_CLOSE_CODE,
        GATEWAY_STARTUP_CLOSE_REASON,
      );
    });
    expect(logWsControl.debug).toHaveBeenCalledWith(
      expect.stringContaining("closed before connect"),
      expect.objectContaining({
        cause: GATEWAY_STARTUP_PENDING_CLOSE_CAUSE,
        handshake: "failed",
      }),
    );
    expect(logWsControl.debug).toHaveBeenCalledWith(
      expect.stringContaining(`code=${GATEWAY_STARTUP_CLOSE_CODE}`),
      expect.anything(),
    );
    expect(logWsControl.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("closed before connect"),
      expect.anything(),
    );
  });
});
