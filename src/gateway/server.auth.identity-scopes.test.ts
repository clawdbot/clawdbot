import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";
import { PresenceEntrySchema } from "../../packages/gateway-protocol/src/schema/snapshot.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { GatewayAuthConfig, GatewayOperatorRolesConfig } from "../config/types.gateway.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { getPairedDevice, listDevicePairing } from "../infra/device-pairing.js";
import { listSystemPresence, type SystemPresence } from "../infra/system-presence.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  NODE_CLIENT,
  onceMessage,
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
  test("projects watched sessions for each authenticated presence recipient across hello, RPC, and events", async () => {
    await configureGatewayAuth(
      {
        mode: "trusted-proxy",
        identityScopes: { "admin@example.com": ["operator.admin"] },
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowLoopback: true,
        },
      },
      {
        roles: {
          default: "reader",
          definitions: {
            reader: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
            restricted: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
            maintainer: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
            pairing: { sessions: { others: "none" }, agents: [], scopes: ["operator.pairing"] },
          },
        },
      },
    );
    const creator = ensureProfileForEmail("creator@example.com");
    const restricted = ensureProfileForEmail("restricted@example.com");
    setUserProfileRole(restricted.id, "restricted");
    setUserProfileRole(ensureProfileForEmail("admin@example.com").id, "maintainer");
    setUserProfileRole(ensureProfileForEmail("pairing@example.com").id, "pairing");
    const sharedKey = "agent:main:presence-shared";
    const draftKey = "agent:main:presence-draft";
    const incognitoKey = "agent:main:dashboard:incognito-presence";
    const restrictedKey = "agent:main:presence-restricted-draft";
    const missingKey = "agent:main:presence-missing";
    const watchedKeys = [sharedKey, draftKey, incognitoKey, restrictedKey, missingKey].toSorted();
    const watcherInstanceId = `presence-watcher-${randomUUID()}`;
    const identityDir = tempDirs.make("openclaw-presence-identities-");

    await withGatewayServer(async ({ port }) => {
      for (const [sessionKey, profileId, visibility, incognito] of [
        [sharedKey, creator.id, "shared", false],
        [draftKey, creator.id, "draft", false],
        [incognitoKey, creator.id, "shared", true],
        [restrictedKey, restricted.id, "draft", false],
      ] as const) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: randomUUID(),
            updatedAt: Date.now(),
            createdActor: { type: "human", id: profileId },
            visibility,
            ...(incognito ? { incognito: true } : {}),
          },
        );
      }
      const sockets: Awaited<ReturnType<typeof openWs>>[] = [];
      const openRecipient = async (
        name: string,
        scopes: string[],
        role: "operator" | "node" = "operator",
      ) => {
        const ws = await openWs(port, {
          ...TRUSTED_PROXY_HEADERS,
          "x-forwarded-user": `${name}@example.com`,
        });
        sockets.push(ws);
        const connected = await connectReq(ws, {
          skipDefaultAuth: true,
          prePairDevice: true,
          scopes,
          role,
          client: {
            ...(role === "node" ? NODE_CLIENT : CONTROL_UI_CLIENT),
            instanceId: sockets.length === 1 ? watcherInstanceId : `presence-${name}`,
          },
          deviceIdentityPath: path.join(identityDir, `${name}-${sockets.length}.sqlite`),
          browserOrigin: BROWSER_ORIGIN,
        });
        expect(connected.ok, `${name} connect: ${JSON.stringify(connected.error)}`).toBe(true);
        expect(responseScopes(connected), `${name} effective scopes`).toEqual(scopes);
        return {
          ws,
          hello: connected.payload as { snapshot: { presence: SystemPresence[] } },
        };
      };
      try {
        const watcher = await openRecipient("admin", ["operator.admin"]);
        const declared = await rpcReq(watcher.ws, "sessions.viewers.set", {
          sessionKeys: watchedKeys,
        });
        expect(declared).toMatchObject({ ok: true, payload: { sessionKeys: watchedKeys } });
        const rawWatcher = listSystemPresence().find(
          (entry) => entry.instanceId === watcherInstanceId,
        );
        expect(rawWatcher?.watchedSessions).toEqual(watchedKeys);
        const { watchedSessions: _watchedSessions, ...person } = rawWatcher!;
        expect(person.user?.id).toBe(ensureProfileForEmail("admin@example.com").id);
        expect(person.ts).toBeGreaterThan(0);

        const recipients = [];
        for (const scenario of [
          { name: "creator", scopes: ["operator.read"], allowed: [sharedKey, draftKey] },
          { name: "reader", scopes: ["operator.read"], allowed: [sharedKey] },
          { name: "restricted", scopes: ["operator.read"], allowed: [restrictedKey] },
          {
            name: "admin",
            scopes: ["operator.admin"],
            allowed: [sharedKey, draftKey, incognitoKey, restrictedKey],
          },
          { name: "pairing", scopes: ["operator.pairing"], allowed: [] },
          { name: "node", scopes: [], allowed: [] },
        ]) {
          const recipient = await openRecipient(
            scenario.name,
            scenario.scopes,
            scenario.name === "node" ? "node" : "operator",
          );
          const canRead = scenario.name !== "pairing" && scenario.name !== "node";
          const listed = await rpcReq<{ sessions: Array<{ key: string }> }>(
            recipient.ws,
            "sessions.list",
            { agentId: "main" },
          );
          expect(listed.ok, `${scenario.name} sessions.list scope`).toBe(canRead);
          if (canRead) {
            expect(
              listed.payload?.sessions
                .map((entry) => entry.key)
                .filter((key) => watchedKeys.includes(key))
                .toSorted(),
              `${scenario.name} canonical sessions.list visibility`,
            ).toEqual(scenario.allowed.toSorted());
          }
          const presence = await rpcReq(recipient.ws, "system-presence");
          expect(presence.ok, `${scenario.name} system-presence scope`).toBe(canRead);
          recipients.push({ ...recipient, ...scenario, canRead, rpcPresence: presence.payload });
        }

        const eventPromises = recipients.map(({ ws }) =>
          onceMessage<{ type: string; event: string; payload: { presence: SystemPresence[] } }>(
            ws,
            (frame) => frame.type === "event" && frame.event === "presence",
          ),
        );
        expect(
          await rpcReq(watcher.ws, "system-event", { text: "presence recipient repro" }),
        ).toMatchObject({ ok: true });
        const events = await Promise.all(eventPromises);
        for (const [index, recipient] of recipients.entries()) {
          for (const [surface, rows] of [
            ["hello", recipient.hello.snapshot.presence],
            ["system-presence", recipient.rpcPresence],
            ["presence event", events[index]!.payload.presence],
          ] as const) {
            if (surface === "system-presence" && !recipient.canRead) {
              continue; // The RPC is rejected for pairing-only operators and nodes.
            }
            if (!Value.Check(Type.Array(PresenceEntrySchema), rows)) {
              throw new Error(`${recipient.name} ${surface} returned invalid presence rows`);
            }
            const received = rows.find((entry) => entry.instanceId === watcherInstanceId);
            const { watchedSessions, ...receivedPerson } = received ?? {};
            expect
              .soft(
                receivedPerson,
                `${recipient.name} ${surface} preserves the person and timestamp without hidden counts`,
              )
              .toEqual(person);
            expect
              .soft(
                watchedSessions ?? [],
                `${recipient.name} ${surface} watched session disclosure`,
              )
              .toEqual(recipient.allowed.toSorted());
          }
        }
      } finally {
        for (const ws of sockets) {
          ws.close();
        }
      }
    });
  });

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
  ])("applies the $label role ceiling after device and identity grants", async (scenario) => {
    await configureGatewayAuth(
      {
        mode: "trusted-proxy",
        identityScopes: { "admin@example.com": ["operator.admin"] },
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
          },
        },
      },
    );
    if (scenario.assignedRole) {
      const profile = ensureProfileForEmail("admin@example.com");
      setUserProfileRole(profile.id, scenario.assignedRole);
    }

    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, TRUSTED_PROXY_HEADERS);
      try {
        const connected = await connectReq(ws, {
          skipDefaultAuth: true,
          prePairDevice: true,
          scopes: ["operator.read", "operator.write"],
          client: CONTROL_UI_CLIENT,
          deviceIdentityPath: deviceIdentityPath(`identity-role-${scenario.label}`),
          browserOrigin: BROWSER_ORIGIN,
        });
        expect(connected.ok).toBe(true);
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
      } finally {
        ws.close();
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
