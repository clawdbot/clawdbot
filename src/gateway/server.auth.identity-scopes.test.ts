import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import type { GatewayAuthConfig, GatewayOperatorRolesConfig } from "../config/types.gateway.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { getPairedDevice, listDevicePairing } from "../infra/device-pairing.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import type { OperatorScope } from "./operator-scopes.js";
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
const NARROW_SCOPES = ["operator.read", "operator.write", "operator.talk"];
const UPGRADE_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
];

function deviceIdentityPath(label: string): string {
  return path.join(tempDirs.make("openclaw-identity-scopes-"), `${label}.sqlite`);
}

async function configureGatewayAuth(
  auth: GatewayAuthConfig,
  options?: { tailscaleMode?: "serve"; roles?: GatewayOperatorRolesConfig },
): Promise<void> {
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [BROWSER_ORIGIN] };
  await writeConfigFile({
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      ...(options?.tailscaleMode ? { tailscale: { mode: options.tailscaleMode } } : {}),
      ...(options?.roles ? { roles: options.roles } : {}),
      controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
    },
  });
}

function responseScopes(response: Awaited<ReturnType<typeof connectReq>>): string[] | undefined {
  return (response.payload as { auth?: { scopes?: string[] } } | undefined)?.auth?.scopes;
}

describe("gateway identity scope grants", () => {
  test.each([
    {
      label: "unassigned default guest",
      assignedRole: undefined,
      expectedScopes: ["operator.read", "operator.write"],
    },
    {
      label: "assigned maintainer",
      assignedRole: "maintainer",
      expectedScopes: ["operator.read", "operator.write", "operator.admin"],
    },
    {
      label: "admin-only without identity grants",
      assignedRole: "admin-only",
      identityScopes: [],
      deviceScopes: NARROW_SCOPES,
      expectedScopes: NARROW_SCOPES,
    },
    {
      label: "write-only with broader identity grants",
      assignedRole: "write-only",
      identityScopes: [
        "operator.admin",
        "operator.approvals",
        "operator.talk.secrets",
      ] satisfies OperatorScope[],
      deviceScopes: NARROW_SCOPES,
      expectedScopes: NARROW_SCOPES,
    },
    {
      label: "empty",
      assignedRole: "denied",
      deviceScopes: NARROW_SCOPES,
      expectedScopes: [],
    },
  ])("applies the $label role ceiling after device and identity grants", async (scenario) => {
    const identityScopes: OperatorScope[] = scenario.identityScopes ?? ["operator.admin"];
    await configureGatewayAuth(
      {
        mode: "trusted-proxy",
        identityScopes: { "admin@example.com": identityScopes },
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowLoopback: true,
        },
      },
      {
        roles: {
          default: "guest",
          definitions: {
            guest: {
              sessions: { others: "view" },
              agents: "*",
              scopes: ["operator.read", "operator.write"],
            },
            maintainer: {
              sessions: { others: "write" },
              agents: "*",
              scopes: ["operator.read", "operator.write", "operator.admin"],
            },
            "admin-only": {
              sessions: { others: "write" },
              agents: "*",
              scopes: ["operator.admin"],
            },
            "write-only": {
              sessions: { others: "write" },
              agents: "*",
              scopes: ["operator.write"],
            },
            denied: { sessions: { others: "none" }, agents: [], scopes: [] },
          },
        },
      },
    );
    const profile = ensureProfileForEmail("admin@example.com");
    if (scenario.assignedRole) {
      setUserProfileRole(profile.id, scenario.assignedRole);
    }

    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, TRUSTED_PROXY_HEADERS);
      try {
        const connected = await connectReq(ws, {
          skipDefaultAuth: true,
          prePairDevice: true,
          scopes: scenario.deviceScopes ?? ["operator.read", "operator.write"],
          client: CONTROL_UI_CLIENT,
          deviceIdentityPath: deviceIdentityPath(`identity-role-${scenario.label}`),
          browserOrigin: BROWSER_ORIGIN,
        });
        expect(connected.ok).toBe(true);
        expect((await rpcReq(ws, "status")).ok).toBe(scenario.expectedScopes.length > 0);
        expect(responseScopes(connected)).toEqual(scenario.expectedScopes);
        expect((connected.payload as { auth?: { deviceToken?: string } }).auth?.deviceToken).toBe(
          undefined,
        );
        expect((await rpcReq(ws, "set-heartbeats", { enabled: false })).ok).toBe(
          scenario.assignedRole === "maintainer",
        );
        if (!scenario.assignedRole) {
          const upgrade = await rpcReq(ws, "device.scopes.requestUpgrade", {
            scopes: ["operator.read", "operator.write", "operator.admin"],
          });
          expect(upgrade).toMatchObject({
            ok: false,
            error: {
              code: "INVALID_REQUEST",
              message: expect.stringContaining("assigned operator role"),
            },
          });
        }
        if (scenario.assignedRole === "admin-only") {
          const admin = await openWs(port, TRUSTED_PROXY_HEADERS);
          try {
            const adminConnected = await connectReq(admin, {
              skipDefaultAuth: true,
              prePairDevice: true,
              scopes: ["operator.admin"],
              client: CONTROL_UI_CLIENT,
              deviceIdentityPath: deviceIdentityPath("scope-upgrade-approver"),
              browserOrigin: BROWSER_ORIGIN,
            });
            expect(adminConnected.ok).toBe(true);
            expect(
              (adminConnected.payload as { auth?: { deviceToken?: string } }).auth?.deviceToken,
            ).toBeUndefined();
            const registration = await rpcReq<{ requestId: string }>(
              ws,
              "device.scopes.requestUpgrade",
              {
                scopes: UPGRADE_SCOPES,
              },
            );
            expect(registration.ok).toBe(true);
            const requestId = registration.payload?.requestId;
            expect(requestId).toBeTypeOf("string");
            expect((await rpcReq(admin, "device.pair.approve", { requestId })).ok).toBe(true);
            const result = await rpcReq<{ status: string; scopes: string[]; deviceToken: string }>(
              ws,
              "device.scopes.waitUpgrade",
              { requestId },
            );
            expect(result).toMatchObject({
              ok: true,
              payload: {
                status: "approved",
                scopes: [...UPGRADE_SCOPES, "operator.talk"].toSorted(),
              },
            });
            expect(result.payload?.deviceToken).toBeTypeOf("string");
            expect((await rpcReq(ws, "set-heartbeats", { enabled: false })).ok).toBe(false);
          } finally {
            admin.close();
          }
        }
      } finally {
        ws.close();
        invalidateOperatorRolePolicy(profile.id);
      }
    });
  });

  test("does not cap shared-secret clients without a durable profile", async () => {
    await configureGatewayAuth(
      { mode: "token", token: "secret" },
      {
        roles: {
          default: "guest",
          definitions: {
            guest: {
              sessions: { others: "none" },
              agents: [],
              scopes: ["operator.read"],
            },
          },
        },
      },
    );

    await withGatewayServer(async ({ port }) => {
      const identityPath = deviceIdentityPath("identity-role-shared-secret");
      const ws = await openWs(port, { origin: BROWSER_ORIGIN });
      try {
        const connected = await connectReq(ws, {
          token: "secret",
          prePairDevice: true,
          scopes: ["operator.read", "operator.write"],
          client: CONTROL_UI_CLIENT,
          deviceIdentityPath: identityPath,
          browserOrigin: BROWSER_ORIGIN,
        });
        expect(connected.ok).toBe(true);
        expect(responseScopes(connected)).toEqual(["operator.read", "operator.write"]);
        const deviceToken = (connected.payload as { auth?: { deviceToken?: string } }).auth
          ?.deviceToken;
        expect(deviceToken).toBeTypeOf("string");

        const unboundDevice = await openWs(port, { origin: BROWSER_ORIGIN });
        try {
          const rejected = await connectReq(unboundDevice, {
            skipDefaultAuth: true,
            deviceToken,
            scopes: ["operator.read", "operator.write"],
            client: CONTROL_UI_CLIENT,
            deviceIdentityPath: identityPath,
            browserOrigin: BROWSER_ORIGIN,
          });
          expect(rejected.ok).toBe(false);
          expect(rejected.error?.message).toContain("verified user identity");
        } finally {
          unboundDevice.close();
        }
      } finally {
        ws.close();
      }
    });
  });

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
