// Raw WebSocket proof for the pre-registration Control UI build admission boundary.
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ConnectErrorDetailCodes } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes, PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/index.js";
import { rawDataToString } from "../../../infra/ws.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";
import { GatewayNodeLifecycleDispatchTracker } from "./node-lifecycle-dispatch.js";

const {
  handleGatewayRequestMock,
  incrementPresenceVersionMock,
  resolveRuntimeServiceBuildIdMock,
  upsertPresenceMock,
} = vi.hoisted(() => ({
  handleGatewayRequestMock: vi.fn(),
  incrementPresenceVersionMock: vi.fn(() => 2),
  resolveRuntimeServiceBuildIdMock: vi.fn<() => string | null>(() => "gateway-build"),
  upsertPresenceMock: vi.fn(),
}));

const gatewayConfig = {
  gateway: {
    auth: { mode: "token" as const, token: "test-token" },
    controlUi: { allowedOrigins: ["*"] },
  },
};

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: () => gatewayConfig,
  loadConfig: () => gatewayConfig,
}));
vi.mock("../../../config/io.js", () => ({ getRuntimeConfig: () => gatewayConfig }));
vi.mock("../../../infra/system-presence.js", () => ({ upsertPresence: upsertPresenceMock }));
vi.mock("../../../state/user-profiles.js", () => ({
  adoptTailscaleProfileAvatar: vi.fn(),
  ensureProfileForEmail: vi.fn(async () => ({
    id: "profile-1",
    displayName: null,
    avatarRevision: "0",
    hasAvatar: false,
    updatedAt: 1,
  })),
  ensureProfileForTailscaleIdentity: vi.fn(),
  getUserProfileDisplay: vi.fn(() => ({
    id: "profile-1",
    displayName: null,
    avatarRevision: "0",
    hasAvatar: false,
    updatedAt: 1,
  })),
}));
vi.mock("../../server-methods.js", () => ({
  handleGatewayRequest: handleGatewayRequestMock,
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
vi.mock("../../../version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../version.js")>();
  return { ...actual, resolveRuntimeServiceBuildId: resolveRuntimeServiceBuildIdMock };
});

import { attachGatewayWsMessageHandler } from "./message-handler.js";

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), 5_000);
      timer.unref?.();
    }),
  ]);
}

afterEach(() => {
  vi.clearAllMocks();
  resolveRuntimeServiceBuildIdMock.mockReturnValue("gateway-build");
});

describe("Control UI build admission over WebSocket", () => {
  it("rejects a legacy same-origin document before registration or RPC dispatch", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await withDeadline(
      new Promise<void>((resolve) => {
        wss.once("listening", resolve);
      }),
      "listen",
    );
    const address = wss.address();
    if (!address || typeof address === "string") {
      throw new Error("WebSocket test server did not expose a port");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    let connectedClient: unknown = null;

    wss.on("connection", (socket, request) => {
      const send = (value: unknown) => socket.send(JSON.stringify(value));
      attachGatewayWsMessageHandler({
        socket,
        upgradeReq: request as IncomingMessage,
        connId: "legacy-build-connection",
        remoteAddr: "127.0.0.1",
        localAddr: "127.0.0.1",
        requestHost: request.headers.host,
        requestOrigin:
          typeof request.headers.origin === "string" ? request.headers.origin : undefined,
        connectNonce: "legacy-build-nonce",
        isControlUiDeviceAuthMigrationPending: () => true,
        getResolvedAuth: () => ({
          mode: "token",
          token: "test-token",
          allowTailscale: false,
        }),
        gatewayMethods: [],
        events: [],
        extraHandlers: {},
        buildRequestContext: () => ({}) as GatewayRequestContext,
        nodeLifecycleDispatch: new GatewayNodeLifecycleDispatchTracker(),
        refreshHealthSnapshot: vi.fn(),
        send,
        close: (code, reason) => socket.close(code, reason),
        isClosed: () => socket.readyState >= WebSocket.CLOSING,
        clearHandshakeTimer: vi.fn(),
        getClient: () => connectedClient as never,
        setClient: (next) => {
          connectedClient = next;
          return true;
        },
        setHandshakeState: vi.fn(),
        advanceHandshakePhase: vi.fn(),
        setCloseCause: vi.fn(),
        setLastFrameMeta: vi.fn(),
        originCheckMetrics: { hostHeaderFallbackAccepted: 0 },
        logGateway: createLogger() as never,
        logHealth: createLogger() as never,
        logWsControl: createLogger() as never,
      });
    });

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`, {
      headers: {
        origin,
      },
    });
    try {
      await withDeadline(
        new Promise<void>((resolve) => {
          ws.once("open", resolve);
        }),
        "open",
      );
      const response = withDeadline(
        new Promise<Record<string, unknown>>((resolve) => {
          ws.once("message", (data) => {
            resolve(JSON.parse(rawDataToString(data)) as Record<string, unknown>);
          });
        }),
        "connect rejection",
      );
      const closed = withDeadline(
        new Promise<number>((resolve) => {
          ws.once("close", (code) => resolve(code));
        }),
        "socket close",
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "connect-legacy-build",
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: "openclaw-control-ui",
              version: "2026.8.1",
              platform: "web",
              mode: "webchat",
            },
            role: "operator",
            caps: [],
            auth: { token: "test-token" },
          },
        }),
      );

      expect(await response).toMatchObject({
        ok: false,
        error: {
          code: ErrorCodes.UNAVAILABLE,
          retryable: false,
          details: {
            code: ConnectErrorDetailCodes.CONTROL_UI_BUILD_MISMATCH,
            gatewayBuildId: "gateway-build",
            reloadRequired: true,
          },
        },
      });
      expect(await closed).toBe(1008);
      expect(connectedClient).toBeNull();
      expect(upsertPresenceMock).not.toHaveBeenCalled();
      expect(handleGatewayRequestMock).not.toHaveBeenCalled();
    } finally {
      ws.terminate();
      await withDeadline(
        new Promise<void>((resolve) => {
          wss.close(() => resolve());
        }),
        "cleanup",
      );
    }
  });
});
