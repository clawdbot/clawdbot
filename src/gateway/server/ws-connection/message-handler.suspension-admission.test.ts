// WebSocket connect suspension tests cover root admission before handshake mutations.
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/index.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";
import { GatewayNodeLifecycleDispatchTracker } from "./node-lifecycle-dispatch.js";

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

function attachHarness(params: { deferSocketSend?: boolean; startupPending?: boolean } = {}) {
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
  const send = vi.fn((_frame: unknown) => ({ kind: "sent" }) as const);
  const setCloseCause = vi.fn();
  const setClient = vi.fn((next: unknown) => {
    client = next;
    return true;
  });

  attachGatewayWsMessageHandler({
    socket,
    bootId: "suspension-admission-test-boot",
    upgradeReq: {
      headers: { host: "127.0.0.1:19001" },
      socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage,
    ingressAttribution: {
      kind: "direct-local",
      clientIp: "127.0.0.1",
      rateLimit: {
        subject: { key: "127.0.0.1" },
        resetOnSuccess: true,
      },
    },
    connId: "suspension-connect",
    remoteAddr: "127.0.0.1",
    localAddr: "127.0.0.1",
    requestHost: "127.0.0.1:19001",
    connectNonce: "suspension-connect-nonce",
    getResolvedAuth: () => ({ mode: "none", allowTailscale: false }),
    isStartupPending: () => params.startupPending === true,
    gatewayMethods: [],
    events: [],
    extraHandlers: {},
    buildRequestContext: () => ({}) as GatewayRequestContext,
    nodeLifecycleDispatch: new GatewayNodeLifecycleDispatchTracker(),
    refreshHealthSnapshot: vi.fn(async () => ({}) as never),
    send,
    close,
    isClosed: vi.fn(() => false),
    clearHandshakeTimer: vi.fn(),
    getClient: () => client as never,
    setClient: setClient as never,
    setHandshakeState: vi.fn(),
    advanceHandshakePhase: vi.fn(),
    setCloseCause,
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
    sendNodeConnect: () =>
      onMessage?.(
        JSON.stringify({
          type: "req",
          id: "node-connect-1",
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
            role: "node",
            scopes: [],
            caps: [],
          },
        }),
      ),
    sendWorkerConnect: () =>
      onMessage?.(
        JSON.stringify({
          type: "req",
          id: "worker-connect",
          method: "connect",
          params: { role: "worker" },
        }),
      ),
    sendStartupNodeConnect: () =>
      onMessage?.(
        JSON.stringify({
          type: "req",
          id: "startup-node-connect",
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: "node-host",
              version: "dev",
              platform: "linux",
              mode: "node",
            },
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            auth: { bootstrapToken: "startup-bootstrap-token" },
            device: {
              id: "startup-node-device",
              publicKey: "startup-node-public-key",
              signature: "startup-node-signature",
              signedAt: Date.now(),
              nonce: "suspension-connect-nonce",
            },
          },
        }),
      ),
    send,
    setCloseCause,
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
  it("rejects a validated connect while suspension is preparing before session mutations", async () => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
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
        phase: "preparing",
      },
    });
    expect(harness.client).toBeNull();
    expect(harness.setClient).not.toHaveBeenCalled();
    expect(upsertPresenceMock).not.toHaveBeenCalled();
    expect(incrementPresenceVersionMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(harness.close).toHaveBeenCalledWith(1013, "gateway suspension in progress");
    });
    suspension?.rollback();
  });

  it("accepts a validated connect while suspension is prepared", async () => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const harness = attachHarness();

    harness.sendConnect();

    await vi.waitFor(() => {
      expect(harness.setClient).toHaveBeenCalledOnce();
    });
    expect(harness.client).not.toBeNull();
    expect(harness.close).not.toHaveBeenCalled();
    suspension?.release();
  });

  it("rejects a node connect while suspension is prepared", async () => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const harness = attachHarness();

    harness.sendNodeConnect();

    await vi.waitFor(() => {
      expect(harness.socketSend).toHaveBeenCalledOnce();
    });
    const response = JSON.parse(harness.socketSend.mock.calls[0]?.[0] ?? "{}") as {
      error?: { details?: Record<string, unknown> };
    };
    expect(response.error?.details).toMatchObject({
      method: "connect",
      reason: "gateway-suspending",
      phase: "prepared",
    });
    expect(harness.setClient).not.toHaveBeenCalled();
    expect(upsertPresenceMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(harness.close).toHaveBeenCalledWith(1013, "gateway suspension in progress");
    });
    suspension?.release();
  });

  it("rejects a validated connect during restart drain", async () => {
    markGatewayRestartDraining();
    const harness = attachHarness();

    harness.sendConnect();

    await vi.waitFor(() => {
      expect(harness.socketSend).toHaveBeenCalledOnce();
    });
    const response = JSON.parse(harness.socketSend.mock.calls[0]?.[0] ?? "{}") as {
      error?: { details?: Record<string, unknown> };
    };
    expect(response.error?.details).toMatchObject({
      method: "connect",
      reason: "gateway-restarting",
    });
    expect(harness.setClient).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(harness.close).toHaveBeenCalledWith(1013, "gateway restart in progress");
    });
  });

  it("keeps the old draining server closed to an exact startup node shape", async () => {
    markGatewayRestartDraining();
    const harness = attachHarness({ startupPending: false });

    harness.sendStartupNodeConnect();

    await vi.waitFor(() => expect(harness.socketSend).toHaveBeenCalledOnce());
    expect(harness.setClient).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(harness.close).toHaveBeenCalledWith(1013, "gateway restart in progress");
    });
  });

  it("keeps suspension closed to an exact startup node shape", async () => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const harness = attachHarness({ startupPending: true });

    harness.sendStartupNodeConnect();

    await vi.waitFor(() => expect(harness.socketSend).toHaveBeenCalledOnce());
    expect(harness.setClient).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(harness.close).toHaveBeenCalledWith(1013, "gateway suspension in progress");
    });
    suspension?.release();
  });

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

  it("rejects worker identity on the general gateway ingress", async () => {
    const harness = attachHarness();
    harness.sendWorkerConnect();

    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledWith(1008, "invalid-handshake"));
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.setCloseCause).toHaveBeenCalledWith("invalid-handshake", {
      handshakeError: "invalid worker handshake",
    });
  });
});
