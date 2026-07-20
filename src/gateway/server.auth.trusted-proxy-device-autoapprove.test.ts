import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import { writeConfigFile } from "../config/config.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { getPairedDevice, listDevicePairing } from "../infra/device-pairing.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { loggingState } from "../logging/state.js";
import { buildDeviceAuthPayloadV3 } from "./device-auth.js";
import { CONTROL_UI_CLIENT, NODE_CLIENT } from "./server.auth.test-helpers.js";
import {
  connectReq,
  installGatewayTestHooks,
  onceMessage,
  readConnectChallengeNonce,
  testState,
  trackConnectChallengeNonce,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const BROWSER_ORIGIN = "https://control.example.com";
const TRUSTED_PROXY_HEADERS = {
  origin: BROWSER_ORIGIN,
  "x-forwarded-for": "203.0.113.50",
  "x-forwarded-proto": "https",
  "x-forwarded-user": "operator@example.com",
};

function trustedProxyHeaders(declaredScopes?: string): Record<string, string> {
  return {
    ...TRUSTED_PROXY_HEADERS,
    ...(declaredScopes === undefined ? {} : { "x-openclaw-scopes": declaredScopes }),
  };
}

function deviceIdentityPath(label: string): string {
  return path.join(os.tmpdir(), `openclaw-${label}-${randomUUID()}.sqlite`);
}

async function openBrowserWs(port: number, headers: Record<string, string>): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => {
    ws.once("open", () => resolve());
  });
  return ws;
}

async function writeGatewayAuthConfig(params: {
  mode: "token" | "trusted-proxy";
  deviceAutoApprove?: { enabled?: boolean; scopes?: string[] };
}): Promise<void> {
  testState.gatewayAuth = undefined;
  await writeConfigFile({
    gateway: {
      auth:
        params.mode === "trusted-proxy"
          ? {
              mode: "trusted-proxy",
              trustedProxy: {
                userHeader: "x-forwarded-user",
                requiredHeaders: ["x-forwarded-proto"],
                allowUsers: ["operator@example.com"],
                allowLoopback: true,
                ...(params.deviceAutoApprove
                  ? { deviceAutoApprove: params.deviceAutoApprove }
                  : {}),
              },
            }
          : {
              mode: "token",
              token: "secret",
              trustedProxy: {
                userHeader: "x-forwarded-user",
                ...(params.deviceAutoApprove
                  ? { deviceAutoApprove: params.deviceAutoApprove }
                  : {}),
              },
            },
      trustedProxies: ["127.0.0.1"],
      controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
    },
  });
}

async function connectBrowser(params: {
  port: number;
  identityPath: string;
  scopes?: string[];
  token?: string;
  trustedProxy?: boolean;
  declaredProxyScopes?: string;
}) {
  const ws = await openBrowserWs(
    params.port,
    params.trustedProxy === false
      ? { origin: BROWSER_ORIGIN, "x-forwarded-for": "203.0.113.50" }
      : trustedProxyHeaders(params.declaredProxyScopes),
  );
  try {
    return await connectReq(ws, {
      ...(params.token ? { token: params.token } : { skipDefaultAuth: true }),
      ...(params.scopes === undefined ? {} : { scopes: params.scopes }),
      client: CONTROL_UI_CLIENT,
      deviceIdentityPath: params.identityPath,
    });
  } finally {
    ws.close();
  }
}

async function connectBrowserWithoutScopes(params: {
  port: number;
  identityPath: string;
  declaredProxyScopes?: string;
}): Promise<{ ok: boolean }> {
  const ws = await openBrowserWs(params.port, trustedProxyHeaders(params.declaredProxyScopes));
  try {
    const nonce = await readConnectChallengeNonce(ws);
    if (!nonce) {
      throw new Error("missing connect.challenge nonce");
    }
    const identity = loadOrCreateDeviceIdentity({ path: params.identityPath });
    const signedAt = Date.now();
    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: CONTROL_UI_CLIENT.id,
      clientMode: CONTROL_UI_CLIENT.mode,
      role: "operator",
      scopes: [],
      signedAtMs: signedAt,
      token: null,
      nonce,
      platform: CONTROL_UI_CLIENT.platform,
    });
    const id = randomUUID();
    const response = onceMessage<{ type: "res"; id: string; ok: boolean }>(
      ws,
      (message) => message.type === "res" && message.id === id,
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id,
        method: "connect",
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: CONTROL_UI_CLIENT,
          caps: [],
          commands: [],
          role: "operator",
          device: {
            id: identity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
            signature: signDevicePayload(identity.privateKeyPem, payload),
            signedAt,
            nonce,
          },
        },
      }),
    );
    return await response;
  } finally {
    ws.close();
  }
}

describe("trusted-proxy browser device auto-approval", () => {
  test("auto-approves operator.admin and warns once at startup", async () => {
    await writeGatewayAuthConfig({
      mode: "trusted-proxy",
      deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
    });
    const identityPath = deviceIdentityPath("trusted-proxy-admin");
    const identity = loadOrCreateDeviceIdentity({ path: identityPath });
    const warnings: string[] = [];
    loggingState.rawConsole = {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn((message: string) => warnings.push(message)),
      error: vi.fn(),
    };
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });

    try {
      await withGatewayServer(async ({ port }) => {
        const res = await connectBrowser({
          port,
          identityPath,
          scopes: ["operator.admin"],
        });
        expect(res.ok).toBe(true);
      });
      await withGatewayServer(async () => {}, {
        serverOptions: { auth: { mode: "token", token: "secret" } },
      });
    } finally {
      loggingState.rawConsole = null;
      resetLogger();
    }

    expect(
      warnings.filter((message) =>
        message.includes(
          "SECURITY WARNING: gateway.auth.trustedProxy.deviceAutoApprove.scopes includes operator.admin; every proxy-authenticated user can auto-approve a new browser device with full admin, and requests without scopes receive full admin automatically. Remove operator.admin to require manual approval until per-identity roles are available.",
        ),
      ),
    ).toHaveLength(1);
    const paired = await getPairedDevice(identity.deviceId);
    expect(paired?.approvedScopes).toEqual(["operator.admin"]);
    expect(paired?.tokens?.operator?.scopes).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
    ]);
    expect(paired?.approvedVia).toBe("trusted-proxy");

    expect(
      warnings.filter((message) =>
        message.includes(
          "SECURITY WARNING: gateway.auth.trustedProxy.deviceAutoApprove.scopes includes operator.admin",
        ),
      ),
    ).toHaveLength(1);
  });

  test("auto-approves a new browser device with the default scopes", async () => {
    await writeGatewayAuthConfig({
      mode: "trusted-proxy",
      deviceAutoApprove: { enabled: true },
    });
    const identityPath = deviceIdentityPath("trusted-proxy-default-scopes");
    const identity = loadOrCreateDeviceIdentity({ path: identityPath });

    await withGatewayServer(async ({ port }) => {
      const res = await connectBrowser({
        port,
        identityPath,
        scopes: ["operator.read", "operator.write", "operator.approvals"],
      });
      expect(res.ok).toBe(true);
    });

    const pairing = await listDevicePairing();
    expect(pairing.pending.filter((entry) => entry.deviceId === identity.deviceId)).toEqual([]);
    const paired = await getPairedDevice(identity.deviceId);
    expect(paired?.approvedScopes).toEqual([
      "operator.approvals",
      "operator.read",
      "operator.write",
    ]);
    expect(paired?.approvedVia).toBe("trusted-proxy");
  });

  test("caps requested scopes to the configured intersection", async () => {
    await writeGatewayAuthConfig({
      mode: "trusted-proxy",
      deviceAutoApprove: {
        enabled: true,
        scopes: ["operator.read", "operator.approvals"],
      },
    });
    const identityPath = deviceIdentityPath("trusted-proxy-scope-cap");
    const identity = loadOrCreateDeviceIdentity({ path: identityPath });

    await withGatewayServer(async ({ port }) => {
      const res = await connectBrowser({
        port,
        identityPath,
        scopes: ["operator.read", "operator.write", "operator.approvals"],
      });
      expect(res.ok).toBe(true);
    });

    const pairing = await listDevicePairing();
    expect(pairing.pending.filter((entry) => entry.deviceId === identity.deviceId)).toEqual([]);
    expect((await getPairedDevice(identity.deviceId))?.approvedScopes).toEqual([
      "operator.approvals",
      "operator.read",
    ]);
  });

  test("leaves mixed node and operator requests pending for manual approval", async () => {
    await writeGatewayAuthConfig({
      mode: "trusted-proxy",
      deviceAutoApprove: { enabled: true, scopes: ["operator.read"] },
    });
    const identityPath = deviceIdentityPath("trusted-proxy-mixed-role");
    const identity = loadOrCreateDeviceIdentity({ path: identityPath });

    await withGatewayServer(async ({ port }) => {
      const nodeWs = await openBrowserWs(port, trustedProxyHeaders());
      try {
        const nodeRes = await connectReq(nodeWs, {
          skipDefaultAuth: true,
          client: NODE_CLIENT,
          role: "node",
          scopes: [],
          deviceIdentityPath: identityPath,
        });
        expect(nodeRes.ok).toBe(false);
      } finally {
        nodeWs.close();
      }

      const browserRes = await connectBrowser({
        port,
        identityPath,
        scopes: ["operator.read"],
      });
      expect(browserRes.ok).toBe(false);
    });

    await expect(getPairedDevice(identity.deviceId)).resolves.toBeNull();
    expect(
      (await listDevicePairing()).pending.find((entry) => entry.deviceId === identity.deviceId),
    ).toMatchObject({ roles: ["node", "operator"] });
  });

  test("caps omitted scopes to the declared proxy scopes", async () => {
    await writeGatewayAuthConfig({
      mode: "trusted-proxy",
      deviceAutoApprove: {
        enabled: true,
        scopes: ["operator.read", "operator.write", "operator.approvals"],
      },
    });
    const identityPath = deviceIdentityPath("trusted-proxy-omitted-scopes-cap");
    const identity = loadOrCreateDeviceIdentity({ path: identityPath });

    await withGatewayServer(async ({ port }) => {
      const res = await connectBrowserWithoutScopes({
        port,
        identityPath,
        declaredProxyScopes: "operator.read",
      });
      expect(res.ok).toBe(true);
    });

    expect((await getPairedDevice(identity.deviceId))?.approvedScopes).toEqual(["operator.read"]);
  });

  test("caps requested scopes to the declared proxy scopes", async () => {
    await writeGatewayAuthConfig({
      mode: "trusted-proxy",
      deviceAutoApprove: {
        enabled: true,
        scopes: ["operator.read", "operator.write", "operator.approvals"],
      },
    });
    const identityPath = deviceIdentityPath("trusted-proxy-requested-scopes-cap");
    const identity = loadOrCreateDeviceIdentity({ path: identityPath });

    await withGatewayServer(async ({ port }) => {
      const res = await connectBrowser({
        port,
        identityPath,
        scopes: ["operator.read", "operator.write"],
        declaredProxyScopes: "operator.read",
      });
      expect(res.ok).toBe(true);
    });

    expect((await getPairedDevice(identity.deviceId))?.approvedScopes).toEqual(["operator.read"]);
  });

  test("keeps configured and requested scope behavior when the proxy header is absent", async () => {
    await writeGatewayAuthConfig({
      mode: "trusted-proxy",
      deviceAutoApprove: {
        enabled: true,
        scopes: ["operator.read", "operator.approvals"],
      },
    });
    const omittedIdentityPath = deviceIdentityPath("trusted-proxy-omitted-scopes-no-cap");
    const omittedIdentity = loadOrCreateDeviceIdentity({ path: omittedIdentityPath });
    const requestedIdentityPath = deviceIdentityPath("trusted-proxy-requested-scopes-no-cap");
    const requestedIdentity = loadOrCreateDeviceIdentity({ path: requestedIdentityPath });

    await withGatewayServer(async ({ port }) => {
      expect(
        (await connectBrowserWithoutScopes({ port, identityPath: omittedIdentityPath })).ok,
      ).toBe(true);
      expect(
        (
          await connectBrowser({
            port,
            identityPath: requestedIdentityPath,
            scopes: ["operator.read", "operator.write"],
          })
        ).ok,
      ).toBe(true);
    });

    expect((await getPairedDevice(omittedIdentity.deviceId))?.approvedScopes).toEqual([
      "operator.approvals",
      "operator.read",
    ]);
    expect((await getPairedDevice(requestedIdentity.deviceId))?.approvedScopes).toEqual([
      "operator.read",
    ]);
  });

  test("keeps scope upgrades on existing devices pending for manual approval", async () => {
    await writeGatewayAuthConfig({
      mode: "trusted-proxy",
      deviceAutoApprove: {
        enabled: true,
        scopes: ["operator.read", "operator.write"],
      },
    });
    const identityPath = deviceIdentityPath("trusted-proxy-scope-upgrade");
    const identity = loadOrCreateDeviceIdentity({ path: identityPath });

    await withGatewayServer(async ({ port }) => {
      const initial = await connectBrowser({ port, identityPath, scopes: ["operator.read"] });
      expect(initial.ok).toBe(true);

      const upgrade = await connectBrowser({
        port,
        identityPath,
        scopes: ["operator.read", "operator.write"],
      });
      expect(upgrade.ok).toBe(false);
      expect(upgrade.error?.message ?? "").toContain("pairing required");
    });

    const pairing = await listDevicePairing();
    const pending = pairing.pending.filter((entry) => entry.deviceId === identity.deviceId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      isRepair: true,
      scopes: ["operator.read", "operator.write"],
    });
    expect((await getPairedDevice(identity.deviceId))?.approvedScopes).toEqual(["operator.read"]);
  });

  test("leaves trusted-proxy pairing unchanged when auto-approval is disabled", async () => {
    await writeGatewayAuthConfig({ mode: "trusted-proxy" });
    const identityPath = deviceIdentityPath("trusted-proxy-disabled");
    const identity = loadOrCreateDeviceIdentity({ path: identityPath });

    await withGatewayServer(async ({ port }) => {
      const res = await connectBrowser({ port, identityPath, scopes: ["operator.read"] });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("pairing required");
    });

    const pairing = await listDevicePairing();
    expect(pairing.pending.filter((entry) => entry.deviceId === identity.deviceId)).toHaveLength(1);
    expect(await getPairedDevice(identity.deviceId)).toBeNull();
  });

  test("does not auto-approve token-authenticated browser devices", async () => {
    await writeGatewayAuthConfig({
      mode: "token",
      deviceAutoApprove: { enabled: true, scopes: ["operator.approvals"] },
    });
    const identityPath = deviceIdentityPath("token-auth-disabled");
    const identity = loadOrCreateDeviceIdentity({ path: identityPath });

    await withGatewayServer(async ({ port }) => {
      const res = await connectBrowser({
        port,
        identityPath,
        scopes: ["operator.read"],
        token: "secret",
        trustedProxy: false,
      });
      expect(res.ok).toBe(true);
    });

    const pairing = await listDevicePairing();
    expect(pairing.pending.filter((entry) => entry.deviceId === identity.deviceId)).toEqual([]);
    const paired = await getPairedDevice(identity.deviceId);
    expect(paired?.approvedScopes).toEqual(["operator.read"]);
    expect(paired?.approvedVia).not.toBe("trusted-proxy");
  });
});
