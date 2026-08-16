import { expect, test } from "vitest";
import {
  createOperatorIdentityFixture,
  seedApprovedOperatorReadPairing,
  startControlUiServer,
} from "./server.auth.control-ui.fixtures.test-support.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  ConnectErrorDetailCodes,
  openWs,
  restoreGatewayToken,
  rpcReq,
  testState,
} from "./server.auth.test-helpers.js";

export function registerControlUiOwnerBootstrapSuite(): void {
  test("silently approves host-authorized control ui owner bootstrap tokens", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const { getPairedDevice, listDevicePairing, verifyDeviceToken } =
      await import("../infra/device-pairing.js");
    const { CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES, CONTROL_UI_OWNER_BOOTSTRAP_PROFILE } =
      await import("../shared/device-bootstrap-profile.js");
    const { resolveSharedGatewaySessionGeneration } =
      await import("./server/ws-shared-generation.js");
    testState.gatewayControlUi = { allowedOrigins: ["https://localhost"] };
    const { server, port, prevToken } = await startControlUiServer("secret");

    const { identityPath, identity } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-control-ui-",
    );

    try {
      const issued = await issueDeviceBootstrapToken({
        profile: CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
      });
      const wsBootstrap = await openWs(port, {
        origin: "https://localhost",
        "x-forwarded-for": "203.0.113.50",
      });
      const initial = await connectReq(wsBootstrap, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "operator",
        scopes: [...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES],
        client: CONTROL_UI_CLIENT,
        deviceIdentityPath: identityPath,
      });
      expect(initial.ok).toBe(true);
      const payload = initial.payload as
        | {
            type?: string;
            auth?: {
              deviceToken?: string;
              recoveryScope?: string;
              role?: string;
              scopes?: string[];
            };
          }
        | undefined;
      expect(payload?.type).toBe("hello-ok");
      expect(payload?.auth?.role).toBe("operator");
      expect(payload?.auth?.scopes).toEqual([...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES]);
      const deviceToken = payload?.auth?.deviceToken;
      const recoveryScope = payload?.auth?.recoveryScope;
      if (!deviceToken) {
        throw new Error("expected control ui owner device token");
      }
      expect(recoveryScope).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect((await rpcReq(wsBootstrap, "set-heartbeats", { enabled: false })).ok).toBe(true);
      wsBootstrap.close();

      const pending = (await listDevicePairing()).pending.filter(
        (entry) => entry.deviceId === identity.deviceId,
      );
      expect(pending).toEqual([]);
      const paired = await getPairedDevice(identity.deviceId);
      expect(paired?.roles).toEqual(["operator"]);
      expect(paired?.approvedScopes).toEqual([...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES]);
      const wsReload = await openWs(port, {
        origin: "https://localhost",
        "x-forwarded-for": "203.0.113.50",
      });
      const reload = await connectReq(wsReload, {
        skipDefaultAuth: true,
        deviceToken,
        role: "operator",
        scopes: [...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES],
        client: CONTROL_UI_CLIENT,
        deviceIdentityPath: identityPath,
      });
      expect(reload.ok).toBe(true);
      expect(
        (reload.payload as { auth?: { recoveryScope?: string } } | undefined)?.auth?.recoveryScope,
      ).toBe(recoveryScope);
      wsReload.close();

      const sharedGatewaySessionGeneration = resolveSharedGatewaySessionGeneration({
        mode: "token",
        token: "secret",
        allowTailscale: false,
      });
      if (!sharedGatewaySessionGeneration) {
        throw new Error("expected shared gateway session generation");
      }
      await expect(
        verifyDeviceToken({
          deviceId: identity.deviceId,
          token: deviceToken,
          role: "operator",
          scopes: [...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES],
          requiredSharedGatewaySessionGeneration: sharedGatewaySessionGeneration,
        }),
      ).resolves.toEqual({
        ok: true,
        issuer: {
          kind: "shared-gateway-auth",
          generation: sharedGatewaySessionGeneration,
        },
      });
      await expect(
        verifyDeviceToken({
          deviceId: identity.deviceId,
          token: deviceToken,
          role: "operator",
          scopes: [...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES],
          requiredSharedGatewaySessionGeneration: "rotated-generation",
        }),
      ).resolves.toEqual({ ok: false, reason: "issuer-generation-stale" });
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("keeps generic control ui bootstrap tokens on the bounded profile", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { BOOTSTRAP_HANDOFF_OPERATOR_SCOPES } =
      await import("../shared/device-bootstrap-profile.js");
    testState.gatewayControlUi = { allowedOrigins: ["https://localhost"] };
    const { server, port, prevToken } = await startControlUiServer("secret");
    const { identityPath, identity } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-control-ui-bounded-",
    );

    try {
      const issued = await issueDeviceBootstrapToken({
        profile: {
          roles: ["operator"],
          scopes: BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
          purpose: "control-ui",
        },
      });
      const wsBootstrap = await openWs(port, {
        origin: "https://localhost",
        "x-forwarded-for": "203.0.113.51",
      });
      const initial = await connectReq(wsBootstrap, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "operator",
        scopes: [...BOOTSTRAP_HANDOFF_OPERATOR_SCOPES],
        client: CONTROL_UI_CLIENT,
        deviceIdentityPath: identityPath,
      });
      expect(initial.ok).toBe(true);
      const auth = (
        initial.payload as
          | {
              auth?: {
                scopes?: string[];
              };
            }
          | undefined
      )?.auth;
      expect(auth?.scopes).toEqual([...BOOTSTRAP_HANDOFF_OPERATOR_SCOPES]);
      expect(auth?.scopes).not.toContain("operator.admin");
      expect(auth?.scopes).not.toContain("operator.pairing");
      const adminMutation = await rpcReq(wsBootstrap, "set-heartbeats", { enabled: false });
      expect(adminMutation.ok).toBe(false);
      expect(adminMutation.error?.message ?? "").toContain("missing scope");
      wsBootstrap.close();

      expect(
        (await listDevicePairing()).pending.filter((entry) => entry.deviceId === identity.deviceId),
      ).toEqual([]);
      expect((await getPairedDevice(identity.deviceId))?.approvedScopes).toEqual([
        ...BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
      ]);
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("silently upgrades the same control ui key with a host-authorized bootstrap", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES, CONTROL_UI_OWNER_BOOTSTRAP_PROFILE } =
      await import("../shared/device-bootstrap-profile.js");
    const { identity, identityPath } = await seedApprovedOperatorReadPairing({
      identityPrefix: "openclaw-control-ui-owner-upgrade-",
      clientId: CONTROL_UI_CLIENT.id,
      clientMode: CONTROL_UI_CLIENT.mode,
      displayName: "control-ui-owner-upgrade",
      platform: CONTROL_UI_CLIENT.platform,
    });
    const before = await getPairedDevice(identity.deviceId);
    const previousToken = before?.tokens?.operator?.token;
    if (!previousToken) {
      throw new Error("expected limited operator token");
    }

    testState.gatewayControlUi = { allowedOrigins: ["https://localhost"] };
    const { server, port, prevToken } = await startControlUiServer("secret");
    const { identityPath: secondIdentityPath } = await createOperatorIdentityFixture(
      "openclaw-control-ui-owner-upgrade-second-browser-",
    );

    try {
      const issued = await issueDeviceBootstrapToken({
        profile: CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
      });
      const wsUpgrade = await openWs(port, {
        origin: "https://localhost",
        "x-forwarded-for": "203.0.113.52",
      });
      const upgraded = await connectReq(wsUpgrade, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "operator",
        scopes: [...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES],
        client: CONTROL_UI_CLIENT,
        deviceIdentityPath: identityPath,
      });
      expect(upgraded.ok).toBe(true);
      const auth = (
        upgraded.payload as
          | {
              auth?: {
                deviceToken?: string;
                scopes?: string[];
              };
            }
          | undefined
      )?.auth;
      const upgradedToken = auth?.deviceToken;
      if (!upgradedToken) {
        throw new Error("expected upgraded operator token");
      }
      expect(upgradedToken).not.toBe(previousToken);
      expect(auth?.scopes).toEqual([...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES]);
      expect((await rpcReq(wsUpgrade, "set-heartbeats", { enabled: false })).ok).toBe(true);
      wsUpgrade.close();

      expect(
        (await listDevicePairing()).pending.filter((entry) => entry.deviceId === identity.deviceId),
      ).toEqual([]);
      const paired = await getPairedDevice(identity.deviceId);
      expect(paired?.approvedScopes).toEqual([...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES]);
      expect(paired?.tokens?.operator?.token).toBe(upgradedToken);

      const wsReload = await openWs(port, {
        origin: "https://localhost",
        "x-forwarded-for": "203.0.113.52",
      });
      const reload = await connectReq(wsReload, {
        skipDefaultAuth: true,
        deviceToken: upgradedToken,
        role: "operator",
        scopes: [...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES],
        client: CONTROL_UI_CLIENT,
        deviceIdentityPath: identityPath,
      });
      expect(reload.ok).toBe(true);
      wsReload.close();

      const wsSecondBrowser = await openWs(port, {
        origin: "https://localhost",
        "x-forwarded-for": "203.0.113.53",
      });
      const replay = await connectReq(wsSecondBrowser, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "operator",
        scopes: [...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES],
        client: CONTROL_UI_CLIENT,
        deviceIdentityPath: secondIdentityPath,
      });
      expect(replay.ok).toBe(false);
      expect((replay.error?.details as { code?: string } | undefined)?.code).toBe(
        ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID,
      );
      wsSecondBrowser.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("requires pairing for control ui bootstrap token without control-ui purpose", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { BOOTSTRAP_HANDOFF_OPERATOR_SCOPES } =
      await import("../shared/device-bootstrap-profile.js");
    testState.gatewayControlUi = { allowedOrigins: ["https://localhost"] };
    const { server, port, prevToken } = await startControlUiServer("secret");

    const { identityPath, identity } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-control-ui-missing-purpose-",
    );

    try {
      const issued = await issueDeviceBootstrapToken({
        profile: {
          roles: ["operator"],
          scopes: BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
        },
      });
      const wsBootstrap = await openWs(port, {
        origin: "https://localhost",
        "x-forwarded-for": "203.0.113.51",
      });
      const initial = await connectReq(wsBootstrap, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "operator",
        scopes: ["operator.read"],
        client: CONTROL_UI_CLIENT,
        deviceIdentityPath: identityPath,
      });
      expect(initial.ok).toBe(false);
      expect(initial.error?.message ?? "").toContain("pairing required");

      const pending = (await listDevicePairing()).pending.filter(
        (entry) => entry.deviceId === identity.deviceId,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]?.role).toBe("operator");
      expect(await getPairedDevice(identity.deviceId)).toBeNull();
      wsBootstrap.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("requires pairing for control ui node bootstrap tokens", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    testState.gatewayControlUi = { allowedOrigins: ["https://localhost"] };
    const { server, port, prevToken } = await startControlUiServer("secret");

    const { identityPath, identity } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-control-ui-node-profile-",
    );

    try {
      const issued = await issueDeviceBootstrapToken({
        profile: {
          roles: ["node"],
          scopes: [],
          purpose: "control-ui",
        },
      });
      const wsBootstrap = await openWs(port, {
        origin: "https://localhost",
        "x-forwarded-for": "203.0.113.52",
      });
      const initial = await connectReq(wsBootstrap, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "node",
        scopes: [],
        client: CONTROL_UI_CLIENT,
        deviceIdentityPath: identityPath,
      });
      expect(initial.ok).toBe(false);
      expect(initial.error?.message ?? "").toContain("pairing required");

      const pending = (await listDevicePairing()).pending.filter(
        (entry) => entry.deviceId === identity.deviceId,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]?.role).toBe("node");
      expect(await getPairedDevice(identity.deviceId)).toBeNull();
      wsBootstrap.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });
}
