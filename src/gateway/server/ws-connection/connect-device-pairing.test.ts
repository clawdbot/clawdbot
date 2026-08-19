// Gateway connect pairing tests protect session exemptions and durable device grant bounds.
import { describe, expect, test } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { replaceConfigFile } from "../../../config/config.js";
import type { GatewayAuthConfig } from "../../../config/types.gateway.js";
import { ensureDeviceToken } from "../../../infra/device-pairing-tokens.js";
import { getPairedDevice } from "../../../infra/device-pairing.js";
import {
  loadDeviceIdentity,
  openTrackedWs,
  pairDeviceIdentity,
} from "../../device-authz.test-helpers.js";
import { CONTROL_UI_CLIENT, openTailscaleWs } from "../../server.auth.test-helpers.js";
import {
  connectReq,
  installGatewayTestHooks,
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
