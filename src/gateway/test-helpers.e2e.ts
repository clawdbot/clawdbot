// Gateway E2E test helpers.
// Starts gateway servers, connects test clients, and handles device-auth fixtures.
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { WebSocket } from "ws";
import { type HelloOk, PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import { acquireGatewayTestClient } from "../../test/helpers/gateway-client.js";
import {
  acquireGatewayTestWebSocket,
  closeGatewayTestWebSocket,
} from "../../test/helpers/gateway-websocket.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import {
  type DeviceIdentity,
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { captureEnv } from "../test-utils/env.js";
import { getDeterministicFreePortBlock } from "../test-utils/ports.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../utils/message-channel.js";
import type { GatewayClient } from "./client.js";
import { buildDeviceAuthPayloadV3 } from "./device-auth.js";
import { startGatewayServer } from "./server.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "./test-helpers.env.js";

/** Reserve a deterministic free port block for Gateway E2E tests. */
export async function getGatewayE2ePortBlock(): Promise<number> {
  return await getDeterministicFreePortBlock({ offsets: [0, 1, 2, 3, 4] });
}

/** Connect a GatewayClient with test defaults and resolve after hello-ok. */
export async function connectGatewayClient(params: {
  url: string;
  token?: string;
  deviceToken?: string;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  clientVersion?: string;
  mode?: GatewayClientMode;
  platform?: string;
  deviceFamily?: string;
  role?: "operator" | "node";
  scopes?: string[];
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  instanceId?: string;
  deviceIdentity?: DeviceIdentity;
  onEvent?: (evt: { event?: string; payload?: unknown }) => void;
  onHelloOk?: (hello: HelloOk) => void;
  connectChallengeTimeoutMs?: number;
  preauthHandshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  minProtocol?: number;
  maxProtocol?: number;
  timeoutMs?: number;
  timeoutMessage?: string;
}) {
  const role = params.role ?? "operator";
  const scopes = params.scopes ?? (role === "node" ? [] : undefined);
  const platform = params.platform ?? process.platform;
  const identityRoot = process.env.OPENCLAW_STATE_DIR ?? process.env.HOME ?? os.tmpdir();
  const deviceIdentity =
    params.deviceIdentity ??
    loadOrCreateDeviceIdentity({
      path: (() => {
        const safe = normalizeLowercaseStringOrEmpty(
          `${params.clientName ?? GATEWAY_CLIENT_NAMES.TEST}-${params.mode ?? GATEWAY_CLIENT_MODES.TEST}-${platform}-${params.deviceFamily ?? "none"}-${role}`.replace(
            /[^a-zA-Z0-9._-]+/g,
            "_",
          ),
        );
        return path.join(identityRoot, "test-device-identities", `${safe}.sqlite`);
      })(),
    });
  return await acquireGatewayTestClient(
    {
      url: params.url,
      token: params.token,
      deviceToken: params.deviceToken,
      ...(params.connectChallengeTimeoutMs !== undefined
        ? { connectChallengeTimeoutMs: params.connectChallengeTimeoutMs }
        : {}),
      preauthHandshakeTimeoutMs: params.preauthHandshakeTimeoutMs ?? params.timeoutMs,
      ...(params.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: params.requestTimeoutMs }
        : {}),
      minProtocol: params.minProtocol,
      maxProtocol: params.maxProtocol,
      clientName: params.clientName ?? GATEWAY_CLIENT_NAMES.TEST,
      clientDisplayName: params.clientDisplayName ?? "vitest",
      clientVersion: params.clientVersion ?? "dev",
      platform,
      deviceFamily: params.deviceFamily,
      mode: params.mode ?? GATEWAY_CLIENT_MODES.TEST,
      role,
      scopes,
      caps: params.caps,
      commands: params.commands,
      permissions: params.permissions,
      instanceId: params.instanceId,
      deviceIdentity,
      onEvent: params.onEvent,
      onHelloOk: params.onHelloOk,
    },
    {
      timeoutMs: params.timeoutMs ?? 10_000,
      timeoutMessage: params.timeoutMessage ?? "gateway connect timeout",
      closeMessage: "gateway closed during connect",
      unrefTimeout: true,
    },
  );
}

/** Join a connected GatewayClient's bounded stop contract. */
export async function disconnectGatewayClient(client: GatewayClient): Promise<void> {
  await client.stopAndWait();
}

type DeviceAuthConnectResponse = {
  type: "res";
  id: string;
  ok: boolean;
  error?: { message?: string };
};

function waitForDeviceAuthMessage<T>(
  ws: WebSocket,
  read: (data: WebSocket.RawData) => T | undefined,
  timeoutMessage: string,
): Promise<T> {
  const message = new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number, reason: Buffer) =>
      onError(new Error(`closed ${code}: ${rawDataToString(reason)}`));
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const value = read(data);
        if (value !== undefined) {
          cleanup();
          resolve(value);
        }
      } catch (error) {
        onError(toErrorObject(error, "Device-auth response reader failed"));
      }
    };
    const timer = setTimeout(() => onError(new Error(timeoutMessage)), 5_000);
    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
  // The challenge starts before open; retain the original waiter even when
  // another acquisition fails first, then join it during socket cleanup.
  void message.catch(() => {});
  return message;
}

export async function connectDeviceAuthReq(params: { url: string; token?: string }) {
  const ws = new WebSocket(params.url);
  const connectNoncePromise = waitForDeviceAuthMessage(
    ws,
    (data) => {
      try {
        const obj = JSON.parse(rawDataToString(data)) as {
          type?: unknown;
          event?: unknown;
          payload?: { nonce?: unknown } | null;
        };
        if (obj.type !== "event" || obj.event !== "connect.challenge") {
          return undefined;
        }
        const nonce = obj.payload?.nonce;
        return typeof nonce === "string" && nonce.trim().length > 0 ? nonce.trim() : undefined;
      } catch {
        return undefined;
      }
    },
    "timeout waiting for connect challenge",
  );
  const opening = acquireGatewayTestWebSocket(ws, 5_000);
  let connectResponsePromise: Promise<DeviceAuthConnectResponse> | undefined;
  const response = (async () => {
    // The challenge budget starts at construction, including time spent opening.
    const [, connectNonce] = await Promise.all([opening, connectNoncePromise]);
    const identity = loadOrCreateDeviceIdentity();
    const signedAtMs = Date.now();
    const platform = process.platform;
    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
      role: "operator",
      scopes: [],
      signedAtMs,
      token: params.token ?? null,
      nonce: connectNonce,
      platform,
    });
    const device = {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      signature: signDevicePayload(identity.privateKeyPem, payload),
      signedAt: signedAtMs,
      nonce: connectNonce,
    };
    ws.send(
      JSON.stringify({
        type: "req",
        id: "c1",
        method: "connect",
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: GATEWAY_CLIENT_NAMES.TEST,
            displayName: "vitest",
            version: "dev",
            platform,
            mode: GATEWAY_CLIENT_MODES.TEST,
          },
          caps: [],
          auth: params.token ? { token: params.token } : undefined,
          device,
        },
      }),
    );
    connectResponsePromise = waitForDeviceAuthMessage(
      ws,
      (data) => {
        const obj = JSON.parse(rawDataToString(data)) as { type?: unknown; id?: unknown };
        return obj?.type === "res" && obj?.id === "c1"
          ? (obj as DeviceAuthConnectResponse)
          : undefined;
      },
      "timeout",
    );
    return await connectResponsePromise;
  })();
  await runQaGatewayFixture(
    async () => {
      await response;
    },
    () => closeGatewayTestWebSocket(ws),
    async () => {
      await Promise.allSettled([opening, connectNoncePromise, connectResponsePromise]);
    },
  );
  return await response;
}

export async function startGatewayWithClient(params: {
  cfg: unknown;
  configPath: string;
  token: string;
  clientDisplayName?: string;
  scopes?: string[];
  onEvent?: (evt: { event?: string; payload?: unknown }) => void;
}) {
  const gatewayStartupEnv = captureEnv([
    ...GATEWAY_STARTUP_MUTATED_ENV_KEYS,
    "OPENCLAW_CONFIG_PATH",
  ]);
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  try {
    await writeFile(params.configPath, `${JSON.stringify(params.cfg, null, 2)}\n`);
    process.env.OPENCLAW_CONFIG_PATH = params.configPath;
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();

    const port = await getGatewayE2ePortBlock();
    const startedServer = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token: params.token },
      controlUiEnabled: false,
    });
    server = startedServer;
    const client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: params.token,
      clientDisplayName: params.clientDisplayName,
      scopes: params.scopes,
      onEvent: params.onEvent,
    });

    return {
      port,
      client,
      server: {
        startupSettled: startedServer.startupSettled,
        close: async (...args: Parameters<typeof startedServer.close>) => {
          // Failed shutdown retains selectors needed by the still-owned server.
          await startedServer.close(...args);
          gatewayStartupEnv.restore();
        },
      },
    };
  } catch (error) {
    await runQaGatewayFixture(
      async () => {
        throw error;
      },
      async () => {
        await server?.close({ reason: "gateway E2E client setup failed" });
        gatewayStartupEnv.restore();
      },
    );
    throw error;
  }
}
