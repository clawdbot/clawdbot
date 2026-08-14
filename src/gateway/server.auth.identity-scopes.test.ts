import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { getPairedDevice, listDevicePairing } from "../infra/device-pairing.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  NODE_CLIENT,
  openTailscaleWs,
  openWs,
  rpcReq,
  testState,
  testTailscaleWhois,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const BROWSER_ORIGIN = "https://control.example.com";
const TRUSTED_PROXY_HEADERS = {
  origin: BROWSER_ORIGIN,
  "x-forwarded-for": "203.0.113.50",
  "x-forwarded-proto": "https",
  "x-forwarded-user": "admin@example.com",
};

function deviceIdentityPath(label: string): string {
  return path.join(os.tmpdir(), `openclaw-${label}-${randomUUID()}.sqlite`);
}

async function configureGatewayAuth(
  auth: GatewayAuthConfig,
  options?: { tailscaleMode?: "serve" },
): Promise<void> {
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [BROWSER_ORIGIN] };
  await writeConfigFile({
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      ...(options?.tailscaleMode ? { tailscale: { mode: options.tailscaleMode } } : {}),
      controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
    },
  });
}

function responseScopes(response: Awaited<ReturnType<typeof connectReq>>): string[] | undefined {
  return (response.payload as { auth?: { scopes?: string[] } } | undefined)?.auth?.scopes;
}

describe("gateway identity scope grants", () => {
  test("adds a case-insensitive trusted-proxy email grant without changing pairing", async () => {
    await configureGatewayAuth({
      mode: "trusted-proxy",
      identityScopes: { "admin@example.com": ["operator.admin"] },
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowLoopback: true,
      },
    });
    const identityPath = deviceIdentityPath("identity-scope-device");
    const identity = loadOrCreateDeviceIdentity({ path: identityPath });
    const configuredWorkspace = tempDirs.make("openclaw-identity-workspace-");
    const outsideWorkspace = tempDirs.make("openclaw-identity-outside-");
    testState.agentConfig = { workspace: configuredWorkspace };

    try {
      await withGatewayServer(async ({ port }) => {
        const ws = await openWs(port, {
          ...TRUSTED_PROXY_HEADERS,
          "x-forwarded-user": "Admin@Example.com",
        });
        try {
          const connected = await connectReq(ws, {
            skipDefaultAuth: true,
            prePairDevice: true,
            scopes: ["operator.write"],
            client: CONTROL_UI_CLIENT,
            deviceIdentityPath: identityPath,
            browserOrigin: BROWSER_ORIGIN,
          });
          expect(connected.ok).toBe(true);
          expect(responseScopes(connected)).toEqual(["operator.write", "operator.admin"]);
          expect((await rpcReq(ws, "set-heartbeats", { enabled: false })).ok).toBe(true);

          const browse = await rpcReq<{ path?: string }>(ws, "fs.listDir", {
            path: outsideWorkspace,
          });
          expect(browse.ok, JSON.stringify(browse.error)).toBe(true);
          expect(browse.payload?.path).toBe(outsideWorkspace);
        } finally {
          ws.close();
        }
      });
    } finally {
      testState.agentConfig = undefined;
    }

    expect((await getPairedDevice(identity.deviceId))?.approvedScopes).toEqual(["operator.write"]);
    expect(
      (await listDevicePairing()).pending.filter((entry) => entry.deviceId === identity.deviceId),
    ).toEqual([]);
  });

  test("applies a trusted-proxy grant after clearing device-less declared scopes", async () => {
    await configureGatewayAuth({
      mode: "trusted-proxy",
      identityScopes: { "admin@example.com": ["operator.admin"] },
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowLoopback: true,
      },
    });

    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, TRUSTED_PROXY_HEADERS);
      try {
        const connected = await connectReq(ws, {
          skipDefaultAuth: true,
          scopes: ["operator.read"],
          device: null,
          client: CONTROL_UI_CLIENT,
        });
        expect(connected.ok).toBe(true);
        expect(responseScopes(connected)).toEqual(["operator.admin"]);
      } finally {
        ws.close();
      }
    });
  });

  test.each([
    { configuredIdentity: "peter", verifiedIdentity: "peter", expectedAdmin: true },
    { configuredIdentity: "Peter", verifiedIdentity: "peter", expectedAdmin: false },
  ])(
    "matches a verified Tailscale identity exactly ($configuredIdentity)",
    async ({ configuredIdentity, verifiedIdentity, expectedAdmin }) => {
      await configureGatewayAuth(
        {
          mode: "token",
          token: "secret",
          allowTailscale: true,
          identityScopes: { [configuredIdentity]: ["operator.admin"] },
        },
        { tailscaleMode: "serve" },
      );
      testTailscaleWhois.value = { login: verifiedIdentity, name: "Peter" };

      await withGatewayServer(async ({ server }) => {
        const endpoint = server.getTailscaleIngressEndpoint();
        if (!endpoint) {
          throw new Error("expected managed Tailscale listener");
        }
        const ws = await openTailscaleWs(endpoint, {
          origin: BROWSER_ORIGIN,
          "tailscale-user-login": verifiedIdentity,
        });
        try {
          const connected = await connectReq(ws, {
            skipDefaultAuth: true,
            prePairDevice: true,
            scopes: ["operator.read"],
            client: CONTROL_UI_CLIENT,
            deviceIdentityPath: deviceIdentityPath("identity-scope-tailscale"),
            browserOrigin: BROWSER_ORIGIN,
          });
          expect(connected.ok).toBe(true);
          expect(responseScopes(connected)).toEqual(
            expectedAdmin ? ["operator.read", "operator.admin"] : ["operator.read"],
          );
        } finally {
          ws.close();
        }
      });
    },
  );

  test("caps the device and identity scope union", async () => {
    await configureGatewayAuth({
      mode: "trusted-proxy",
      identityScopes: {
        "admin@example.com": ["operator.admin", "operator.read"],
      },
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowLoopback: true,
      },
    });

    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, {
        ...TRUSTED_PROXY_HEADERS,
        "x-openclaw-scopes": "operator.read",
      });
      try {
        const connected = await connectReq(ws, {
          skipDefaultAuth: true,
          prePairDevice: true,
          scopes: ["operator.read"],
          client: CONTROL_UI_CLIENT,
          deviceIdentityPath: deviceIdentityPath("identity-scope-cap"),
          browserOrigin: BROWSER_ORIGIN,
        });
        expect(connected.ok).toBe(true);
        expect(responseScopes(connected)).toEqual(["operator.read"]);
        expect((await rpcReq(ws, "status")).ok).toBe(true);
        expect((await rpcReq(ws, "set-heartbeats", { enabled: false })).ok).toBe(false);
      } finally {
        ws.close();
      }
    });
  });

  test("caps a broader reconnect before device scope-upgrade comparison", async () => {
    await configureGatewayAuth({
      mode: "trusted-proxy",
      identityScopes: { "admin@example.com": ["operator.admin"] },
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowLoopback: true,
      },
    });
    const identityPath = deviceIdentityPath("identity-scope-reconnect-cap");
    const identity = loadOrCreateDeviceIdentity({ path: identityPath });

    await withGatewayServer(async ({ port }) => {
      const initialWs = await openWs(port, TRUSTED_PROXY_HEADERS);
      try {
        const initial = await connectReq(initialWs, {
          skipDefaultAuth: true,
          prePairDevice: true,
          scopes: ["operator.read"],
          client: CONTROL_UI_CLIENT,
          deviceIdentityPath: identityPath,
          browserOrigin: BROWSER_ORIGIN,
        });
        expect(initial.ok).toBe(true);
      } finally {
        initialWs.close();
      }

      const reconnectWs = await openWs(port, {
        ...TRUSTED_PROXY_HEADERS,
        "x-openclaw-scopes": "operator.read",
      });
      try {
        const reconnect = await connectReq(reconnectWs, {
          skipDefaultAuth: true,
          prePairDevice: false,
          scopes: ["operator.read", "operator.write"],
          client: CONTROL_UI_CLIENT,
          deviceIdentityPath: identityPath,
          browserOrigin: BROWSER_ORIGIN,
        });
        expect(reconnect.ok).toBe(true);
        expect(responseScopes(reconnect)).toEqual(["operator.read"]);
      } finally {
        reconnectWs.close();
      }
    });

    expect((await getPairedDevice(identity.deviceId))?.approvedScopes).toEqual(["operator.read"]);
    expect(
      (await listDevicePairing()).pending.filter((entry) => entry.deviceId === identity.deviceId),
    ).toEqual([]);
  });

  test.each([
    {
      name: "token",
      auth: { mode: "token", token: "secret" } satisfies GatewayAuthConfig,
      connectAuth: { token: "secret" },
    },
    {
      name: "password",
      auth: { mode: "password", password: "secret" } satisfies GatewayAuthConfig,
      connectAuth: { password: "secret" },
    },
    {
      name: "no auth",
      auth: { mode: "none" } satisfies GatewayAuthConfig,
      connectAuth: { skipDefaultAuth: true },
    },
  ])("does not trust an identity header with $name", async ({ auth, connectAuth }) => {
    await configureGatewayAuth({
      ...auth,
      identityScopes: { "admin@example.com": ["operator.admin"] },
    });

    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, TRUSTED_PROXY_HEADERS);
      try {
        const connected = await connectReq(ws, {
          ...connectAuth,
          prePairDevice: true,
          scopes: ["operator.read"],
          client: CONTROL_UI_CLIENT,
          deviceIdentityPath: deviceIdentityPath(`identity-scope-${auth.mode}`),
          browserOrigin: BROWSER_ORIGIN,
        });
        expect(connected.ok).toBe(true);
        expect(responseScopes(connected)).toEqual(["operator.read"]);
      } finally {
        ws.close();
      }
    });
  });

  test("does not grant operator scopes to node connections", async () => {
    await configureGatewayAuth({
      mode: "trusted-proxy",
      identityScopes: { "admin@example.com": ["operator.admin"] },
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowLoopback: true,
      },
    });

    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, TRUSTED_PROXY_HEADERS);
      try {
        const connected = await connectReq(ws, {
          skipDefaultAuth: true,
          prePairDevice: true,
          role: "node",
          scopes: [],
          client: NODE_CLIENT,
          deviceIdentityPath: deviceIdentityPath("identity-scope-node"),
        });
        expect(connected.ok).toBe(true);
        expect(responseScopes(connected)).toEqual([]);
      } finally {
        ws.close();
      }
    });
  });
});
