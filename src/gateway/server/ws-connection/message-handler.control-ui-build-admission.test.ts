// Raw WebSocket proof for the pre-registration Control UI build admission boundary.
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  ConnectErrorDetailCodes,
  readControlUiBuildMismatchId,
} from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes, PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/index.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { rawDataToString } from "../../../infra/ws.js";
import { GatewayConnectionWork } from "../../server-connection-work.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";
import { GatewayNodeLifecycleDispatchTracker } from "./node-lifecycle-dispatch.js";

const {
  handleGatewayRequestMock,
  incrementPresenceVersionMock,
  resolveRuntimeServiceBuildIdMock,
  setLastFrameMetaMock,
  upsertPresenceMock,
} = vi.hoisted(() => ({
  handleGatewayRequestMock: vi.fn(),
  incrementPresenceVersionMock: vi.fn(() => 2),
  resolveRuntimeServiceBuildIdMock: vi.fn<() => string | null>(() => "gateway-build"),
  setLastFrameMetaMock: vi.fn(),
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
vi.mock("../../../infra/system-presence.js", () => ({
  upsertPresence: upsertPresenceMock,
  listSystemPresence: vi.fn(() => []),
}));
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
}));
vi.mock("../../../version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../version.js")>();
  return { ...actual, resolveRuntimeServiceBuildId: resolveRuntimeServiceBuildIdMock };
});

import { attachGatewayWsMessageHandler } from "./message-handler.js";

// A stale Control UI browser still owns a device identity; the build check is
// only reachable once the device passes connect auth and silent local pairing.
const temporaryIdentityPaths: string[] = [];

async function buildSignedControlUiDevice(nonce: string) {
  const { buildDeviceAuthPayload } = await import("../../device-auth.js");
  const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
    await import("../../../infra/device-identity.js");
  const identityPath = path.join(tmpdir(), `openclaw-build-admission-${randomUUID()}.sqlite`);
  temporaryIdentityPaths.push(identityPath);
  const identity = loadOrCreateDeviceIdentity({ path: identityPath });
  const signedAtMs = Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: "openclaw-control-ui",
    clientMode: "webchat",
    role: "operator",
    scopes: [],
    signedAtMs,
    token: "test-token",
    nonce,
  });
  return {
    id: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    signature: signDevicePayload(identity.privateKeyPem, payload),
    signedAt: signedAtMs,
    nonce,
  };
}

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

beforeEach(() => {
  setRuntimeConfigSnapshot(gatewayConfig);
});

afterEach(async () => {
  clearRuntimeConfigSnapshot();
  vi.clearAllMocks();
  resolveRuntimeServiceBuildIdMock.mockReturnValue("gateway-build");
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryIdentityPaths
      .splice(0)
      .flatMap((identityPath) =>
        [identityPath, `${identityPath}-wal`, `${identityPath}-shm`].map((file) =>
          rm(file, { force: true }),
        ),
      ),
  );
});

describe("Control UI build admission over WebSocket", () => {
  it.each([
    {
      name: "legacy same-origin document",
      clientBuildId: undefined,
    },
    {
      name: "explicit stale same-origin document",
      clientBuildId: "stale-build",
    },
  ])("rejects a $name before registration or RPC dispatch", async (testCase) => {
    const { clientBuildId } = testCase;
    const connectionWork = new GatewayConnectionWork();
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
    // Hold the injected close until the post-rejection frame reaches the handler;
    // otherwise socket timing can make the no-RPC assertion vacuous.
    let releasePostRejectionFrame = () => {};
    const postRejectionFrameObserved = new Promise<void>((resolve) => {
      releasePostRejectionFrame = resolve;
    });
    let closeRequested = false;

    wss.on("connection", (socket, request) => {
      const send = (value: unknown) => {
        socket.send(JSON.stringify(value));
        return { kind: "sent" } as const;
      };
      attachGatewayWsMessageHandler({
        socket,
        connectionWork,
        upgradeReq: request as IncomingMessage,
        ingressAttribution: {
          kind: "direct-local",
          clientIp: "127.0.0.1",
          rateLimit: {
            subject: { key: "127.0.0.1" },
            resetOnSuccess: true,
          },
        },
        connId: "legacy-build-connection",
        bootId: "control-ui-build-admission-test-boot",
        remoteAddr: "127.0.0.1",
        localAddr: "127.0.0.1",
        requestHost: request.headers.host,
        requestOrigin:
          typeof request.headers.origin === "string" ? request.headers.origin : undefined,
        connectNonce: "legacy-build-nonce",
        getResolvedAuth: () => ({
          mode: "token",
          token: "test-token",
          allowTailscale: false,
        }),
        gatewayMethods: [],
        events: [],
        extraHandlers: {},
        buildRequestContext: () =>
          ({
            broadcast: vi.fn(),
            incrementPresenceVersion: incrementPresenceVersionMock,
            getHealthVersion: () => 1,
          }) as unknown as GatewayRequestContext,
        nodeLifecycleDispatch: new GatewayNodeLifecycleDispatchTracker(),
        refreshHealthSnapshot: vi.fn(),
        send,
        close: (code, reason) => {
          if (closeRequested) {
            return;
          }
          closeRequested = true;
          void postRejectionFrameObserved.then(() => socket.close(code, reason));
        },
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
        setLastFrameMeta: (meta) => {
          setLastFrameMetaMock(meta);
          if (meta.method === "health" && meta.id === "post-rejection-rpc") {
            releasePostRejectionFrame();
          }
        },
        originCheckMetrics: { hostHeaderFallbackAccepted: 0 },
        logGateway: createLogger() as never,
        logHealth: createLogger() as never,
        logWsControl: createLogger() as never,
      });
    });

    const device = await buildSignedControlUiDevice("legacy-build-nonce");
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
              ...(clientBuildId ? { buildId: clientBuildId } : {}),
            },
            role: "operator",
            caps: [],
            auth: { token: "test-token" },
            device,
          },
        }),
      );

      const rejection = await response;
      expect(rejection).toMatchObject({
        ok: false,
        error: {
          code: ErrorCodes.UNAVAILABLE,
          message: "protocol mismatch: Control UI updated; reload this page to continue",
          retryable: false,
          details: {
            code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
            gatewayBuildId: "gateway-build",
            reloadRequired: true,
          },
        },
      });
      expect(
        readControlUiBuildMismatchId(
          (rejection.error as { details?: unknown } | undefined)?.details,
        ),
      ).toBe("gateway-build");
      ws.send(
        JSON.stringify({
          type: "req",
          id: "post-rejection-rpc",
          method: "health",
          params: {},
        }),
      );
      expect(await closed).toBe(1008);
      expect(connectedClient).toBeNull();
      expect(upsertPresenceMock).not.toHaveBeenCalled();
      expect(setLastFrameMetaMock).toHaveBeenCalledWith({
        type: "req",
        method: "health",
        id: "post-rejection-rpc",
      });
      expect(handleGatewayRequestMock).not.toHaveBeenCalled();
    } finally {
      releasePostRejectionFrame();
      ws.terminate();
      for (const socket of wss.clients) {
        socket.terminate();
      }
      connectionWork.beginClose();
      try {
        await withDeadline(
          new Promise<void>((resolve) => {
            wss.close(() => resolve());
          }),
          "cleanup",
        );
      } finally {
        await connectionWork.drain();
      }
    }
  });
});
