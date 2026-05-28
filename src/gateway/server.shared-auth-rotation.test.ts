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

async function openDeviceTokenWsWithDetails(
  params: { issuerGeneration?: string; browserClient?: boolean } = {},
): Promise<{
  ws: WebSocket;
  deviceId: string;
  hello: Awaited<ReturnType<typeof connectOk>> & {
    auth?: { deviceToken?: unknown };
  };
}> {
  const identityPath = path.join(os.tmpdir(), `openclaw-shared-auth-${process.pid}-${port}.json`);
  const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } =
    await import("../infra/device-identity.js");
  const { approveDevicePairing, ensureDeviceToken, requestDevicePairing, rotateDeviceToken } =
    await import("../infra/device-pairing.js");
  const client = params.browserClient
    ? {
        id: "openclaw-control-ui",
        version: "1.0.0",
        platform: "test",
        mode: "webchat",
      }
    : {
        id: "test",
        version: "1.0.0",
        platform: "test",
        mode: "test",
      };

  const identity = loadOrCreateDeviceIdentity(identityPath);
  const pending = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    clientId: client.id,
    clientMode: client.mode,
    role: "operator",
    scopes: ["operator.admin"],
  });
  await approveDevicePairing(pending.request.requestId, {
    callerScopes: ["operator.admin"],
  });
  let issuedDeviceToken = "";
  if (params.issuerGeneration) {
    const deviceToken = await ensureDeviceToken({
      deviceId: identity.deviceId,
      role: "operator",
      scopes: ["operator.admin"],
      issuer: {
        kind: "shared-gateway-auth",
        generation: params.issuerGeneration,
      },
    });
    expect(deviceToken?.token).toBeTypeOf("string");
    issuedDeviceToken = deviceToken?.token ?? "";
  } else {
    const rotated = await rotateDeviceToken({
      deviceId: identity.deviceId,
      role: "operator",
      scopes: ["operator.admin"],
    });
    expect(rotated.ok).toBe(true);
    issuedDeviceToken = rotated.ok ? rotated.entry.token : "";
  }

  const ws = new WebSocket(
    `ws://127.0.0.1:${port}`,
    params.browserClient ? { headers: { origin: `http://127.0.0.1:${port}` } } : undefined,
  );
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  const hello = (await connectOk(ws, {
    skipDefaultAuth: true,
    client,
    deviceIdentityPath: identityPath,
    deviceToken: issuedDeviceToken,
    scopes: ["operator.admin"],
  })) as Awaited<ReturnType<typeof connectOk>> & {
    auth?: { deviceToken?: unknown };
  };
  return { ws, deviceId: identity.deviceId, hello };
}

async function openDeviceTokenWs(params: { issuerGeneration?: string } = {}): Promise<WebSocket> {
  const { ws } = await openDeviceTokenWsWithDetails(params);
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
      await expect(closed).resolves.toEqual({
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

  it("disconnects issuer-tagged device-token websocket sessions after shared token rotation", async () => {
    const { resolveSharedGatewaySessionGeneration } =
      await import("./server/ws-shared-generation.js");
    const issuerGeneration = resolveSharedGatewaySessionGeneration({
      mode: "token",
      token: OLD_TOKEN,
      allowTailscale: false,
    });
    expect(issuerGeneration).toBeTypeOf("string");
    if (!issuerGeneration) {
      throw new Error("expected shared gateway generation");
    }
    const ws = await openDeviceTokenWs({
      issuerGeneration,
    });
    try {
      const closed = waitForGatewayWsClose(ws);
      const res = await sendSharedTokenRotationPatch(ws);

      expect(res.ok).toBe(true);
      await expect(closed).resolves.toEqual({
        code: 4001,
        reason: "gateway auth changed",
      });
    } finally {
      await closeWsAndWait(ws);
    }
  });

  it("preserves issuer-tagged browser device tokens on reconnect", async () => {
    const { getPairedDevice, verifyDeviceToken } = await import("../infra/device-pairing.js");
    const { resolveSharedGatewaySessionGeneration } =
      await import("./server/ws-shared-generation.js");
    const issuerGeneration = resolveSharedGatewaySessionGeneration({
      mode: "token",
      token: OLD_TOKEN,
      allowTailscale: false,
    });
    expect(issuerGeneration).toBeTypeOf("string");
    if (!issuerGeneration) {
      throw new Error("expected shared gateway generation");
    }
    const { ws, deviceId, hello } = await openDeviceTokenWsWithDetails({
      issuerGeneration,
      browserClient: true,
    });
    try {
      const helloDeviceToken = hello.auth?.deviceToken;
      if (typeof helloDeviceToken !== "string") {
        throw new Error("expected hello device token");
      }
      const paired = await getPairedDevice(deviceId);
      expect(paired?.tokens?.operator?.issuer).toEqual({
        kind: "shared-gateway-auth",
        generation: issuerGeneration,
      });
      await expect(
        verifyDeviceToken({
          deviceId,
          token: helloDeviceToken,
          role: "operator",
          scopes: ["operator.admin"],
          requiredSharedGatewaySessionGeneration: issuerGeneration,
        }),
      ).resolves.toEqual({
        ok: true,
        issuer: {
          kind: "shared-gateway-auth",
          generation: issuerGeneration,
        },
      });
    } finally {
      await closeWsAndWait(ws);
    }
  });

  it("keeps issuer metadata when tagged device tokens reconnect through non-browser clients", async () => {
    const { getPairedDevice, verifyDeviceToken } = await import("../infra/device-pairing.js");
    const { resolveSharedGatewaySessionGeneration } =
      await import("./server/ws-shared-generation.js");
    const issuerGeneration = resolveSharedGatewaySessionGeneration({
      mode: "token",
      token: OLD_TOKEN,
      allowTailscale: false,
    });
    expect(issuerGeneration).toBeTypeOf("string");
    if (!issuerGeneration) {
      throw new Error("expected shared gateway generation");
    }
    const { ws, deviceId, hello } = await openDeviceTokenWsWithDetails({
      issuerGeneration,
    });
    try {
      const helloDeviceToken = hello.auth?.deviceToken;
      if (typeof helloDeviceToken !== "string") {
        throw new Error("expected hello device token");
      }
      const paired = await getPairedDevice(deviceId);
      expect(paired?.tokens?.operator?.issuer).toEqual({
        kind: "shared-gateway-auth",
        generation: issuerGeneration,
      });
      await expect(
        verifyDeviceToken({
          deviceId,
          token: helloDeviceToken,
          role: "operator",
          scopes: ["operator.admin"],
          requiredSharedGatewaySessionGeneration: issuerGeneration,
        }),
      ).resolves.toEqual({
        ok: true,
        issuer: {
          kind: "shared-gateway-auth",
          generation: issuerGeneration,
        },
      });
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
