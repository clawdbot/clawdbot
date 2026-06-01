import { EventEmitter } from "node:events";
import { expect, vi } from "vitest";
import type { WebSocketServer } from "ws";
import type { ResolvedGatewayAuth } from "../auth.js";
import type { attachGatewayWsConnectionHandler } from "./ws-connection.js";

type AttachGatewayWsConnectionParams = Parameters<typeof attachGatewayWsConnectionHandler>[0];

export type GatewayWsTestSocket = EventEmitter & {
  _socket: {
    remoteAddress: string;
    remotePort: number;
    localAddress: string;
    localPort: number;
  };
  send: ReturnType<typeof vi.fn>;
  ping?: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

export function createGatewayWsTestLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

export function createResolvedGatewayTokenAuth(token: string): ResolvedGatewayAuth {
  return {
    mode: "token",
    allowTailscale: false,
    token,
  };
}

export function createGatewayWsTestRequestContext(
  overrides: {
    nodeRegistry?: { unregister: ReturnType<typeof vi.fn> };
  } = {},
) {
  return {
    unsubscribeAllSessionEvents: vi.fn(),
    nodeRegistry: overrides.nodeRegistry ?? { unregister: vi.fn() },
    nodeUnsubscribeAll: vi.fn(),
  };
}

export function createGatewayWsTestSocket(
  params: {
    closeEmits?: boolean;
    onSend?: (data: string) => void;
    ping?: boolean;
  } = {},
): GatewayWsTestSocket {
  const socket = Object.assign(new EventEmitter(), {
    _socket: {
      remoteAddress: "127.0.0.1",
      remotePort: 1234,
      localAddress: "127.0.0.1",
      localPort: 5678,
    },
    send: vi.fn((data: string, cb?: (err?: Error) => void) => {
      params.onSend?.(data);
      cb?.();
    }),
    ...(params.ping ? { ping: vi.fn() } : {}),
    close: vi.fn((code?: number, reason?: string) => {
      if (params.closeEmits) {
        socket.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
      }
    }),
  });
  return socket;
}

export function attachGatewayWsForTest(params: {
  attach: typeof attachGatewayWsConnectionHandler;
  clients?: Set<unknown>;
  headers?: Record<string, string>;
  host?: string;
  options?: Partial<AttachGatewayWsConnectionParams>;
  socket?: GatewayWsTestSocket;
}) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const wss = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(event, handler);
    }),
  } as unknown as WebSocketServer;
  const socket = params.socket ?? createGatewayWsTestSocket();
  const upgradeReq = {
    headers: { host: params.host ?? "127.0.0.1:19001", ...params.headers },
    socket: { localAddress: "127.0.0.1" },
  };
  const clients = params.clients ?? new Set<unknown>();

  params.attach({
    wss,
    clients: clients as never,
    preauthConnectionBudget: { release: vi.fn() } as never,
    port: 19001,
    resolvedAuth: createResolvedGatewayTokenAuth("token"),
    preauthHandshakeTimeoutMs: 60_000,
    gatewayMethods: [],
    events: [],
    refreshHealthSnapshot: vi.fn(async () => ({}) as never),
    logGateway: createGatewayWsTestLogger() as never,
    logHealth: createGatewayWsTestLogger() as never,
    logWsControl: createGatewayWsTestLogger() as never,
    extraHandlers: {},
    broadcast: vi.fn(),
    buildRequestContext: () => createGatewayWsTestRequestContext() as never,
    ...params.options,
  });

  const onConnection = listeners.get("connection");
  expect(onConnection).toBeTypeOf("function");
  onConnection?.(socket, upgradeReq);

  return {
    clients,
    listeners,
    socket,
    upgradeReq,
    wss,
  };
}
