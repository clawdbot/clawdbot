import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { WebSocket } from "ws";
import { withEnvAsync } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import { MIN_PROBE_PROTOCOL_VERSION, PROTOCOL_VERSION } from "./protocol/index.js";
import {
  createGatewaySuiteHarness,
  connectReq,
  getTrackedConnectChallengeNonce,
  getFreePort,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startGatewayServer,
  startServer,
  startServerWithClient,
  trackConnectChallengeNonce,
  testTailscaleWhois,
  testState,
  withGatewayServer,
} from "./test-helpers.js";

let authIdentityPathSeq = 0;

function nextAuthIdentityPath(prefix: string): string {
  const poolId = process.env.VITEST_POOL_ID ?? "0";
  const fileName =
    prefix +
    "-" +
    String(process.pid) +
    "-" +
    poolId +
    "-" +
    String(authIdentityPathSeq++) +
    ".json";
  return path.join(os.tmpdir(), fileName);
}

async function waitForWsClose(ws: WebSocket, timeoutMs: number): Promise<boolean> {
  if (ws.readyState === WebSocket.CLOSED) {
    return true;
  }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(ws.readyState === WebSocket.CLOSED), timeoutMs);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const openWs = async (port: number, headers?: Record<string, string>) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, headers ? { headers } : undefined);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  return ws;
};

const readConnectChallengeNonce = async (ws: WebSocket) => {
  const cached = getTrackedConnectChallengeNonce(ws);
  if (cached) {
    return cached;
  }
  const challenge: {
    type?: string;
    event?: string;
    payload?: Record<string, unknown> | null;
  } = await onceMessage(ws, (o) => o.type === "event" && o.event === "connect.challenge");
  const nonce = (challenge.payload as { nonce?: unknown } | undefined)?.nonce;
  expect(typeof nonce).toBe("string");
  return String(nonce);
};

const openTailscaleWs = async (port: number, headers?: Record<string, string>) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: {
      "x-forwarded-for": "100.64.0.1",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "gateway.tailnet.ts.net",
      "tailscale-user-login": "peter",
      "tailscale-user-name": "Peter",
      ...headers,
    },
  });
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  return ws;
};

const originForPort = (port: number) => `http://127.0.0.1:${port}`;

function restoreGatewayToken(prevToken: string | undefined) {
  if (prevToken === undefined) {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  } else {
    process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
  }
}

async function withRuntimeVersionEnv<T>(
  env: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  return withEnvAsync(env, run);
}

const TEST_OPERATOR_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.TEST,
  version: "1.0.0",
  platform: "test",
  mode: GATEWAY_CLIENT_MODES.TEST,
};

const CONTROL_UI_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
  version: "1.0.0",
  platform: "web",
  mode: GATEWAY_CLIENT_MODES.WEBCHAT,
};

const TRUSTED_PROXY_CONTROL_UI_HEADERS = {
  origin: "https://localhost",
  "x-forwarded-for": "203.0.113.10",
  "x-forwarded-proto": "https",
  "x-forwarded-user": "peter@example.com",
} as const;

const NODE_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.NODE_HOST,
  version: "1.0.0",
  platform: "test",
  mode: GATEWAY_CLIENT_MODES.NODE,
};

const BACKEND_GATEWAY_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  version: "1.0.0",
  platform: "node",
  mode: GATEWAY_CLIENT_MODES.BACKEND,
};

async function expectHelloOkServerVersion(port: number, expectedVersion: string) {
  const ws = await openWs(port);
  try {
    const res = await connectReq(ws);
    expect(res.ok).toBe(true);
    const payload = res.payload as
      | {
          type?: unknown;
          server?: { version?: string };
        }
      | undefined;
    expect(payload?.type).toBe("hello-ok");
    expect(payload?.server?.version).toBe(expectedVersion);
  } finally {
    ws.close();
  }
}

async function createSignedDevice(params: {
  token?: string | null;
  scopes: string[];
  clientId: string;
  clientMode: string;
  role?: "operator" | "node";
  identityPath?: string;
  nonce: string;
  signedAtMs?: number;
}) {
  const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
    await import("../infra/device-identity.js");
  const identity = params.identityPath
    ? loadOrCreateDeviceIdentity(params.identityPath)
    : loadOrCreateDeviceIdentity();
  const signedAtMs = params.signedAtMs ?? Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: params.clientId,
    clientMode: params.clientMode,
    role: params.role ?? "operator",
    scopes: params.scopes,
    signedAtMs,
    token: params.token ?? null,
    nonce: params.nonce,
  });
  return {
    identity,
    signedAtMs,
    device: {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      signature: signDevicePayload(identity.privateKeyPem, payload),
      signedAt: signedAtMs,
      nonce: params.nonce,
    },
  };
}

function resolveGatewayTokenOrEnv(): string {
  const token =
    typeof (testState.gatewayAuth as { token?: unknown } | undefined)?.token === "string"
      ? ((testState.gatewayAuth as { token?: string }).token ?? undefined)
      : process.env.OPENCLAW_GATEWAY_TOKEN;
  if (typeof token !== "string") {
    throw new Error("expected gateway token in test state or OPENCLAW_GATEWAY_TOKEN");
  }
  return token;
}

async function approvePendingPairingIfNeeded() {
  const { approveDevicePairing, listDevicePairing } = await import("../infra/device-pairing.js");
  const list = await listDevicePairing();
  const pending = list.pending.at(0);
  if (!pending?.requestId) {
    throw new Error("expected pending pairing request");
  }
  await approveDevicePairing(pending.requestId, {
    callerScopes: pending.scopes ?? ["operator.admin"],
  });
}

async function configureTrustedProxyControlUiAuth() {
  const { replaceConfigFile } = await import("../config/config.js");
  testState.gatewayAuth = undefined;
  testState.gatewayControlUi = {
    ...testState.gatewayControlUi,
    allowedOrigins: ["https://localhost"],
  };
  await replaceConfigFile({
    nextConfig: {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto"],
          },
        },
        trustedProxies: ["127.0.0.1"],
        controlUi: {
          allowedOrigins: ["https://localhost"],
        },
      },
    },
    afterWrite: { mode: "auto" },
  });
}

async function writeTrustedProxyControlUiConfig(params?: { allowInsecureAuth?: boolean }) {
  const { replaceConfigFile } = await import("../config/config.js");
  const nextConfig = {
    gateway: {
      trustedProxies: ["127.0.0.1"],
      controlUi: {
        allowedOrigins: ["https://localhost"],
        ...(params?.allowInsecureAuth ? { allowInsecureAuth: true } : {}),
      },
    },
  };
  await replaceConfigFile({
    nextConfig,
    afterWrite: { mode: "auto" },
  });
}

function isConnectResMessage(id: string) {
  return (o: unknown) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) {
      return false;
    }
    const rec = o as Record<string, unknown>;
    return rec.type === "res" && rec.id === id;
  };
}

async function sendRawConnectReq(
  ws: WebSocket,
  params: {
    id: string;
    token?: string;
    device: { id: string; publicKey: string; signature: string; signedAt: number; nonce?: string };
  },
) {
  ws.send(
    JSON.stringify({
      type: "req",
      id: params.id,
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: TEST_OPERATOR_CLIENT,
        caps: [],
        role: "operator",
        auth: params.token ? { token: params.token } : undefined,
        device: params.device,
      },
    }),
  );
  const response: {
    type?: string;
    id?: string;
    ok?: boolean;
    payload?: Record<string, unknown> | null;
    error?: {
      message?: string;
      details?: {
        code?: string;
        reason?: string;
      };
    };
  } = await onceMessage(ws, isConnectResMessage(params.id));
  return response;
}

async function resolvePairedTokenForDeviceIdentityPath(deviceIdentityPath: string): Promise<{
  identity: { deviceId: string };
  deviceToken: string;
}> {
  const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
  const { getPairedDevice } = await import("../infra/device-pairing.js");

  const identity = loadOrCreateDeviceIdentity(deviceIdentityPath);
  const paired = await getPairedDevice(identity.deviceId);
  const deviceToken = paired?.tokens?.operator?.token;
  expect(paired?.deviceId).toBe(identity.deviceId);
  if (!deviceToken) {
    throw new Error(`expected operator token for paired device ${identity.deviceId}`);
  }
  return { identity: { deviceId: identity.deviceId }, deviceToken };
}

async function startRateLimitedTokenServerWithPairedDeviceToken() {
  testState.gatewayAuth = {
    mode: "token",
    token: "secret",
    rateLimit: { maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000, exemptLoopback: false },
  } satisfies Record<string, unknown>;

  const { server, ws, port, prevToken } = await startServerWithClient(undefined, {
    controlUiEnabled: true,
  });
  const deviceIdentityPath = nextAuthIdentityPath("openclaw-auth-rate-limit");
  try {
    const initial = await connectReq(ws, { token: "secret", deviceIdentityPath });
    if (!initial.ok) {
      await approvePendingPairingIfNeeded();
    }
    const { deviceToken } = await resolvePairedTokenForDeviceIdentityPath(deviceIdentityPath);

    ws.close();
    return { server, port, prevToken, deviceToken: deviceToken ?? "", deviceIdentityPath };
  } catch (err) {
    ws.close();
    await server.close();
    restoreGatewayToken(prevToken);
    throw err;
  }
}

async function ensurePairedDeviceTokenForCurrentIdentity(ws: WebSocket): Promise<{
  identity: { deviceId: string };
  deviceToken: string;
  deviceIdentityPath: string;
}> {
  const deviceIdentityPath = nextAuthIdentityPath("openclaw-auth-device");

  const res = await connectReq(ws, { token: "secret", deviceIdentityPath });
  if (!res.ok) {
    await approvePendingPairingIfNeeded();
  }
  const { identity, deviceToken } =
    await resolvePairedTokenForDeviceIdentityPath(deviceIdentityPath);
  return {
    identity,
    deviceToken,
    deviceIdentityPath,
  };
}

export {
  approvePendingPairingIfNeeded,
  BACKEND_GATEWAY_CLIENT,
  buildDeviceAuthPayload,
  configureTrustedProxyControlUiAuth,
  connectReq,
  CONTROL_UI_CLIENT,
  createSignedDevice,
  createGatewaySuiteHarness,
  ensurePairedDeviceTokenForCurrentIdentity,
  expectHelloOkServerVersion,
  getFreePort,
  getTrackedConnectChallengeNonce,
  installGatewayTestHooks,
  MIN_PROBE_PROTOCOL_VERSION,
  NODE_CLIENT,
  onceMessage,
  openTailscaleWs,
  openWs,
  originForPort,
  readConnectChallengeNonce,
  resolveGatewayTokenOrEnv,
  restoreGatewayToken,
  rpcReq,
  sendRawConnectReq,
  startGatewayServer,
  startRateLimitedTokenServerWithPairedDeviceToken,
  startServer,
  startServerWithClient,
  TEST_OPERATOR_CLIENT,
  trackConnectChallengeNonce,
  TRUSTED_PROXY_CONTROL_UI_HEADERS,
  testState,
  testTailscaleWhois,
  waitForWsClose,
  withGatewayServer,
  withRuntimeVersionEnv,
  writeTrustedProxyControlUiConfig,
};
export { ConnectErrorDetailCodes } from "./protocol/connect-error-details.js";
export { getPreauthHandshakeTimeoutMsFromEnv } from "./handshake-timeouts.js";
export { PROTOCOL_VERSION } from "./protocol/index.js";
export { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
