import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test } from "vitest";
import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";
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
import { connectWatchNode, readJson } from "./watch-node-http.test-helpers.js";

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
  const embeddedVoiceClient = {
    id: "node-host",
    version: "1.0.0",
    platform: "esp32",
    mode: "node",
    deviceFamily: "ESP32",
  } satisfies ConnectParams["client"];
  const watchVoiceClient = {
    id: "openclaw-watchos",
    version: "1.0.0",
    platform: "watchOS 11.5.0",
    mode: "node",
    deviceFamily: "Apple Watch",
  } satisfies ConnectParams["client"];
  test.each([
    {
      name: "embedded WebSocket",
      watchHttp: false,
      client: embeddedVoiceClient,
      operatorClient: embeddedVoiceClient,
      allowed: true,
    },
    {
      name: "Watch HTTP",
      watchHttp: true,
      client: watchVoiceClient,
      operatorClient: watchVoiceClient,
      allowed: true,
    },
    {
      name: "Watch HTTP after OS update",
      watchHttp: true,
      client: watchVoiceClient,
      operatorClient: { ...watchVoiceClient, platform: "watchOS 11.6.0" },
      allowed: true,
    },
    {
      name: "Watch HTTP with changed platform family",
      watchHttp: true,
      client: watchVoiceClient,
      operatorClient: { ...watchVoiceClient, platform: "iOS 26.4.0" },
      allowed: false,
    },
    {
      name: "Watch HTTP with changed device family",
      watchHttp: true,
      client: watchVoiceClient,
      operatorClient: { ...watchVoiceClient, deviceFamily: "iPhone" },
      allowed: false,
    },
  ])(
    "voice-node $name enforces reconnect metadata and Talk access",
    async ({ watchHttp, client, operatorClient, allowed }) => {
      const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
      const { VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE } =
        await import("../shared/device-bootstrap-profile.js");
      const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
      const { server, port, prevToken } = await startProxiedControlUiServer("secret");
      const { identityPath, identity } = await createOperatorIdentityFixture(
        "openclaw-bootstrap-voice-node-",
      );
      const sockets: Awaited<ReturnType<typeof openWs>>[] = [];

      try {
        let auth: unknown;
        if (watchHttp) {
          const { decodePairingSetupCode } = await import("../pairing/setup-code.js");
          const wsOwner = await openWs(port);
          sockets.push(wsOwner);
          expect(
            (await connectReq(wsOwner, { scopes: ["operator.admin"], prePairDevice: true })).ok,
          ).toBe(true);
          const setup = await rpcReq<{ setupCode: string }>(wsOwner, "device.pair.setupCode", {
            bootstrapProfile: "voice-node",
            includeQr: false,
            publicUrl: `ws://127.0.0.1:${port}`,
          });
          expect(setup.ok).toBe(true);
          const setupCode = setup.payload?.setupCode;
          if (!setupCode) {
            throw new Error("expected owner-issued Watch setup code");
          }
          const bootstrap = decodePairingSetupCode(setupCode);
          const response = await connectWatchNode({
            baseUrl: `${bootstrap.url.replace("ws:", "http:")}/api/nodes/watch`,
            identity,
            client,
            bootstrapToken: bootstrap.bootstrapToken,
          });
          expect(response.status).toBe(200);
          auth = await readJson(response);
          wsOwner.close();
        } else {
          const issued = await issueDeviceBootstrapToken({
            profile: VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
          });
          const wsBootstrap = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
          sockets.push(wsBootstrap);
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
          if (!isRecord(initial.payload)) {
            throw new Error("expected voice-node hello payload");
          }
          auth = initial.payload.auth;
          expect(auth).toMatchObject({ role: "node", scopes: [] });
          wsBootstrap.close();
        }
        if (!isRecord(auth) || typeof auth.deviceToken !== "string" || !auth.deviceToken) {
          throw new Error("expected issued voice-node device token");
        }
        const nodeToken = auth.deviceToken;
        if (!Array.isArray(auth.deviceTokens)) {
          throw new Error("expected voice-node role grants");
        }
        const deviceTokens: unknown[] = auth.deviceTokens;
        const operatorHandoff = deviceTokens.find(
          (entry) => isRecord(entry) && entry.role === "operator",
        );
        expect(operatorHandoff).toMatchObject({
          scopes: ["operator.read", "operator.talk"],
          deviceToken: expect.any(String),
        });
        if (
          !isRecord(operatorHandoff) ||
          typeof operatorHandoff.deviceToken !== "string" ||
          !operatorHandoff.deviceToken
        ) {
          throw new Error("expected handed-off voice-node operator token");
        }
        const operatorToken = operatorHandoff.deviceToken;
        expect((await listDevicePairing()).pending).toEqual([]);
        const paired = await getPairedDevice(identity.deviceId);
        expect(paired?.roles).toEqual(["node", "operator"]);
        expect(paired?.approvedScopes).toEqual(["operator.read", "operator.talk"]);

        const wsNode = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
        sockets.push(wsNode);
        const nodeReconnect = await connectReq(wsNode, {
          skipDefaultAuth: true,
          prePairDevice: false,
          deviceToken: nodeToken,
          role: "node",
          scopes: [],
          client,
          ...(watchHttp
            ? {
                commands: ["device.info", "device.status", "system.notify"],
                permissions: { notifications: true },
              }
            : {}),
          deviceIdentityPath: identityPath,
        });
        expect(nodeReconnect.ok).toBe(true);
        wsNode.close();

        const wsOperator = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
        sockets.push(wsOperator);
        const operatorReconnect = await connectReq(wsOperator, {
          skipDefaultAuth: true,
          prePairDevice: false,
          deviceToken: operatorToken,
          role: "operator",
          scopes: ["operator.read", "operator.talk"],
          client: operatorClient,
          deviceIdentityPath: identityPath,
        });
        if (!allowed) {
          expect(operatorReconnect.ok).toBe(false);
          expect(operatorReconnect.error?.details).toMatchObject({
            code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
          });
          expect((await getPairedDevice(identity.deviceId))?.platform).toBe(client.platform);
          return;
        }
        expect(operatorReconnect.ok).toBe(true);
        expect((await getPairedDevice(identity.deviceId))?.platform).toBe(operatorClient.platform);
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
        for (const socket of sockets) {
          socket.close();
        }
        await server.close();
        restoreGatewayToken(prevToken);
      }
    },
  );

  test.each([
    { name: "Watch HTTP voice", watchHttp: true, client: watchVoiceClient, voice: true },
    {
      name: "embedded WebSocket voice",
      watchHttp: false,
      client: embeddedVoiceClient,
      voice: true,
    },
    { name: "Watch HTTP node-only", watchHttp: true, client: watchVoiceClient, voice: false },
  ])("$name setup retires only replaced operator grants", async ({ watchHttp, client, voice }) => {
    const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
    const { approveDevicePairing } = await import("../infra/device-pairing-approval.js");
    const { getPairedDevice, requestDevicePairing } = await import("../infra/device-pairing.js");
    const { decodePairingSetupCode } = await import("../pairing/setup-code.js");
    const { server, port, prevToken } = await startProxiedControlUiServer("secret");
    const { identityPath, identity } = await createOperatorIdentityFixture(
      "openclaw-watch-voice-existing-operator-",
    );
    const sockets: Awaited<ReturnType<typeof openWs>>[] = [];
    try {
      const pairing = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        platform: client.platform,
        deviceFamily: client.deviceFamily,
        clientId: client.id,
        clientMode: client.mode,
        role: "operator",
        roles: ["node", "operator"],
        scopes: ["operator.read", "operator.approvals"],
      });
      const approved = await approveDevicePairing(pairing.request.requestId, {
        callerScopes: ["operator.admin"],
      });
      expect(approved?.status).toBe("approved");
      const oldToken = (await getPairedDevice(identity.deviceId))?.tokens?.operator?.token;
      if (!oldToken) {
        throw new Error("expected the previously approved operator token");
      }
      const oldOperator = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      sockets.push(oldOperator);
      expect(
        (
          await connectReq(oldOperator, {
            skipDefaultAuth: true,
            prePairDevice: false,
            deviceToken: oldToken,
            role: "operator",
            scopes: ["operator.read", "operator.approvals"],
            client,
            deviceIdentityPath: identityPath,
          })
        ).ok,
      ).toBe(true);
      expect((await rpcReq(oldOperator, "health")).ok).toBe(true);
      const oldOperatorClosed = new Promise<false>((resolve) => {
        oldOperator.once("close", () => resolve(false));
      });

      const owner = await openWs(port);
      sockets.push(owner);
      expect(
        (await connectReq(owner, { scopes: ["operator.admin"], prePairDevice: true })).ok,
      ).toBe(true);
      const setup = await rpcReq<{ setupCode: string }>(owner, "device.pair.setupCode", {
        bootstrapProfile: voice ? "voice-node" : "node",
        includeQr: false,
        publicUrl: `ws://127.0.0.1:${port}`,
      });
      expect(setup.ok).toBe(true);
      if (!setup.payload?.setupCode) {
        throw new Error("expected owner-authorized voice setup");
      }
      const bootstrap = decodePairingSetupCode(setup.payload.setupCode);
      if (watchHttp) {
        const response = await connectWatchNode({
          baseUrl: `${bootstrap.url.replace("ws:", "http:")}/api/nodes/watch`,
          identity,
          client,
          bootstrapToken: bootstrap.bootstrapToken,
        });
        expect(response.status).toBe(200);
        await readJson(response);
      } else {
        const node = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
        sockets.push(node);
        const connected = await connectReq(node, {
          skipDefaultAuth: true,
          bootstrapToken: bootstrap.bootstrapToken,
          role: "node",
          scopes: [],
          client,
          deviceIdentityPath: identityPath,
        });
        expect(connected.ok).toBe(true);
      }
      expect(new Set((await getPairedDevice(identity.deviceId))?.approvedScopes)).toEqual(
        new Set(
          voice ? ["operator.read", "operator.talk"] : ["operator.read", "operator.approvals"],
        ),
      );

      const oldGrantStillConnected = await Promise.race([
        oldOperatorClosed,
        rpcReq(oldOperator, "health").then((reply) => reply.ok),
      ]);
      expect(oldGrantStillConnected).toBe(!voice);
    } finally {
      for (const socket of sockets) {
        socket.close();
      }
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
