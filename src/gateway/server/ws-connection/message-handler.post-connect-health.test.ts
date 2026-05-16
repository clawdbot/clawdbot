import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { HealthSummary } from "../../../commands/health.types.js";
import type { ResolvedGatewayAuth } from "../../auth.js";
import { getOperatorApprovalRuntimeToken } from "../../operator-approval-runtime-token.js";
import { PROTOCOL_VERSION } from "../../protocol/index.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";

const {
  buildGatewaySnapshotMock,
  getHealthCacheMock,
  getHealthVersionMock,
  incrementPresenceVersionMock,
  loadConfigMock,
  upsertPresenceMock,
} = vi.hoisted(() => ({
  buildGatewaySnapshotMock: vi.fn(() => ({
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
  getHealthCacheMock: vi.fn(() => null),
  getHealthVersionMock: vi.fn(() => 1),
  incrementPresenceVersionMock: vi.fn(() => 2),
  loadConfigMock: vi.fn(() => ({
    gateway: {
      auth: { mode: "none" },
      controlUi: {
        allowedOrigins: ["http://127.0.0.1:19001"],
        dangerouslyDisableDeviceAuth: true,
      },
    },
  })),
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

vi.mock("../../server-methods.js", () => ({
  handleGatewayRequest: vi.fn(),
}));

vi.mock("../health-state.js", () => ({
  buildGatewaySnapshot: buildGatewaySnapshotMock,
  getHealthCache: getHealthCacheMock,
  getHealthVersion: getHealthVersionMock,
  incrementPresenceVersion: incrementPresenceVersionMock,
}));

import { __testing, attachGatewayWsMessageHandler } from "./message-handler.js";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createHealthSummary(): HealthSummary {
  return {
    ok: true,
    ts: 1,
    durationMs: 1,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 0,
    defaultAgentId: "main",
    agents: [],
    sessions: {
      path: "",
      count: 0,
      recent: [],
    },
  };
}

describe("attachGatewayWsMessageHandler post-connect health refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the injected runtime-aware health refresh after hello", async () => {
    let resolveRefresh: (() => void) | undefined;
    const refreshHealthSnapshot = vi.fn<GatewayRequestContext["refreshHealthSnapshot"]>(
      () =>
        new Promise((resolve) => {
          resolveRefresh = () => resolve(createHealthSummary());
        }),
    );
    const socketSend = vi.fn((_payload: string, cb?: (err?: Error) => void) => {
      cb?.();
    });
    let onMessage: ((data: string) => void) | undefined;
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
    const send = vi.fn();
    const isClosed = vi.fn(() => false);
    let client: unknown = null;
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "none",
      allowTailscale: false,
    };

    attachGatewayWsMessageHandler({
      socket,
      upgradeReq: {
        headers: { host: "127.0.0.1:19001", origin: "http://127.0.0.1:19001" },
        socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
      connId: "conn-1",
      remoteAddr: "127.0.0.1",
      localAddr: "127.0.0.1",
      requestHost: "127.0.0.1:19001",
      requestOrigin: "http://127.0.0.1:19001",
      connectNonce: "nonce-1",
      getResolvedAuth: () => resolvedAuth,
      gatewayMethods: [],
      events: [],
      extraHandlers: {},
      buildRequestContext: () => ({}) as GatewayRequestContext,
      refreshHealthSnapshot,
      send,
      close: vi.fn(),
      isClosed,
      clearHandshakeTimer: vi.fn(),
      getClient: () => client as never,
      setClient: (next) => {
        client = next;
        return true;
      },
      setHandshakeState: vi.fn(),
      setCloseCause: vi.fn(),
      setLastFrameMeta: vi.fn(),
      originCheckMetrics: { hostHeaderFallbackAccepted: 0 },
      logGateway: createLogger() as never,
      logHealth: createLogger() as never,
      logWsControl: createLogger() as never,
    });

    if (onMessage === undefined) {
      throw new Error("expected websocket message handler");
    }

    onMessage(
      JSON.stringify({
        type: "req",
        id: "connect-1",
        method: "connect",
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: "openclaw-control-ui",
            version: "dev",
            platform: "test",
            mode: "ui",
          },
          role: "operator",
          caps: [],
        },
      }),
    );

    await vi.waitFor(() => {
      expect(socketSend).toHaveBeenCalled();
    });
    const hello = JSON.parse(socketSend.mock.calls.at(0)?.[0] ?? "{}") as { ok?: boolean };
    expect(hello.ok).toBe(true);

    await vi.waitFor(() => {
      expect(refreshHealthSnapshot).toHaveBeenCalledWith({ probe: true });
    });
    resolveRefresh?.();
  });

  it("does not mark local backend self-pairing clients as approval runtimes", async () => {
    const refreshHealthSnapshot = vi.fn<GatewayRequestContext["refreshHealthSnapshot"]>(async () =>
      createHealthSummary(),
    );
    const socketSend = vi.fn((_payload: string, cb?: (err?: Error) => void) => {
      cb?.();
    });
    let onMessage: ((data: string) => void) | undefined;
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
    const send = vi.fn();
    let client: unknown = null;
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "none",
      allowTailscale: false,
    };

    attachGatewayWsMessageHandler({
      socket,
      upgradeReq: {
        headers: { host: "127.0.0.1:19001" },
        socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
      connId: "conn-approval-runtime-spoof",
      remoteAddr: "127.0.0.1",
      localAddr: "127.0.0.1",
      requestHost: "127.0.0.1:19001",
      connectNonce: "nonce-approval-runtime-spoof",
      getResolvedAuth: () => resolvedAuth,
      gatewayMethods: [],
      events: [],
      extraHandlers: {},
      buildRequestContext: () => ({}) as GatewayRequestContext,
      refreshHealthSnapshot,
      send,
      close: vi.fn(),
      isClosed: vi.fn(() => false),
      clearHandshakeTimer: vi.fn(),
      getClient: () => client as never,
      setClient: (next) => {
        client = next;
        return true;
      },
      setHandshakeState: vi.fn(),
      setCloseCause: vi.fn(),
      setLastFrameMeta: vi.fn(),
      originCheckMetrics: { hostHeaderFallbackAccepted: 0 },
      logGateway: createLogger() as never,
      logHealth: createLogger() as never,
      logWsControl: createLogger() as never,
    });

    if (onMessage === undefined) {
      throw new Error("expected websocket message handler");
    }

    onMessage(
      JSON.stringify({
        type: "req",
        id: "connect-approval-runtime-spoof",
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
          scopes: ["operator.approvals"],
          caps: [],
        },
      }),
    );

    await vi.waitFor(() => {
      expect(socketSend).toHaveBeenCalled();
    });
    const connectedClient = client as {
      connect?: { scopes?: string[] };
      internal?: { approvalRuntime?: boolean };
    } | null;
    expect(connectedClient?.connect?.scopes).toEqual(["operator.approvals"]);
    expect(connectedClient?.internal?.approvalRuntime).not.toBe(true);
  });

  it("marks operator approval clients with the server runtime token", async () => {
    const refreshHealthSnapshot = vi.fn<GatewayRequestContext["refreshHealthSnapshot"]>(async () =>
      createHealthSummary(),
    );
    const socketSend = vi.fn((_payload: string, cb?: (err?: Error) => void) => {
      cb?.();
    });
    let onMessage: ((data: string) => void) | undefined;
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
    const send = vi.fn();
    let client: unknown = null;
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "none",
      allowTailscale: false,
    };

    attachGatewayWsMessageHandler({
      socket,
      upgradeReq: {
        headers: { host: "127.0.0.1:19001" },
        socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
      connId: "conn-approval-runtime-token",
      remoteAddr: "127.0.0.1",
      localAddr: "127.0.0.1",
      requestHost: "127.0.0.1:19001",
      connectNonce: "nonce-approval-runtime-token",
      getResolvedAuth: () => resolvedAuth,
      gatewayMethods: [],
      events: [],
      extraHandlers: {},
      buildRequestContext: () => ({}) as GatewayRequestContext,
      refreshHealthSnapshot,
      send,
      close: vi.fn(),
      isClosed: vi.fn(() => false),
      clearHandshakeTimer: vi.fn(),
      getClient: () => client as never,
      setClient: (next) => {
        client = next;
        return true;
      },
      setHandshakeState: vi.fn(),
      setCloseCause: vi.fn(),
      setLastFrameMeta: vi.fn(),
      originCheckMetrics: { hostHeaderFallbackAccepted: 0 },
      logGateway: createLogger() as never,
      logHealth: createLogger() as never,
      logWsControl: createLogger() as never,
    });

    if (onMessage === undefined) {
      throw new Error("expected websocket message handler");
    }

    onMessage(
      JSON.stringify({
        type: "req",
        id: "connect-approval-runtime-token",
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
          scopes: ["operator.approvals"],
          caps: [],
          auth: {
            approvalRuntimeToken: getOperatorApprovalRuntimeToken(),
          },
        },
      }),
    );

    await vi.waitFor(() => {
      expect(socketSend).toHaveBeenCalled();
    });
    const connectedClient = client as {
      internal?: { approvalRuntime?: boolean };
    } | null;
    expect(connectedClient?.internal?.approvalRuntime).toBe(true);
  });
});

describe("resolvePinnedClientMetadata", () => {
  it.each([
    ["darwin", "macos"],
    ["win32", "windows"],
  ])(
    "pins legacy node-host platform alias %s to paired canonical %s",
    (claimedPlatform, pairedPlatform) => {
      expect(
        __testing.resolvePinnedClientMetadata({
          clientId: "node-host",
          clientMode: "node",
          claimedPlatform,
          claimedDeviceFamily: pairedPlatform === "macos" ? "Mac" : "Windows",
          pairedPlatform,
          pairedDeviceFamily: pairedPlatform === "macos" ? "Mac" : "Windows",
        }),
      ).toEqual({
        platformMismatch: false,
        deviceFamilyMismatch: false,
        pinnedPlatform: pairedPlatform,
        pinnedDeviceFamily: pairedPlatform === "macos" ? "Mac" : "Windows",
      });
    },
  );

  it.each([
    ["macos", "darwin", "Mac"],
    ["windows", "win32", "Windows"],
  ])(
    "pins canonical node-host platform %s over paired legacy alias %s",
    (claimedPlatform, pairedPlatform, deviceFamily) => {
      expect(
        __testing.resolvePinnedClientMetadata({
          clientId: "node-host",
          clientMode: "node",
          claimedPlatform,
          claimedDeviceFamily: deviceFamily,
          pairedPlatform,
          pairedDeviceFamily: deviceFamily,
        }),
      ).toEqual({
        platformMismatch: false,
        deviceFamilyMismatch: false,
        pinnedPlatform: claimedPlatform,
        pinnedDeviceFamily: deviceFamily,
      });
    },
  );
});
