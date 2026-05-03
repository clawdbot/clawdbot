import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  loadGatewayConfig,
  openAuthenticatedGatewayWs,
  waitForGatewayWsClose,
} from "./shared-auth.test-helpers.js";
import {
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  rpcReq,
  startGatewayServer,
  testState,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const ORIGINAL_GATEWAY_AUTH = testState.gatewayAuth;
const ORIGINAL_GATEWAY_TOKEN_ENV = process.env.OPENCLAW_GATEWAY_TOKEN;
const OLD_TOKEN = "shared-token-old";
const NEW_TOKEN = "shared-token-new";
const DEFERRED_RESTART_DELAY_MS = 1_000;
const SECRET_REF_TOKEN_ID = "OPENCLAW_SHARED_AUTH_ROTATION_SECRET_REF";

let port = 0;

afterAll(() => {
  testState.gatewayAuth = ORIGINAL_GATEWAY_AUTH;
  if (ORIGINAL_GATEWAY_TOKEN_ENV === undefined) {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  } else {
    process.env.OPENCLAW_GATEWAY_TOKEN = ORIGINAL_GATEWAY_TOKEN_ENV;
  }
});

async function openDeviceTokenWs(): Promise<WebSocket> {
  const identityPath = path.join(os.tmpdir(), `openclaw-shared-auth-${process.pid}-${port}.json`);
  const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } =
    await import("../infra/device-identity.js");
  const { approveDevicePairing, requestDevicePairing, rotateDeviceToken } =
    await import("../infra/device-pairing.js");

  const identity = loadOrCreateDeviceIdentity(identityPath);
  const pending = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    clientId: "test",
    clientMode: "test",
    role: "operator",
    scopes: ["operator.admin"],
  });
  await approveDevicePairing(pending.request.requestId, {
    callerScopes: ["operator.admin"],
  });
  const rotated = await rotateDeviceToken({
    deviceId: identity.deviceId,
    role: "operator",
    scopes: ["operator.admin"],
  });
  expect(rotated.ok).toBe(true);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  await connectOk(ws, {
    skipDefaultAuth: true,
    deviceIdentityPath: identityPath,
    deviceToken: rotated.ok ? rotated.entry.token : "",
    scopes: ["operator.admin"],
  });
  return ws;
}

async function closeWsAndWait(ws: WebSocket, timeoutMs = 2_000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      ws.off("close", onClose);
      resolve();
    }, timeoutMs);
    ws.once("close", onClose);
    try {
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    } catch {
      clearTimeout(timer);
      ws.off("close", onClose);
      resolve();
    }
  });
}

async function sendSharedTokenRotationPatch(ws: WebSocket): Promise<{ ok: boolean }> {
  const current = await loadGatewayConfig(ws);
  return await rpcReq(ws, "config.patch", {
    baseHash: current.hash,
    raw: JSON.stringify({ gateway: { auth: { token: NEW_TOKEN } } }),
    restartDelayMs: DEFERRED_RESTART_DELAY_MS,
  });
}

async function applyCurrentConfig(ws: WebSocket) {
  const current = await loadGatewayConfig(ws);
  return await rpcReq(ws, "config.apply", {
    baseHash: current.hash,
    raw: JSON.stringify(current.config, null, 2),
  });
}

describe("gateway shared auth rotation", () => {
  let server: Awaited<ReturnType<typeof startGatewayServer>>;

  beforeAll(async () => {
    port = await getFreePort();
    testState.gatewayAuth = { mode: "token", token: OLD_TOKEN };
    server = await startGatewayServer(port, { controlUiEnabled: true });
  });

  beforeEach(() => {
    testState.gatewayAuth = { mode: "token", token: OLD_TOKEN };
  });

  afterAll(async () => {
    await server.close();
  });

  it("disconnects existing shared-token websocket sessions after config.patch rotates auth", async () => {
    const ws = await openAuthenticatedGatewayWs(port, OLD_TOKEN);
    try {
      const closed = waitForGatewayWsClose(ws);
      const res = await sendSharedTokenRotationPatch(ws);

      expect(res.ok).toBe(true);
      await expect(closed).resolves.toMatchObject({
        code: 4001,
        reason: "gateway auth changed",
      });
    } finally {
      await closeWsAndWait(ws);
    }
  });

  it("keeps existing device-token websocket sessions connected after shared token rotation", async () => {
    const ws = await openDeviceTokenWs();
    try {
      const res = await sendSharedTokenRotationPatch(ws);
      expect(res.ok).toBe(true);

      const followUp = await rpcReq<{ hash?: string }>(ws, "config.get", {});
      expect(followUp.ok).toBe(true);
      expect(typeof followUp.payload?.hash).toBe("string");
    } finally {
      await closeWsAndWait(ws);
    }
  });
});

describe("gateway shared auth rotation with unchanged SecretRefs", () => {
  let secretRefServer: Awaited<ReturnType<typeof startGatewayServer>>;
  let secretRefPort = 0;

  beforeAll(async () => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
    }
    secretRefPort = await getFreePort();
    testState.gatewayAuth = undefined;
    process.env[SECRET_REF_TOKEN_ID] = OLD_TOKEN;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          gateway: {
            auth: {
              mode: "token",
              token: { source: "env", provider: "default", id: SECRET_REF_TOKEN_ID },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    secretRefServer = await startGatewayServer(secretRefPort, { controlUiEnabled: true });
  });

  beforeEach(() => {
    testState.gatewayAuth = undefined;
    process.env[SECRET_REF_TOKEN_ID] = OLD_TOKEN;
  });

  afterAll(async () => {
    delete process.env[SECRET_REF_TOKEN_ID];
    testState.gatewayAuth = ORIGINAL_GATEWAY_AUTH;
    await secretRefServer.close();
  });

  async function openSecretRefAuthenticatedWs(): Promise<WebSocket> {
    return openAuthenticatedGatewayWs(secretRefPort, OLD_TOKEN);
  }

  it("disconnects shared-auth websocket sessions when config.apply rewrites a SecretRef token", async () => {
    const ws = await openSecretRefAuthenticatedWs();
    try {
      const closed = waitForGatewayWsClose(ws, 30_000);
      process.env[SECRET_REF_TOKEN_ID] = NEW_TOKEN;
      const res = await applyCurrentConfig(ws);
      expect(res.ok).toBe(true);
      await expect(closed).resolves.toEqual({
        code: 4001,
        reason: "gateway auth changed",
      });
    } finally {
      await closeWsAndWait(ws);
    }
  });
});
