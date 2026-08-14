import { expect, test, vi } from "vitest";
import {
  createOperatorIdentityFixture,
  expectArrayIncludes,
  REMOTE_BOOTSTRAP_HEADERS,
  startControlUiServer,
} from "./server.auth.control-ui.fixtures.test-support.js";
import {
  connectReq,
  ConnectErrorDetailCodes,
  openWs,
  restoreGatewayToken,
  waitForWsClose,
} from "./server.auth.test-helpers.js";

export function registerControlUiBootstrapLifecycleSuite(): void {
  test("qr bootstrap retry keeps full operator handoff after paired approval", async () => {
    const { issueDeviceBootstrapToken, verifyDeviceBootstrapToken } =
      await import("../infra/device-bootstrap.js");
    const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
    const { approveBootstrapDevicePairing, requestDevicePairing } =
      await import("../infra/device-pairing.js");
    const { FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE } =
      await import("../shared/device-bootstrap-profile.js");
    const { server, port, prevToken } = await startControlUiServer("secret");
    const { identityPath, identity } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-node-retry-",
    );
    const client = {
      id: "openclaw-ios",
      version: "2026.3.30",
      platform: "iOS 26.3.1",
      mode: "node",
      deviceFamily: "iPhone",
    };

    try {
      const issued = await issueDeviceBootstrapToken({
        profile: FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
      });
      const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
      const pending = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey,
        role: "node",
        roles: ["node", "operator"],
        scopes: [
          "operator.admin",
          "operator.approvals",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
        clientId: client.id,
        clientMode: client.mode,
        displayName: client.id,
        platform: client.platform,
        deviceFamily: client.deviceFamily,
        silent: true,
      });
      await approveBootstrapDevicePairing(
        pending.request.requestId,
        FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
      );

      const wsRetry = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const retry = await connectReq(wsRetry, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "node",
        scopes: [],
        client,
        deviceIdentityPath: identityPath,
      });
      expect(retry.ok).toBe(true);
      const payload = retry.payload as
        | {
            auth?: {
              deviceToken?: string;
              deviceTokens?: Array<{ deviceToken?: string; role?: string; scopes?: string[] }>;
            };
          }
        | undefined;
      expect(payload?.auth?.deviceToken).toBeTruthy();
      const operatorHandoff = payload?.auth?.deviceTokens?.find(
        (entry) => entry.role === "operator",
      );
      expect(operatorHandoff?.deviceToken).toBeTruthy();
      expect(operatorHandoff?.scopes).toEqual([
        "operator.admin",
        "operator.approvals",
        "operator.read",
        "operator.talk.secrets",
        "operator.write",
      ]);
      expect(operatorHandoff?.scopes).toContain("operator.admin");
      wsRetry.close();

      await expect(
        verifyDeviceBootstrapToken({
          token: issued.token,
          deviceId: identity.deviceId,
          publicKey,
          role: "node",
          scopes: [],
        }),
      ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("rejected non-baseline bootstrap request cannot recreate pending node pairing", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const { listDevicePairing, rejectDevicePairing } = await import("../infra/device-pairing.js");
    const { server, port, prevToken } = await startControlUiServer("secret");
    const { identityPath, identity } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-node-reject-",
    );
    const client = {
      id: "openclaw-ios",
      version: "2026.3.30",
      platform: "iOS 26.3.1",
      mode: "node",
      deviceFamily: "iPhone",
    };

    try {
      const issued = await issueDeviceBootstrapToken({
        profile: {
          roles: ["node"],
          scopes: [],
        },
      });
      const wsInitial = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const initial = await connectReq(wsInitial, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "node",
        scopes: [],
        client,
        deviceIdentityPath: identityPath,
      });
      expect(initial.ok).toBe(false);
      expect(
        initial.error?.details as { code?: string; pauseReconnect?: boolean } | undefined,
      ).toMatchObject({
        code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
        pauseReconnect: false,
      });
      wsInitial.close();

      const pending = (await listDevicePairing()).pending.find(
        (entry) => entry.deviceId === identity.deviceId,
      );
      if (!pending) {
        throw new Error("expected pending bootstrap pairing request");
      }
      await expect(rejectDevicePairing(pending.requestId)).resolves.toEqual({
        requestId: pending.requestId,
        deviceId: identity.deviceId,
      });

      const wsRetry = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const retry = await connectReq(wsRetry, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "node",
        scopes: [],
        client,
        deviceIdentityPath: identityPath,
      });
      expect(retry.ok).toBe(false);
      expect((retry.error?.details as { code?: string } | undefined)?.code).toBe(
        ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID,
      );
      wsRetry.close();
      expect(
        (await listDevicePairing()).pending.filter((entry) => entry.deviceId === identity.deviceId),
      ).toEqual([]);
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("does not consume bootstrap token when node reconcile fails before hello-ok", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const { approveDevicePairing, listDevicePairing } = await import("../infra/device-pairing.js");
    const reconcileModule = await import("./node-connect-reconcile.js");
    const reconcileSpy = vi
      .spyOn(reconcileModule, "reconcileNodePairingOnConnect")
      .mockRejectedValueOnce(new Error("boom"));
    const { server, port, prevToken } = await startControlUiServer("secret");

    const { identityPath, client } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-reconcile-fail-",
    );
    const nodeClient = {
      ...client,
      id: "openclaw-android",
      mode: "node",
    };

    try {
      const issued = await issueDeviceBootstrapToken({
        profile: {
          roles: ["node"],
          scopes: [],
        },
      });

      const wsInitial = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const initial = await connectReq(wsInitial, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "node",
        scopes: [],
        client: nodeClient,
        deviceIdentityPath: identityPath,
      });
      expect(initial.ok).toBe(false);
      wsInitial.close();
      const pending = (await listDevicePairing()).pending.find(
        (entry) => entry.clientId === nodeClient.id,
      );
      if (!pending) {
        throw new Error("expected pending bootstrap pairing request");
      }
      await approveDevicePairing(pending.requestId, { callerScopes: ["operator.pairing"] });

      const wsFail = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      await expect(
        connectReq(wsFail, {
          skipDefaultAuth: true,
          bootstrapToken: issued.token,
          role: "node",
          scopes: [],
          client: nodeClient,
          deviceIdentityPath: identityPath,
          timeoutMs: 500,
        }),
      ).rejects.toThrow();
      // The full agentic shard can saturate the event loop enough that the
      // server-side close after a pre-hello failure arrives later than 1s.
      await expect(waitForWsClose(wsFail, 5_000)).resolves.toBe(true);

      const wsRetry = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const retry = await connectReq(wsRetry, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "node",
        scopes: [],
        client: nodeClient,
        deviceIdentityPath: identityPath,
      });
      expect(retry.ok).toBe(true);
      wsRetry.close();
    } finally {
      reconcileSpy.mockRestore();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("requires approval for bootstrap-auth role upgrades on already-paired devices", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing, requestDevicePairing } =
      await import("../infra/device-pairing.js");
    const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
    const { server, port, prevToken } = await startControlUiServer("secret");

    const { identityPath, identity } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-role-upgrade-",
    );
    const client = {
      id: "openclaw-ios",
      version: "2026.3.30",
      platform: "iOS 26.3.1",
      mode: "node",
      deviceFamily: "iPhone",
    };

    try {
      const seededRequest = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        role: "operator",
        scopes: ["operator.read"],
        clientId: client.id,
        clientMode: client.mode,
        platform: client.platform,
        deviceFamily: client.deviceFamily,
      });
      await approveDevicePairing(seededRequest.request.requestId, {
        callerScopes: ["operator.read"],
      });

      const issued = await issueDeviceBootstrapToken({
        profile: {
          roles: ["node"],
          scopes: [],
        },
      });
      const wsUpgrade = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const upgrade = await connectReq(wsUpgrade, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "node",
        scopes: [],
        client,
        deviceIdentityPath: identityPath,
      });
      expect(upgrade.ok).toBe(false);
      expect(upgrade.error?.message ?? "").toContain("pairing required");
      expect((upgrade.error?.details as { code?: string; reason?: string } | undefined)?.code).toBe(
        ConnectErrorDetailCodes.PAIRING_REQUIRED,
      );
      expect(
        (upgrade.error?.details as { code?: string; reason?: string } | undefined)?.reason,
      ).toBe("role-upgrade");
      expect(
        (
          upgrade.error?.details as
            | {
                requestedRole?: string;
                approvedRoles?: string[];
              }
            | undefined
        )?.requestedRole,
      ).toBe("node");
      expect(
        (
          upgrade.error?.details as
            | {
                requestedRole?: string;
                approvedRoles?: string[];
              }
            | undefined
        )?.approvedRoles,
      ).toEqual(["operator"]);

      const pending = (await listDevicePairing()).pending.filter(
        (entry) => entry.deviceId === identity.deviceId,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]?.role).toBe("node");
      expect(pending[0]?.roles).toEqual(["node"]);
      const paired = await getPairedDevice(identity.deviceId);
      expectArrayIncludes(paired?.roles, ["operator"]);
      wsUpgrade.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("requires approval for bootstrap-auth operator pairing outside the qr baseline profile", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, port, prevToken } = await startControlUiServer("secret");

    const { identityPath, identity, client } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-operator-",
    );

    try {
      const issued = await issueDeviceBootstrapToken({
        profile: {
          roles: ["operator"],
          scopes: ["operator.read"],
        },
      });
      const wsBootstrap = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const initial = await connectReq(wsBootstrap, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "operator",
        scopes: ["operator.read"],
        client,
        deviceIdentityPath: identityPath,
      });
      expect(initial.ok).toBe(false);
      expect(initial.error?.message ?? "").toContain("pairing required");
      expect((initial.error?.details as { code?: string } | undefined)?.code).toBe(
        ConnectErrorDetailCodes.PAIRING_REQUIRED,
      );

      const pending = (await listDevicePairing()).pending.filter(
        (entry) => entry.deviceId === identity.deviceId,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]?.role).toBe("operator");
      expectArrayIncludes(pending[0]?.scopes, ["operator.read"]);
      expect(await getPairedDevice(identity.deviceId)).toBeNull();
      wsBootstrap.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });
}
