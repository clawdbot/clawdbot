// WebSocket connect suspension tests cover root admission before handshake mutations.
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/index.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";

const { incrementPresenceVersionMock, loadConfigMock, upsertPresenceMock } = vi.hoisted(() => ({
  incrementPresenceVersionMock: vi.fn(() => 2),
  loadConfigMock: vi.fn(() => ({ gateway: { auth: { mode: "none" } } })),
  upsertPresenceMock: vi.fn(),
}));

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: loadConfigMock,
  loadConfig: loadConfigMock,
}));
vi.mock("../../../config/io.js", () => ({
  getRuntimeConfig: loadConfigMock,
}));
vi.mock("../../../infra/system-presence.js", () => ({
  upsertPresence: upsertPresenceMock,
}));
vi.mock("../health-state.js", () => ({
  buildGatewaySnapshot: vi.fn(() => ({
    presence: [],
    health: {},
    stateVersion: { presence: 1, health: 1 },
    uptimeMs: 1,
    sessionDefaults: {
      defaultAgentId: "main",
      mainKey: "main",
      mainSessionKey: "main",
      scope: "per-sender",
    },
  })),
  getHealthCache: vi.fn(() => null),
  getHealthVersion: vi.fn(() => 1),
  incrementPresenceVersion: incrementPresenceVersionMock,
}));

import { attachGatewayWsMessageHandler } from "./message-handler.js";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function attachHarness(params: { deferSocketSend?: boolean } = {}) {
  let onMessage: ((data: string) => void) | undefined;
  let finishSocketSend: (() => void) | undefined;
  let client: unknown = null;
  const socketSend = vi.fn((_payload: string, callback?: (error?: Error) => void) => {
    if (params.deferSocketSend) {
      finishSocketSend = () => callback?.();
      return;
    }
    callback?.();
  });
  const socket = {
    _receiver: {},
    send: socketSend,
    on: vi.fn((event: string, handler: (data: string) => void) => {
      if (event === "message") {
        onMessage = handler;
      }
      return socket;
    }),
  } as unknown as WebSocket;
  const close = vi.fn();
  const setClient = vi.fn((next: unknown) => {
    client = next;
    return true;
  });

  attachGatewayWsMessageHandler({
    socket,
    upgradeReq: {
      headers: { host: "127.0.0.1:19001" },
      socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage,
    connId: "suspension-connect",
    remoteAddr: "127.0.0.1",
    localAddr: "127.0.0.1",
    requestHost: "127.0.0.1:19001",
    connectNonce: "suspension-connect-nonce",
    getResolvedAuth: () => ({ mode: "none", allowTailscale: false }),
    gatewayMethods: [],
    events: [],
    extraHandlers: {},
    buildRequestContext: () => ({}) as GatewayRequestContext,
    refreshHealthSnapshot: vi.fn(async () => ({}) as never),
    send: vi.fn(),
    close,
    isClosed: vi.fn(() => false),
    clearHandshakeTimer: vi.fn(),
    getClient: () => client as never,
    setClient: setClient as never,
    setHandshakeState: vi.fn(),
    advanceHandshakePhase: vi.fn(),
    setCloseCause: vi.fn(),
    setLastFrameMeta: vi.fn(),
    originCheckMetrics: { hostHeaderFallbackAccepted: 0 },
    logGateway: createLogger() as never,
    logHealth: createLogger() as never,
    logWsControl: createLogger() as never,
  });
  if (!onMessage) {
    throw new Error("expected websocket message handler");
  }

  return {
    close,
    finishSocketSend: () => finishSocketSend?.(),
    get client() {
      return client;
    },
    sendConnect: () =>
      onMessage?.(
        JSON.stringify({
          type: "req",
          id: "connect-1",
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: "gateway-client",
              version: "dev",
              platform: "test",
              mode: "backend",
            },
            role: "operator",
            scopes: [],
            caps: [],
          },
        }),
      ),
    setClient,
    socketSend,
  };
}

beforeEach(() => {
  resetGatewayWorkAdmission();
  vi.clearAllMocks();
});

afterEach(resetGatewayWorkAdmission);

describe("WebSocket connect suspension admission", () => {
  it.each(["preparing", "prepared"] as const)(
    "rejects a validated connect while suspension is %s before session mutations",
    async (phase) => {
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension).not.toBeNull();
      if (phase === "prepared") {
        expect(suspension?.commit()).toBe(true);
      }
      const harness = attachHarness();

      harness.sendConnect();

      await vi.waitFor(() => {
        expect(harness.socketSend).toHaveBeenCalledOnce();
      });
      const response = JSON.parse(harness.socketSend.mock.calls[0]?.[0] ?? "{}") as {
        error?: {
          code?: string;
          retryable?: boolean;
          retryAfterMs?: number;
          details?: Record<string, unknown>;
        };
      };
      expect(response.error).toMatchObject({
        code: "UNAVAILABLE",
        retryable: true,
        retryAfterMs: 1_000,
        details: {
          method: "connect",
          reason: "gateway-suspending",
          phase,
        },
      });
      expect(harness.client).toBeNull();
      expect(harness.setClient).not.toHaveBeenCalled();
      expect(upsertPresenceMock).not.toHaveBeenCalled();
      expect(incrementPresenceVersionMock).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(harness.close).toHaveBeenCalledWith(1013, "gateway suspension in progress");
      });

      if (phase === "prepared") {
        suspension?.release();
      } else {
        suspension?.rollback();
      }
    },
  );

  it("keeps an accepted handshake visible as root work until hello is sent", async () => {
    const harness = attachHarness({ deferSocketSend: true });

    harness.sendConnect();

    await vi.waitFor(() => {
      expect(harness.socketSend).toHaveBeenCalledOnce();
    });
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(suspension?.rollback()).toBe(true);

    harness.finishSocketSend();
    await vi.waitFor(() => {
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
  });
});
