import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { HealthSummary } from "../../../commands/health.types.js";
import type { ResolvedGatewayAuth } from "../../auth.js";
import { getOperatorApprovalRuntimeToken } from "../../operator-approval-runtime-token.js";
import { PROTOCOL_VERSION } from "../../protocol/index.js";
import { handleGatewayRequest } from "../../server-methods.js";
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

import { testing, attachGatewayWsMessageHandler } from "./message-handler.js";

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

function attachGatewayHarness(options: {
  connId: string;
  connectNonce: string;
  refreshHealthSnapshot: GatewayRequestContext["refreshHealthSnapshot"];
  requestOrigin?: string;
  isClosed?: () => boolean;
}) {
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
      headers: {
        host: "127.0.0.1:19001",
        ...(options.requestOrigin ? { origin: options.requestOrigin } : {}),
      },
      socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage,
    connId: options.connId,
    remoteAddr: "127.0.0.1",
    localAddr: "127.0.0.1",
    requestHost: "127.0.0.1:19001",
    requestOrigin: options.requestOrigin,
    connectNonce: options.connectNonce,
    getResolvedAuth: () => resolvedAuth,
    gatewayMethods: [],
    events: [],
    extraHandlers: {},
    buildRequestContext: () => ({}) as GatewayRequestContext,
    refreshHealthSnapshot: options.refreshHealthSnapshot,
    send,
    close: vi.fn(),
    isClosed: options.isClosed ?? vi.fn(() => false),
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
  const sendMessage = onMessage;
  return {
    socketSend,
    sendConnect: (id: string, params: Record<string, unknown>) => {
      sendMessage(
        JSON.stringify({
          type: "req",
          id,
          method: "connect",
          params,
        }),
      );
    },
    get client() {
      return client;
    },
  };
}

describe("attachGatewayWsMessageHandler post-connect health refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("closes invalidated clients before dispatching queued requests", () => {
    let onMessage: ((data: string) => void) | undefined;
    const socket = {
      _receiver: {},
      on: vi.fn((event: string, handler: (data: string) => void) => {
        if (event === "message") {
          onMessage = handler;
        }
        return socket;
      }),
    } as unknown as WebSocket;
    const close = vi.fn();
    const setCloseCause = vi.fn();
    const client = {
      invalidated: true,
      invalidatedReason: "device-token-revoked",
      connect: {
        client: {
          id: "openclaw-control-ui",
          version: "dev",
          platform: "test",
          mode: "ui",
        },
        role: "operator",
        scopes: [],
      },
      connId: "conn-invalidated",
      usesSharedGatewayAuth: false,
    };

    attachGatewayWsMessageHandler({
      socket,
      upgradeReq: {
        headers: { host: "127.0.0.1:19001" },
        socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
      connId: "conn-invalidated",
      remoteAddr: "127.0.0.1",
      localAddr: "127.0.0.1",
      requestHost: "127.0.0.1:19001",
      connectNonce: "nonce-invalidated",
      getResolvedAuth: () => ({ mode: "none", allowTailscale: false }),
      gatewayMethods: [],
      events: [],
      extraHandlers: {},
      buildRequestContext: () => ({}) as GatewayRequestContext,
      refreshHealthSnapshot: vi.fn(async () => createHealthSummary()),
      send: vi.fn(),
      close,
      isClosed: vi.fn(() => false),
      clearHandshakeTimer: vi.fn(),
      getClient: () => client as never,
      setClient: vi.fn(() => true),
      setHandshakeState: vi.fn(),
      setCloseCause,
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
        id: "queued-1",
        method: "status.summary",
        params: {},
      }),
    );

    expect(setCloseCause).toHaveBeenCalledWith("client-invalidated", {
      reason: "device-token-revoked",
      method: "status.summary",
    });
    expect(close).toHaveBeenCalledWith(4001, "client invalidated: device-token-revoked");
    expect(handleGatewayRequest).not.toHaveBeenCalled();
  });

  it("waits for credential mutation requests before dispatching later queued requests", async () => {
    let onMessage: ((data: string) => void) | undefined;
    let releaseMutation: (() => void) | undefined;
    const socket = {
      _receiver: {},
      on: vi.fn((event: string, handler: (data: string) => void) => {
        if (event === "message") {
          onMessage = handler;
        }
        return socket;
      }),
    } as unknown as WebSocket;
    const close = vi.fn();
    const setCloseCause = vi.fn();
    const client = {
      invalidated: false,
      connect: {
        client: {
          id: "openclaw-control-ui",
          version: "dev",
          platform: "test",
          mode: "ui",
        },
        role: "operator",
        scopes: [],
      },
      connId: "conn-invalidating",
      usesSharedGatewayAuth: false,
    };
    vi.mocked(handleGatewayRequest).mockImplementation(async (opts) => {
      expect(opts.req.method).toBe("device.token.revoke");
      await new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
      client.invalidated = true;
      (client as { invalidatedReason?: string }).invalidatedReason = "device-token-revoked";
    });

    attachGatewayWsMessageHandler({
      socket,
      upgradeReq: {
        headers: { host: "127.0.0.1:19001" },
        socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
      connId: "conn-invalidating",
      remoteAddr: "127.0.0.1",
      localAddr: "127.0.0.1",
      requestHost: "127.0.0.1:19001",
      connectNonce: "nonce-invalidating",
      getResolvedAuth: () => ({ mode: "none", allowTailscale: false }),
      gatewayMethods: [],
      events: [],
      extraHandlers: {},
      buildRequestContext: () => ({}) as GatewayRequestContext,
      refreshHealthSnapshot: vi.fn(async () => createHealthSummary()),
      send: vi.fn(),
      close,
      isClosed: vi.fn(() => false),
      clearHandshakeTimer: vi.fn(),
      getClient: () => client as never,
      setClient: vi.fn(() => true),
      setHandshakeState: vi.fn(),
      setCloseCause,
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
        id: "revoke-1",
        method: "device.token.revoke",
        params: { deviceId: "device-1", role: "operator" },
      }),
    );
    onMessage(
      JSON.stringify({
        type: "req",
        id: "queued-1",
        method: "status.summary",
        params: {},
      }),
    );

    await vi.waitFor(() => {
      expect(handleGatewayRequest).toHaveBeenCalledTimes(1);
      expect(releaseMutation).toBeTypeOf("function");
    });

    releaseMutation?.();

    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledWith(4001, "client invalidated: device-token-revoked");
    });
    expect(handleGatewayRequest).toHaveBeenCalledTimes(1);
    expect(setCloseCause).toHaveBeenCalledWith("client-invalidated", {
      reason: "device-token-revoked",
      method: "status.summary",
    });
  });

  it("drains credential mutation barriers installed by earlier queued requests", async () => {
    let onMessage: ((data: string) => void) | undefined;
    let releaseFirstMutation: (() => void) | undefined;
    let releaseSecondMutation: (() => void) | undefined;
    const socket = {
      _receiver: {},
      on: vi.fn((event: string, handler: (data: string) => void) => {
        if (event === "message") {
          onMessage = handler;
        }
        return socket;
      }),
    } as unknown as WebSocket;
    const close = vi.fn();
    const client = {
      invalidated: false,
      connect: {
        client: {
          id: "openclaw-control-ui",
          version: "dev",
          platform: "test",
          mode: "ui",
        },
        role: "operator",
        scopes: [],
      },
      connId: "conn-chained-invalidating",
      usesSharedGatewayAuth: false,
    };
    vi.mocked(handleGatewayRequest).mockImplementation(async (opts) => {
      if (opts.req.method === "device.token.rotate") {
        await new Promise<void>((resolve) => {
          releaseFirstMutation = resolve;
        });
        return;
      }
      expect(opts.req.method).toBe("device.token.revoke");
      await new Promise<void>((resolve) => {
        releaseSecondMutation = resolve;
      });
      client.invalidated = true;
      (client as { invalidatedReason?: string }).invalidatedReason = "device-token-revoked";
    });

    attachGatewayWsMessageHandler({
      socket,
      upgradeReq: {
        headers: { host: "127.0.0.1:19001" },
        socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
      connId: "conn-chained-invalidating",
      remoteAddr: "127.0.0.1",
      localAddr: "127.0.0.1",
      requestHost: "127.0.0.1:19001",
      connectNonce: "nonce-chained-invalidating",
      getResolvedAuth: () => ({ mode: "none", allowTailscale: false }),
      gatewayMethods: [],
      events: [],
      extraHandlers: {},
      buildRequestContext: () => ({}) as GatewayRequestContext,
      refreshHealthSnapshot: vi.fn(async () => createHealthSummary()),
      send: vi.fn(),
      close,
      isClosed: vi.fn(() => false),
      clearHandshakeTimer: vi.fn(),
      getClient: () => client as never,
      setClient: vi.fn(() => true),
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
        id: "rotate-1",
        method: "device.token.rotate",
        params: { deviceId: "device-1", role: "operator" },
      }),
    );
    onMessage(
      JSON.stringify({
        type: "req",
        id: "revoke-1",
        method: "device.token.revoke",
        params: { deviceId: "device-1", role: "operator" },
      }),
    );
    onMessage(
      JSON.stringify({
        type: "req",
        id: "queued-1",
        method: "status.summary",
        params: {},
      }),
    );

    await vi.waitFor(() => {
      expect(handleGatewayRequest).toHaveBeenCalledTimes(1);
      expect(releaseFirstMutation).toBeTypeOf("function");
    });

    releaseFirstMutation?.();
    await vi.waitFor(() => {
      expect(handleGatewayRequest).toHaveBeenCalledTimes(2);
      expect(releaseSecondMutation).toBeTypeOf("function");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handleGatewayRequest).toHaveBeenCalledTimes(2);

    releaseSecondMutation?.();
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledWith(4001, "client invalidated: device-token-revoked");
    });
    expect(handleGatewayRequest).toHaveBeenCalledTimes(2);
  });

  it("uses the injected runtime-aware health refresh after hello", async () => {
    let resolveRefresh: (() => void) | undefined;
    const refreshHealthSnapshot = vi.fn<GatewayRequestContext["refreshHealthSnapshot"]>(
      () =>
        new Promise((resolve) => {
          resolveRefresh = () => resolve(createHealthSummary());
        }),
    );
    const isClosed = vi.fn(() => false);
    const harness = attachGatewayHarness({
      connId: "conn-1",
      requestOrigin: "http://127.0.0.1:19001",
      connectNonce: "nonce-1",
      refreshHealthSnapshot,
      isClosed,
    });

    harness.sendConnect("connect-1", {
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
    });

    await vi.waitFor(() => {
      expect(harness.socketSend).toHaveBeenCalled();
    });
    const hello = JSON.parse(harness.socketSend.mock.calls.at(0)?.[0] ?? "{}") as { ok?: boolean };
    expect(hello.ok).toBe(true);

    await vi.waitFor(() => {
      expect(refreshHealthSnapshot).toHaveBeenCalledWith({ probe: false });
    });
    resolveRefresh?.();
  });

  it("does not mark local backend self-pairing clients as approval runtimes", async () => {
    const refreshHealthSnapshot = vi.fn<GatewayRequestContext["refreshHealthSnapshot"]>(async () =>
      createHealthSummary(),
    );
    const harness = attachGatewayHarness({
      connId: "conn-approval-runtime-spoof",
      connectNonce: "nonce-approval-runtime-spoof",
      refreshHealthSnapshot,
    });

    harness.sendConnect("connect-approval-runtime-spoof", {
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
    });

    await vi.waitFor(() => {
      expect(harness.socketSend).toHaveBeenCalled();
    });
    const connectedClient = harness.client as {
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
    const harness = attachGatewayHarness({
      connId: "conn-approval-runtime-token",
      connectNonce: "nonce-approval-runtime-token",
      refreshHealthSnapshot,
    });

    harness.sendConnect("connect-approval-runtime-token", {
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
    });

    await vi.waitFor(() => {
      expect(harness.socketSend).toHaveBeenCalled();
    });
    const connectedClient = harness.client as {
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
        testing.resolvePinnedClientMetadata({
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
        testing.resolvePinnedClientMetadata({
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

  it.each([
    ["openclaw-ios", "iOS 26.5.0", "iOS 26.4.2", "iPhone"],
    ["openclaw-ios", "iPadOS 26.5.0", "iPadOS 26.4.2", "iPad"],
    ["openclaw-ios", "iPadOS 26.5.0", "iOS 26.4.2", "iPad"],
    ["openclaw-android", "Android 16", "Android 15", "Android"],
  ])(
    "allows %s platform version refresh without metadata-upgrade approval",
    (clientId, claimedPlatform, pairedPlatform, deviceFamily) => {
      expect(
        testing.resolvePinnedClientMetadata({
          clientId,
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
        refreshPairedPlatform: claimedPlatform,
      });
    },
  );

  it("still requires approval when an iOS device family changes", () => {
    expect(
      testing.resolvePinnedClientMetadata({
        clientId: "openclaw-ios",
        clientMode: "node",
        claimedPlatform: "iOS 26.5.0",
        claimedDeviceFamily: "iPad",
        pairedPlatform: "iOS 26.4.2",
        pairedDeviceFamily: "iPhone",
      }),
    ).toEqual({
      platformMismatch: false,
      deviceFamilyMismatch: true,
      pinnedPlatform: "iOS 26.5.0",
      pinnedDeviceFamily: "iPhone",
      refreshPairedPlatform: "iOS 26.5.0",
    });
  });

  it("keeps non-mobile platform version changes approval-bound", () => {
    expect(
      testing.resolvePinnedClientMetadata({
        clientId: "node-host",
        clientMode: "node",
        claimedPlatform: "linux 6.9",
        claimedDeviceFamily: "Linux",
        pairedPlatform: "linux 6.8",
        pairedDeviceFamily: "Linux",
      }),
    ).toEqual({
      platformMismatch: true,
      deviceFamilyMismatch: false,
      pinnedPlatform: undefined,
      pinnedDeviceFamily: "Linux",
    });
  });
});
