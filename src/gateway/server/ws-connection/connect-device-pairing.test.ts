// Gateway connect pairing tests protect session exemptions and durable device grant bounds.
import { describe, expect, test, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type { HelloOk } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import type { UsersSelfResult } from "../../../../packages/gateway-protocol/src/schema/users.js";
import { replaceConfigFile } from "../../../config/config.js";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { GatewayAuthConfig } from "../../../config/types.gateway.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { loadDeviceAuthToken } from "../../../infra/device-auth-store.js";
import { issueDeviceBootstrapToken } from "../../../infra/device-bootstrap.js";
import * as pairingApprovals from "../../../infra/device-pairing-approval.js";
import { ensureDeviceToken } from "../../../infra/device-pairing-tokens.js";
import { getPairedDevice, listDevicePairing } from "../../../infra/device-pairing.js";
import {
  CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES,
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
} from "../../../shared/device-bootstrap-profile.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import {
  disconnectedUserGitHubConnection,
  readUserGitHubConnection,
  updateUserGitHubConnection,
} from "../../../state/user-github-connections.js";
import {
  ensureProfileForEmail,
  getUserProfileListItem,
  hasMultipleSessionSharingIdentities,
  setUserProfileRole,
} from "../../../state/user-profiles.js";
import {
  GatewayClient,
  type GatewayClientOptions,
  type GatewayReconnectPausedInfo,
} from "../../client.js";
import {
  loadDeviceIdentity,
  openTrackedWs,
  pairDeviceIdentity,
} from "../../device-authz.test-helpers.js";
import { resolveOperatorRolePolicyForProfile } from "../../operator-role-policy.js";
import {
  ConnectErrorDetailCodes,
  CONTROL_UI_CLIENT,
  openTailscaleWs,
} from "../../server.auth.test-helpers.js";
import {
  connectReq,
  installGatewayTestHooks,
  rpcReq,
  startServer,
  startServerWithClient,
  testState,
  testTailscaleWhois,
} from "../../test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

await import("../../server.js");

const BACKEND_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  version: "1.0.0",
  platform: "node",
  mode: GATEWAY_CLIENT_MODES.BACKEND,
} as const;

const TUI_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.TUI,
  version: "1.0.0",
  platform: "test",
  mode: GATEWAY_CLIENT_MODES.CLI,
} as const;

describe("gateway connect pairing exemptions", () => {
  test("restores a merged owner on shared-token reconnect without exposing the person's policy or GitHub", async () => {
    const origin = "https://localhost";
    const auth = { mode: "token", token: "merged-owner-secret" } as const;
    const config: OpenClawConfig = {
      gateway: {
        auth,
        controlUi: { allowedOrigins: [origin] },
        roles: {
          default: "guest",
          definitions: {
            guest: { sessions: { others: "none" }, agents: ["guest"], scopes: ["operator.read"] },
          },
        },
      },
    };
    testState.gatewayAuth = auth;
    testState.gatewayControlUi = config.gateway?.controlUi;
    await replaceConfigFile({ nextConfig: config, afterWrite: { mode: "auto" } });
    const started = await startServerWithClient(undefined, {
      auth,
      controlUiEnabled: true,
      wsHeaders: { origin },
    });
    let reconnect: Awaited<ReturnType<typeof openTrackedWs>> | undefined;
    const connectOptions = {
      token: auth.token,
      scopes: ["operator.admin"],
      client: CONTROL_UI_CLIENT,
      deviceIdentityPath: loadDeviceIdentity("merged-gateway-owner").identityPath,
    };
    try {
      expect((await connectReq(started.ws, connectOptions)).ok).toBe(true);
      const person = ensureProfileForEmail("person@example.test");
      setUserProfileRole(person.id, "guest");
      const personalConnection = updateUserGitHubConnection(
        person.id,
        () => ({
          ...disconnectedUserGitHubConnection(),
          selection: {
            kind: "connected",
            profileId: "ghp_00000000000000000000000000000001",
            accountId: 101,
            login: "personal-person",
            refreshToken: "synthetic-refresh",
            accessExpiresAtMs: Date.now() + 60_000,
            refreshExpiresAtMs: Date.now() + 120_000,
            scopes: ["repo"],
          },
        }),
        () => {},
      );
      const db = openOpenClawStateDatabase().db;
      // The old merge writer moved identities to the person and left the owner tombstone.
      db.prepare(
        "UPDATE user_profiles SET merged_into = ?, updated_at = 1 WHERE id = 'gateway-owner'",
      ).run(person.id);
      db.prepare(
        "UPDATE user_profile_identities SET profile_id = ? WHERE provider = 'gateway.local' AND subject = 'owner'",
      ).run(person.id);
      const rejected = await rpcReq(started.ws, "users.linkEmail", {
        email: "new@example.test",
        targetProfileId: "gateway-owner",
      });
      expect.soft(rejected).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message:
            "the shared owner profile cannot be merged; sign in with a personal identity instead",
        },
      });
      started.ws.close();
      reconnect = await openTrackedWs(started.port, { origin });
      const connected = await connectReq(reconnect, connectOptions);
      expect(connected.ok).toBe(true);
      const self = await rpcReq<UsersSelfResult>(reconnect, "users.self", {});
      const profileId = self.payload?.profile.id;
      expect.soft(profileId).toBe("gateway-owner");
      expect.soft(resolveOperatorRolePolicyForProfile(profileId, config)).toBeUndefined();
      expect.soft(hasMultipleSessionSharingIdentities()).toBe(false);
      expect.soft(await rpcReq(reconnect, "users.github.status", {})).toMatchObject({
        ok: true,
        payload: { personal: { state: "disconnected", account: null } },
      });
      expect
        .soft(getUserProfileListItem(person.id))
        .toMatchObject({ emails: ["person@example.test"], role: "guest" });
      expect(readUserGitHubConnection(person.id)).toEqual(personalConnection);
    } finally {
      reconnect?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("keeps the owner's renamed profile across shared-token and cached device-token connections", async () => {
    const origin = "https://localhost";
    const auth = { mode: "token", token: "local-owner-secret" } as const;
    testState.gatewayAuth = auth;
    testState.gatewayControlUi = { allowedOrigins: [origin] };
    await replaceConfigFile({
      nextConfig: { gateway: { auth, controlUi: { allowedOrigins: [origin] } } },
      afterWrite: { mode: "auto" },
    });
    const started = await startServer(undefined, { auth, controlUiEnabled: true });
    const loaded = loadDeviceIdentity("durable-gateway-owner");
    const clients: GatewayClient[] = [];
    const scopes = ["operator.read", "operator.write"];
    const connect = (token?: string) =>
      new Promise<{ client: GatewayClient; hello: HelloOk }>((resolve, reject) => {
        const client = new GatewayClient({
          url: `ws://127.0.0.1:${started.port}`,
          origin,
          token,
          deviceIdentity: loaded.identity,
          clientName: CONTROL_UI_CLIENT.id,
          clientVersion: CONTROL_UI_CLIENT.version,
          platform: CONTROL_UI_CLIENT.platform,
          mode: CONTROL_UI_CLIENT.mode,
          role: "operator",
          scopes,
          onHelloOk: (hello) => resolve({ client, hello }),
          onConnectError: reject,
        });
        clients.push(client);
        client.start();
      });
    try {
      const first = await connect(auth.token);
      expect(first.hello.auth.scopes).toEqual(scopes);
      const { profile } = await first.client.request<UsersSelfResult>("users.self", {});
      expect(profile.emails).toEqual([]);
      expect(profile.role).toBeUndefined();
      expect(await first.client.request("users.github.status", {})).toMatchObject({
        personal: { state: "disconnected" },
      });
      await first.client.request("users.setDisplayName", {
        profileId: profile.id,
        displayName: "Ada Owner",
      });
      const cachedToken = loadDeviceAuthToken({
        deviceId: loaded.identity.deviceId,
        role: "operator",
      })?.token;
      expect(cachedToken).toBe(first.hello.auth.deviceToken);
      expect(cachedToken).toBeTruthy();

      // No shared secret: the real client must reload the issued device token.
      const second = await connect();
      expect(second.hello.auth.scopes).toEqual(scopes);
      const secondProfile = await second.client.request<UsersSelfResult>("users.self", {});
      expect(secondProfile.profile).toMatchObject({
        id: profile.id,
        displayName: "Ada Owner",
        emails: [],
      });
      const ownerRows = second.hello.snapshot.presence.filter(
        (entry) => entry.user?.id === profile.id && entry.reason !== "disconnect",
      );
      expect(ownerRows).toHaveLength(2);
      for (const entry of ownerRows) {
        expect(entry.user).toMatchObject({
          id: profile.id,
          identity: { type: "profile", id: profile.id },
          name: "Ada Owner",
        });
        expect(entry.user).not.toHaveProperty("email");
      }
      await second.client.request("users.setDisplayName", {
        profileId: profile.id,
        displayName: "Augusta Owner",
      });
      expect(await first.client.request<UsersSelfResult>("users.self", {})).toMatchObject({
        profile: { id: profile.id, displayName: "Augusta Owner", emails: [] },
      });
    } finally {
      await Promise.all(clients.map((client) => client.stopAndWait()));
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("keeps local pairing pending when automatic approval is disabled before commit", async () => {
    const auth = { mode: "token", token: "local-pairing-policy-token" } as const;
    testState.gatewayAuth = auth;
    await replaceConfigFile({
      nextConfig: { gateway: { auth, nodes: { pairing: { autoApproveLocal: true } } } },
      afterWrite: { mode: "auto" },
    });
    const started = await startServerWithClient(undefined, { auth });
    const loaded = loadDeviceIdentity("local-pairing-policy-revoked");
    const approve = pairingApprovals.approveDevicePairing;
    const approval = vi
      .spyOn(pairingApprovals, "approveDevicePairing")
      .mockImplementation((requestId, options, baseDir) => {
        const current = getRuntimeConfigSnapshot();
        if (!current) {
          throw new Error("expected active Gateway config");
        }
        setRuntimeConfigSnapshot({
          ...current,
          gateway: {
            ...current.gateway,
            nodes: { ...current.gateway?.nodes, pairing: { autoApproveLocal: false } },
          },
        });
        return approve(requestId, options, baseDir);
      });
    try {
      const response = await connectReq(started.ws, {
        client: TUI_CLIENT,
        role: "operator",
        scopes: ["operator.read"],
        token: auth.token,
        deviceIdentityPath: loaded.identityPath,
        prePairDevice: false,
      });
      expect(approval).toHaveBeenCalledOnce();
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("NOT_PAIRED");
      expect((await getPairedDevice(loaded.identity.deviceId)) === null).toBe(true);
      expect((await listDevicePairing()).pending.map((entry) => entry.deviceId)).toContain(
        loaded.identity.deviceId,
      );
    } finally {
      approval.mockRestore();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("returns terminal identity details and pauses a rejected real device-token client", async () => {
    const origin = "https://localhost";
    const auth = { mode: "token", token: "local-secret" } as const;
    testState.gatewayAuth = auth;
    testState.gatewayControlUi = { allowedOrigins: [origin] };
    await replaceConfigFile({
      nextConfig: {
        gateway: {
          auth,
          controlUi: { allowedOrigins: [origin] },
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: "none" },
                agents: ["guest"],
                scopes: ["operator.read"],
              },
            },
          },
        },
      },
      afterWrite: { mode: "auto" },
    });
    const started = await startServerWithClient(undefined, {
      auth,
      controlUiEnabled: true,
      wsHeaders: { origin },
    });

    let provisionClient: GatewayClient | undefined;
    let client: GatewayClient | undefined;
    let provisionTimeout: NodeJS.Timeout | undefined;
    let pauseTimeout: NodeJS.Timeout | undefined;
    try {
      const issued = await issueDeviceBootstrapToken({
        profile: CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
      });
      const response = await connectReq(started.ws, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "operator",
        scopes: [...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES],
        client: CONTROL_UI_CLIENT,
        deviceIdentityPath: loadDeviceIdentity("roles-bootstrap-owner").identityPath,
      });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: "NOT_PAIRED",
          message:
            "operator role policies require a verified user identity for this authentication method; reconnect through the trusted proxy or Tailscale, or use the shared gateway token/password",
          details: { code: ConnectErrorDetailCodes.AUTH_VERIFIED_USER_REQUIRED },
        },
      });

      const loaded = loadDeviceIdentity("roles-device-token-owner");
      const baseClientOptions = {
        url: `ws://127.0.0.1:${started.port}`,
        origin,
        deviceIdentity: loaded.identity,
        clientName: CONTROL_UI_CLIENT.id,
        clientVersion: CONTROL_UI_CLIENT.version,
        platform: CONTROL_UI_CLIENT.platform,
        mode: CONTROL_UI_CLIENT.mode,
        role: "operator",
        scopes: ["operator.read"],
      } satisfies GatewayClientOptions;
      const provisioned = new Promise<void>((resolve, reject) => {
        provisionTimeout = setTimeout(
          () => reject(new Error("timeout waiting for the shared-secret client to connect")),
          2_500,
        );
        provisionClient = new GatewayClient({
          ...baseClientOptions,
          token: auth.token,
          onHelloOk: () => resolve(),
          onConnectError: reject,
        });
        provisionClient.start();
      });
      await provisioned;
      if (provisionTimeout) {
        clearTimeout(provisionTimeout);
      }
      await provisionClient?.stopAndWait();
      const deviceToken = loadDeviceAuthToken({
        deviceId: loaded.identity.deviceId,
        role: "operator",
      })?.token;
      expect(deviceToken).toBe(
        (await getPairedDevice(loaded.identity.deviceId))?.tokens?.operator?.token,
      );
      if (!deviceToken) {
        throw new Error("expected shared-secret connection to issue a device token");
      }

      const connectAttempts = vi.fn();
      const paused = new Promise<GatewayReconnectPausedInfo>((resolve, reject) => {
        pauseTimeout = setTimeout(
          () => reject(new Error("timeout waiting for the Gateway client to pause reconnect")),
          2_500,
        );
        client = new GatewayClient({
          ...baseClientOptions,
          hostDeps: { beforeConnect: connectAttempts },
          onReconnectPaused: resolve,
        });
        client.start();
      });

      await expect(paused).resolves.toMatchObject({
        detailCode: ConnectErrorDetailCodes.AUTH_VERIFIED_USER_REQUIRED,
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1_100);
      });
      expect(connectAttempts).toHaveBeenCalledTimes(1);
      expect(
        loadDeviceAuthToken({ deviceId: loaded.identity.deviceId, role: "operator" })?.token,
      ).toBe(deviceToken);
    } finally {
      if (provisionTimeout) {
        clearTimeout(provisionTimeout);
      }
      if (pauseTimeout) {
        clearTimeout(pauseTimeout);
      }
      await Promise.all([client?.stopAndWait(), provisionClient?.stopAndWait()]);
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test.each([
    {
      name: "local backend self-call",
      client: BACKEND_CLIENT,
      approvedScopes: ["operator.pairing"],
      pairingClientId: GATEWAY_CLIENT_NAMES.CLI,
      pairingClientMode: GATEWAY_CLIENT_MODES.CLI,
    },
    {
      name: "TUI operator client",
      client: TUI_CLIENT,
      approvedScopes: ["operator.read"],
      pairingClientId: GATEWAY_CLIENT_NAMES.TUI,
      pairingClientMode: GATEWAY_CLIENT_MODES.CLI,
    },
  ])(
    "admits an auth-none $name before and after a narrower pairing row exists",
    async ({ name, client, approvedScopes, pairingClientId, pairingClientMode }) => {
      const started = await startServerWithClient(undefined, { auth: { mode: "none" } });
      const identityName = `auth-none-${name.replaceAll(" ", "-")}`;
      const loaded = loadDeviceIdentity(identityName);
      let pairedWs: Awaited<ReturnType<typeof openTrackedWs>> | undefined;

      try {
        const unpaired = await connectReq(started.ws, {
          client,
          role: "operator",
          scopes: ["operator.write"],
          deviceIdentityPath: loaded.identityPath,
          skipDefaultAuth: true,
          prePairDevice: false,
        });
        expect(unpaired.ok, JSON.stringify(unpaired)).toBe(true);
        started.ws.close();

        await pairDeviceIdentity({
          name: identityName,
          role: "operator",
          scopes: approvedScopes,
          clientId: pairingClientId,
          clientMode: pairingClientMode,
        });
        const tokenBefore = await ensureDeviceToken({
          deviceId: loaded.identity.deviceId,
          role: "operator",
          scopes: approvedScopes,
        });
        expect(tokenBefore?.scopes).toEqual(approvedScopes);

        pairedWs = await openTrackedWs(started.port);
        const pairedConnect = await connectReq(pairedWs, {
          client,
          role: "operator",
          scopes: ["operator.write"],
          deviceIdentityPath: loaded.identityPath,
          skipDefaultAuth: true,
          prePairDevice: false,
        });
        expect(pairedConnect.ok, JSON.stringify(pairedConnect)).toBe(true);

        const paired = await getPairedDevice(loaded.identity.deviceId);
        expect(paired?.approvedScopes).toEqual(approvedScopes);
        expect(paired?.tokens?.operator).toMatchObject({
          token: tokenBefore?.token,
          scopes: approvedScopes,
        });
        expect(paired?.lastSeenReason).toBe("connect");
      } finally {
        pairedWs?.close();
        started.ws.close();
        await started.server.close();
        started.envSnapshot.restore();
      }
    },
  );

  test.each([
    {
      name: "auth-none CLI client",
      auth: { mode: "none" } as const,
      client: {
        id: GATEWAY_CLIENT_NAMES.CLI,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.CLI,
      },
    },
    {
      name: "token-auth native app client",
      auth: { mode: "token", token: "local-secret" } as const,
      client: {
        id: GATEWAY_CLIENT_NAMES.MACOS_APP,
        version: "1.0.0",
        platform: "darwin",
        mode: GATEWAY_CLIENT_MODES.UI,
      },
    },
  ])("silently widens a narrow local pairing row for a $name", async ({ name, auth, client }) => {
    testState.gatewayAuth = auth;
    const started = await startServerWithClient(undefined, { auth });
    const identityName = `silent-widen-${name.replaceAll(" ", "-")}`;
    const paired = await pairDeviceIdentity({
      name: identityName,
      role: "operator",
      scopes: ["operator.pairing"],
      clientId: client.id,
      clientMode: client.mode,
    });

    try {
      // Deliberately NOT a superset of the row: the merge must self-grant the
      // union (requested + already-held), not require the client to re-request
      // its existing scopes.
      const widened = await connectReq(started.ws, {
        client,
        role: "operator",
        scopes: ["operator.write"],
        deviceIdentityPath: paired.identityPath,
        skipDefaultAuth: auth.mode === "none",
        ...(auth.mode === "token" ? { token: auth.token } : {}),
        prePairDevice: false,
      });
      expect(widened.ok, JSON.stringify(widened)).toBe(true);

      const row = await getPairedDevice(paired.identity.deviceId);
      // The widened grant merges into the row; the original approval
      // provenance is retained rather than rewritten to "silent".
      expect(row?.approvedScopes).toEqual(
        expect.arrayContaining(["operator.pairing", "operator.write"]),
      );
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("keeps a narrow pairing row as the Tailscale Control UI scope cap", async () => {
    const tailscaleOrigin = "https://gateway.tailnet.ts.net";
    const auth = {
      mode: "token",
      token: "secret",
      allowTailscale: true,
    } satisfies GatewayAuthConfig;
    testState.gatewayAuth = auth;
    testState.gatewayControlUi = { allowedOrigins: [tailscaleOrigin] };
    testTailscaleWhois.value = { login: "peter", name: "Peter" };
    await replaceConfigFile({
      nextConfig: {
        gateway: {
          auth,
          tailscale: { mode: "serve" },
          controlUi: { allowedOrigins: [tailscaleOrigin] },
        },
      },
      afterWrite: { mode: "auto" },
    });
    const started = await startServer(undefined, { auth, controlUiEnabled: true });
    const identityName = "tailscale-control-ui-scope-cap";
    const paired = await pairDeviceIdentity({
      name: identityName,
      role: "operator",
      scopes: ["operator.read"],
      clientId: CONTROL_UI_CLIENT.id,
      clientMode: CONTROL_UI_CLIENT.mode,
    });
    let ws: Awaited<ReturnType<typeof openTailscaleWs>> | undefined;

    try {
      const tailscaleEndpoint = started.server.getTailscaleIngressEndpoint();
      if (!tailscaleEndpoint) {
        throw new Error("expected managed Tailscale listener");
      }
      ws = await openTailscaleWs(tailscaleEndpoint, { origin: tailscaleOrigin });
      const response = await connectReq(ws, {
        skipDefaultAuth: true,
        prePairDevice: false,
        scopes: ["operator.write"],
        client: CONTROL_UI_CLIENT,
        deviceIdentityPath: paired.identityPath,
      });
      expect(response.ok).toBe(false);
      expect(response.error?.details).toMatchObject({
        reason: "scope-upgrade",
        approvedScopes: ["operator.read"],
      });
      expect((await getPairedDevice(paired.identity.deviceId))?.approvedScopes).toEqual([
        "operator.read",
      ]);
    } finally {
      ws?.close();
      await started.server.close();
      started.envSnapshot.restore();
      testTailscaleWhois.value = null;
    }
  });
});
