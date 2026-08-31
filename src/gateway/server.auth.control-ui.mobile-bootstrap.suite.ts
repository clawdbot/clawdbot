import { expect, test } from "vitest";
import {
  createOperatorIdentityFixture,
  REMOTE_BOOTSTRAP_HEADERS,
  startProxiedControlUiServer,
} from "./server.auth.control-ui.fixtures.test-support.js";
import {
  connectReq,
  ConnectErrorDetailCodes,
  openWs,
  restoreGatewayToken,
  rpcReq,
} from "./server.auth.test-helpers.js";

export function registerControlUiMobileBootstrapSuite(): void {
  const FULL_OPERATOR_SCOPES = [
    "operator.admin",
    "operator.approvals",
    "operator.questions",
    "operator.read",
    "operator.talk.secrets",
    "operator.write",
  ];

  const connectSetupCodeBootstrapNode = async (params: {
    identityPrefix: string;
    client: {
      id: string;
      version: string;
      platform: string;
      mode: "node";
      deviceFamily: string;
    };
    limited?: boolean;
    identityFixture?: Awaited<ReturnType<typeof createOperatorIdentityFixture>>;
  }) => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const { FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE, PAIRING_SETUP_BOOTSTRAP_PROFILE } =
      await import("../shared/device-bootstrap-profile.js");
    const identityFixture =
      params.identityFixture ?? (await createOperatorIdentityFixture(params.identityPrefix));
    const { identityPath, identity } = identityFixture;
    const { server, port, prevToken } = await startProxiedControlUiServer("secret");
    try {
      const wsBootstrap = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      try {
        const issued = await issueDeviceBootstrapToken({
          profile: params.limited
            ? PAIRING_SETUP_BOOTSTRAP_PROFILE
            : FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
        });
        const initial = await connectReq(wsBootstrap, {
          skipDefaultAuth: true,
          bootstrapToken: issued.token,
          role: "node",
          scopes: [],
          client: params.client,
          deviceIdentityPath: identityPath,
        });
        return { identity, initial };
      } finally {
        wsBootstrap.close();
      }
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  };
  test("voice-node setup code reconnects with node and Talk-only operator tokens", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const { VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE } =
      await import("../shared/device-bootstrap-profile.js");
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, port, prevToken } = await startProxiedControlUiServer("secret");
    const { identityPath, identity } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-voice-node-",
    );
    const client = {
      id: "node-host",
      version: "1.0.0",
      platform: "esp32",
      mode: "node" as const,
      deviceFamily: "ESP32",
    };

    try {
      const issued = await issueDeviceBootstrapToken({
        profile: VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
      });
      const wsBootstrap = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const initial = await connectReq(wsBootstrap, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "node",
        scopes: [],
        client,
        deviceIdentityPath: identityPath,
      });
      if (!initial.ok) {
        throw new Error(`voice-node bootstrap failed: ${JSON.stringify(initial.error)}`);
      }
      expect(initial.ok).toBe(true);
      const auth = (
        initial.payload as
          | {
              auth?: {
                role?: string;
                scopes?: string[];
                deviceToken?: string;
                deviceTokens?: Array<{
                  role?: string;
                  scopes?: string[];
                  deviceToken?: string;
                }>;
              };
            }
          | undefined
      )?.auth;
      expect(auth?.role).toBe("node");
      expect(auth?.scopes).toEqual([]);
      const nodeToken = auth?.deviceToken;
      if (!nodeToken) {
        throw new Error("expected issued voice-node device token");
      }
      const operatorHandoff = auth?.deviceTokens?.find((entry) => entry.role === "operator");
      expect(operatorHandoff).toMatchObject({
        scopes: ["operator.read", "operator.talk"],
        deviceToken: expect.any(String),
      });
      const operatorToken = operatorHandoff?.deviceToken;
      if (!operatorToken) {
        throw new Error("expected handed-off voice-node operator token");
      }
      expect((await listDevicePairing()).pending).toEqual([]);
      const paired = await getPairedDevice(identity.deviceId);
      expect(paired?.roles).toEqual(["node", "operator"]);
      expect(paired?.approvedScopes).toEqual(["operator.read", "operator.talk"]);
      wsBootstrap.close();

      const wsNode = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const nodeReconnect = await connectReq(wsNode, {
        skipDefaultAuth: true,
        deviceToken: nodeToken,
        role: "node",
        scopes: [],
        client,
        deviceIdentityPath: identityPath,
      });
      expect(nodeReconnect.ok).toBe(true);
      wsNode.close();

      const wsOperator = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const operatorReconnect = await connectReq(wsOperator, {
        skipDefaultAuth: true,
        deviceToken: operatorToken,
        role: "operator",
        scopes: ["operator.read", "operator.talk"],
        client,
        deviceIdentityPath: identityPath,
      });
      expect(operatorReconnect.ok).toBe(true);
      expect((await rpcReq(wsOperator, "health")).ok).toBe(true);
      const talkMode = await rpcReq(wsOperator, "talk.mode", {
        enabled: true,
        phase: "listening",
      });
      expect(talkMode.ok).toBe(true);
      expect(talkMode.payload).toMatchObject({ enabled: true, phase: "listening" });
      const adminMutation = await rpcReq(wsOperator, "set-heartbeats", { enabled: false });
      expect(adminMutation.ok).toBe(false);
      expect(adminMutation.error?.message ?? "").toContain("missing scope");
      wsOperator.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("qr setup code returns node token plus full operator handoff", async () => {
    const { issueDeviceBootstrapToken, verifyDeviceBootstrapToken } =
      await import("../infra/device-bootstrap.js");
    const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
    const { FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE } =
      await import("../shared/device-bootstrap-profile.js");
    const { verifyDeviceToken } = await import("../infra/device-pairing-tokens.js");
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, port, prevToken } = await startProxiedControlUiServer("secret");

    const { identityPath, identity } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-node-",
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
      const wsBootstrap = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const initial = await connectReq(wsBootstrap, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "node",
        scopes: [],
        client,
        deviceIdentityPath: identityPath,
      });
      expect(initial.ok).toBe(true);
      const approvedPayload = initial.payload as
        | {
            type?: string;
            auth?: {
              deviceToken?: string;
              recoveryScope?: string;
              role?: string;
              scopes?: string[];
              deviceTokens?: Array<{
                deviceToken?: string;
                role?: string;
                scopes?: string[];
              }>;
            };
          }
        | undefined;
      expect(approvedPayload?.type).toBe("hello-ok");
      const issuedDeviceToken = approvedPayload?.auth?.deviceToken;
      if (!issuedDeviceToken) {
        throw new Error("expected issued device token");
      }
      expect(approvedPayload?.auth?.role).toBe("node");
      expect(approvedPayload?.auth?.scopes ?? []).toEqual([]);
      const operatorHandoff = approvedPayload?.auth?.deviceTokens?.find(
        (entry) => entry.role === "operator",
      );
      const issuedOperatorToken = operatorHandoff?.deviceToken;
      if (!issuedOperatorToken) {
        throw new Error("expected handed-off operator device token");
      }
      expect(operatorHandoff?.scopes).toEqual(FULL_OPERATOR_SCOPES);

      const pendingAfterInitial = await listDevicePairing();
      const pendingForDevice = pendingAfterInitial.pending.filter(
        (entry) => entry.deviceId === identity.deviceId,
      );
      expect(pendingForDevice).toEqual([]);
      wsBootstrap.close();

      const paired = await getPairedDevice(identity.deviceId);
      expect(paired?.roles).toEqual(["node", "operator"]);
      expect(paired?.approvedScopes).toEqual(FULL_OPERATOR_SCOPES);
      expect(paired?.tokens?.node?.token).toBe(issuedDeviceToken);
      expect(paired?.tokens?.node?.scopes).toEqual([]);
      expect(paired?.tokens?.operator?.token).toBe(issuedOperatorToken);
      expect(paired?.tokens?.operator?.scopes).toEqual(FULL_OPERATOR_SCOPES);

      const wsReplay = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const replay = await connectReq(wsReplay, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "node",
        scopes: [],
        client,
        deviceIdentityPath: identityPath,
      });
      expect(replay.ok).toBe(false);
      expect((replay.error?.details as { code?: string } | undefined)?.code).toBe(
        ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID,
      );
      wsReplay.close();

      const wsReconnect = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const reconnect = await connectReq(wsReconnect, {
        skipDefaultAuth: true,
        deviceToken: issuedDeviceToken,
        role: "node",
        scopes: [],
        client,
        deviceIdentityPath: identityPath,
      });
      expect(reconnect.ok).toBe(true);
      wsReconnect.close();

      await expect(
        verifyDeviceBootstrapToken({
          token: issued.token,
          deviceId: identity.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
          role: "node",
          scopes: [],
        }),
      ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

      await expect(
        verifyDeviceToken({
          deviceId: identity.deviceId,
          token: issuedDeviceToken,
          role: "node",
          scopes: [],
        }),
      ).resolves.toEqual({ ok: true });
      await expect(
        verifyDeviceToken({
          deviceId: identity.deviceId,
          token: issuedOperatorToken,
          role: "operator",
          scopes: [
            "operator.admin",
            "operator.approvals",
            "operator.read",
            "operator.talk.secrets",
            "operator.write",
          ],
        }),
      ).resolves.toEqual({ ok: true });
      await expect(
        verifyDeviceToken({
          deviceId: identity.deviceId,
          token: issuedOperatorToken,
          role: "operator",
          scopes: ["operator.admin"],
        }),
      ).resolves.toEqual({ ok: true });
      await expect(
        verifyDeviceToken({
          deviceId: identity.deviceId,
          token: issuedOperatorToken,
          role: "operator",
          scopes: ["operator.pairing"],
        }),
      ).resolves.toEqual({ ok: true });
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test.each([
    {
      name: "Android",
      identityPrefix: "openclaw-bootstrap-android-node-",
      client: {
        id: "openclaw-android",
        version: "2026.6.2",
        platform: "Android 16",
        mode: "node" as const,
        deviceFamily: "Android",
      },
    },
    {
      name: "iPadOS",
      identityPrefix: "openclaw-bootstrap-ipados-node-",
      client: {
        id: "openclaw-ios",
        version: "2026.6.2",
        platform: "iPadOS 26.3.1",
        mode: "node" as const,
        deviceFamily: "iPad",
      },
    },
  ])(
    "qr setup code auto-approves $name clients when mobile metadata matches",
    async ({ client, identityPrefix }) => {
      const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
      const { identity, initial } = await connectSetupCodeBootstrapNode({
        identityPrefix,
        client,
      });
      expect(initial.ok).toBe(true);
      const approvedPayload = initial.payload as
        | {
            type?: string;
            auth?: {
              deviceToken?: string;
              role?: string;
              scopes?: string[];
              deviceTokens?: Array<{ deviceToken?: string; role?: string; scopes?: string[] }>;
            };
          }
        | undefined;
      expect(approvedPayload?.type).toBe("hello-ok");
      expect(approvedPayload?.auth?.deviceToken).toBeTruthy();
      expect(approvedPayload?.auth?.role).toBe("node");
      expect(approvedPayload?.auth?.scopes ?? []).toEqual([]);
      const operatorHandoff = approvedPayload?.auth?.deviceTokens?.find(
        (entry) => entry.role === "operator",
      );
      expect(operatorHandoff?.deviceToken).toBeTruthy();
      expect(operatorHandoff?.scopes).toEqual(FULL_OPERATOR_SCOPES);

      const pendingAfterInitial = await listDevicePairing();
      expect(
        pendingAfterInitial.pending.filter((entry) => entry.deviceId === identity.deviceId),
      ).toEqual([]);
      const paired = await getPairedDevice(identity.deviceId);
      expect(paired?.roles).toEqual(["node", "operator"]);
      expect(paired?.approvedScopes).toEqual(FULL_OPERATOR_SCOPES);
    },
  );

  test("limited qr setup keeps the previous bounded operator handoff", async () => {
    const { identity, initial } = await connectSetupCodeBootstrapNode({
      identityPrefix: "openclaw-bootstrap-limited-node-",
      client: {
        id: "openclaw-ios",
        version: "2026.7.13",
        platform: "iOS 26.3.1",
        mode: "node",
        deviceFamily: "iPhone",
      },
      limited: true,
    });
    expect(initial.ok).toBe(true);
    const payload = initial.payload as
      | {
          auth?: {
            deviceTokens?: Array<{ deviceToken?: string; role?: string; scopes?: string[] }>;
          };
        }
      | undefined;
    const operatorHandoff = payload?.auth?.deviceTokens?.find((entry) => entry.role === "operator");
    const operatorToken = operatorHandoff?.deviceToken;
    if (!operatorToken) {
      throw new Error("expected handed-off limited operator device token");
    }
    expect(operatorHandoff?.scopes).toEqual([
      "operator.approvals",
      "operator.questions",
      "operator.read",
      "operator.talk.secrets",
      "operator.write",
    ]);
    expect(operatorHandoff?.scopes).not.toContain("operator.admin");

    const { verifyDeviceToken } = await import("../infra/device-pairing-tokens.js");
    const { getPairedDevice } = await import("../infra/device-pairing.js");
    const paired = await getPairedDevice(identity.deviceId);
    expect(paired?.approvedScopes).not.toContain("operator.admin");
    expect(paired?.tokens?.operator?.scopes).not.toContain("operator.admin");
    await expect(
      verifyDeviceToken({
        deviceId: identity.deviceId,
        token: operatorToken,
        role: "operator",
        scopes: ["operator.admin"],
      }),
    ).resolves.toEqual({ ok: false, reason: "scope-mismatch" });
    await expect(
      verifyDeviceToken({
        deviceId: identity.deviceId,
        token: operatorToken,
        role: "operator",
        scopes: ["operator.pairing"],
      }),
    ).resolves.toEqual({ ok: false, reason: "scope-mismatch" });
  });

  test("full qr setup upgrades an existing limited mobile pairing", async () => {
    const identityPrefix = "openclaw-bootstrap-limited-upgrade-node-";
    const client = {
      id: "openclaw-ios",
      version: "2026.7.13",
      platform: "iOS 26.3.1",
      mode: "node" as const,
      deviceFamily: "iPhone",
    };
    const identityFixture = await createOperatorIdentityFixture(identityPrefix);
    const limited = await connectSetupCodeBootstrapNode({
      identityPrefix,
      client,
      limited: true,
      identityFixture,
    });
    const upgraded = await connectSetupCodeBootstrapNode({
      identityPrefix,
      client,
      identityFixture,
    });
    expect(upgraded.identity.deviceId).toBe(limited.identity.deviceId);
    expect(upgraded.initial.ok).toBe(true);

    const payload = upgraded.initial.payload as
      | {
          auth?: {
            deviceTokens?: Array<{ role?: string; scopes?: string[] }>;
          };
        }
      | undefined;
    expect(
      payload?.auth?.deviceTokens?.find((entry) => entry.role === "operator")?.scopes,
    ).toContain("operator.admin");

    const { getPairedDevice } = await import("../infra/device-pairing.js");
    const paired = await getPairedDevice(upgraded.identity.deviceId);
    expect(paired?.approvedScopes).toContain("operator.admin");
    expect(paired?.tokens?.operator?.scopes).toContain("operator.admin");
  });

  test.each([
    {
      name: "mobile client id with mismatched platform metadata",
      identityPrefix: "openclaw-bootstrap-mobile-spoof-",
      client: {
        id: "openclaw-android",
        version: "2026.6.2",
        platform: "iOS 26.3.1",
        mode: "node" as const,
        deviceFamily: "iPhone",
      },
    },
    {
      name: "valid non-mobile client id with mobile metadata",
      identityPrefix: "openclaw-bootstrap-node-host-spoof-",
      client: {
        id: "node-host",
        version: "2026.6.2",
        platform: "Android 16",
        mode: "node" as const,
        deviceFamily: "Android",
      },
    },
  ])(
    "requires owner approval for setup-code bootstrap spoof: $name",
    async ({ client, identityPrefix }) => {
      const { listDevicePairing } = await import("../infra/device-pairing.js");
      const { identity, initial } = await connectSetupCodeBootstrapNode({
        identityPrefix,
        client,
      });
      expect(initial.ok).toBe(false);
      expect(initial.error?.message ?? "").toContain("pairing required");
      expect(
        initial.error?.details as { code?: string; pauseReconnect?: boolean } | undefined,
      ).toMatchObject({
        code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
        pauseReconnect: false,
      });

      const pending = (await listDevicePairing()).pending.find(
        (entry) => entry.deviceId === identity.deviceId,
      );
      expect(pending).toMatchObject({
        clientId: client.id,
        clientMode: client.mode,
        role: "node",
        scopes: [],
      });
    },
  );
}
