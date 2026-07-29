// Device token rotation tests cover pairing-scoped operators, admin rotation
// rights, approved node reconnects, and invoke continuity after token changes.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
  pairDeviceIdentity,
  resolveDeviceIdentityPath,
} from "./device-authz.test-helpers.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServer,
  startServerWithClient,
} from "./test-helpers.js";
import {
  acknowledgeNodeInvokeRequestForTest,
  getConnectedNodeIdForTest,
} from "./test-helpers.node-invoke.js";

installGatewayTestHooks({ scope: "suite" });

async function connectPairingScopedOperator(params: {
  port: number;
  identityPath: string;
  deviceToken: string;
}): Promise<WebSocket> {
  const ws = await openTrackedWs(params.port);
  await connectOk(ws, {
    skipDefaultAuth: true,
    deviceToken: params.deviceToken,
    deviceIdentityPath: params.identityPath,
    scopes: ["operator.pairing"],
  });
  return ws;
}

async function connectApprovedNode(params: {
  port: number;
  name: string;
  onInvoke: (payload: unknown) => void;
}): Promise<GatewayClient> {
  const paired = await pairDeviceIdentity({
    name: params.name,
    role: "node",
    scopes: [],
    clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
  });

  let readyResolve: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  const client = new GatewayClient({
    url: `ws://127.0.0.1:${params.port}`,
    connectChallengeTimeoutMs: 2_000,
    token: "secret",
    role: "node",
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientVersion: "1.0.0",
    platform: "linux",
    mode: GATEWAY_CLIENT_MODES.NODE,
    scopes: [],
    commands: ["system.run"],
    deviceIdentity: paired.identity,
    onHelloOk: () => readyResolve?.(),
    onEvent: (event) =>
      acknowledgeNodeInvokeRequestForTest({
        client,
        event,
        onInvoke: params.onInvoke,
      }),
  });
  client.start();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout waiting for node hello")), 5_000);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
  return client;
}

async function waitForMacrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

type StartedGatewayClient = Awaited<ReturnType<typeof startServerWithClient>>;
type StartedGatewayServer = Awaited<ReturnType<typeof startServer>>;
type IssuedOperatorToken = Awaited<ReturnType<typeof issueOperatorToken>>;
type PairingScopedDevice = Awaited<ReturnType<typeof issueMixedRolePairingScopedDevice>>;
type PairedDevice = NonNullable<Awaited<ReturnType<typeof getPairedDevice>>>;
type PairedDeviceToken = NonNullable<NonNullable<PairedDevice["tokens"]>["node"]>;
type RevokedNodeDeviceContext = {
  started: StartedGatewayClient;
  device: PairingScopedDevice;
  revokedNodeToken: PairedDeviceToken;
  connectPairingWs: () => Promise<WebSocket>;
};

async function issuePairingScopedTokenForAdminApprovedDevice(name: string): Promise<{
  deviceId: string;
  identityPath: string;
  pairingToken: string;
}> {
  const issued = await issueOperatorToken({
    name,
    approvedScopes: ["operator.admin"],
    tokenScopes: ["operator.pairing"],
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
  });
  return {
    deviceId: issued.deviceId,
    identityPath: issued.identityPath,
    pairingToken: issued.token,
  };
}

async function issueTestOperatorToken(params: {
  name: string;
  approvedScopes: string[];
  tokenScopes?: string[];
}) {
  return await issueOperatorToken({
    name: params.name,
    approvedScopes: params.approvedScopes,
    ...(params.tokenScopes ? { tokenScopes: params.tokenScopes } : {}),
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
  });
}

async function issuePairingScopedAdminToken(name: string): Promise<IssuedOperatorToken> {
  return await issueTestOperatorToken({
    name,
    approvedScopes: ["operator.admin"],
    tokenScopes: ["operator.pairing"],
  });
}

async function issuePairingOnlyOperatorToken(name: string): Promise<IssuedOperatorToken> {
  return await issueTestOperatorToken({
    name,
    approvedScopes: ["operator.pairing"],
    tokenScopes: ["operator.pairing"],
  });
}

async function issueMixedRolePairingScopedDevice(
  name: string,
  opts?: { platform?: string },
): Promise<{
  deviceId: string;
  identityPath: string;
  identity: ReturnType<typeof loadDeviceIdentity>["identity"];
  pairingToken: string;
  publicKey: string;
}> {
  const loaded = loadDeviceIdentity(name);
  const request = await requestDevicePairing({
    deviceId: loaded.identity.deviceId,
    publicKey: loaded.publicKey,
    role: "operator",
    roles: ["operator", "node"],
    scopes: ["operator.pairing"],
    ...(opts?.platform ? { platform: opts.platform } : {}),
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
  });
  const approved = await approveDevicePairing(request.request.requestId, {
    callerScopes: ["operator.pairing"],
  });
  expect(approved?.status).toBe("approved");
  if (approved?.status !== "approved") {
    throw new Error("expected mixed-role device approval");
  }
  const pairingToken = approved.device.tokens?.operator?.token;
  if (!pairingToken) {
    throw new Error(`expected operator token for paired device ${loaded.identity.deviceId}`);
  }
  expect(approved.device.tokens?.node?.token).toBeTypeOf("string");
  return {
    deviceId: loaded.identity.deviceId,
    identityPath: loaded.identityPath,
    identity: loaded.identity,
    pairingToken,
    publicKey: loaded.publicKey,
  };
}

async function connectPairingScopedDeviceOperator(
  port: number,
  device: Pick<PairingScopedDevice, "identityPath" | "pairingToken">,
): Promise<WebSocket> {
  return await connectPairingScopedOperator({
    port,
    identityPath: device.identityPath,
    deviceToken: device.pairingToken,
  });
}

async function connectPairingScopedIssuedOperator(
  port: number,
  issued: Pick<IssuedOperatorToken, "identityPath" | "token">,
): Promise<WebSocket> {
  return await connectPairingScopedOperator({
    port,
    identityPath: issued.identityPath,
    deviceToken: issued.token,
  });
}

async function closeStartedClient(started: StartedGatewayClient) {
  started.ws.close();
  await started.server.close();
  started.envSnapshot.restore();
}

async function withStartedServer(callback: (started: StartedGatewayServer) => Promise<void>) {
  const started = await startServer("secret");
  try {
    await callback(started);
  } finally {
    await started.server.close();
    started.envSnapshot.restore();
  }
}

async function withPairingScopedIssuedWs(
  started: Pick<StartedGatewayServer, "port">,
  issued: Pick<IssuedOperatorToken, "identityPath" | "token">,
  callback: (ws: WebSocket) => Promise<void>,
) {
  const pairingWs = await connectPairingScopedIssuedOperator(started.port, issued);
  try {
    await callback(pairingWs);
  } finally {
    pairingWs.close();
  }
}

async function revokeNodeToken(ws: WebSocket, deviceId: string): Promise<PairedDeviceToken> {
  const revoke = await rpcReq<{ revokedAtMs?: number }>(ws, "device.token.revoke", {
    deviceId,
    role: "node",
  });
  expect(revoke.ok).toBe(true);
  expect(revoke.payload?.revokedAtMs).toBeTypeOf("number");

  const pairedAfterRevoke = await getPairedDevice(deviceId);
  const revokedNodeToken = pairedAfterRevoke?.tokens?.node;
  expect(revokedNodeToken?.revokedAtMs).toBeTypeOf("number");
  if (!revokedNodeToken) {
    throw new Error("expected revoked node token");
  }
  return revokedNodeToken;
}

function expectNodeTokenStillRevoked(
  paired: PairedDevice | null | undefined,
  revokedNodeToken: PairedDeviceToken,
) {
  expect(paired?.tokens?.node?.token).toBe(revokedNodeToken?.token);
  expect(paired?.tokens?.node?.revokedAtMs).toBe(revokedNodeToken?.revokedAtMs);
}

async function expectLocalNodeReconnectDenied(params: {
  started: StartedGatewayClient;
  device: PairingScopedDevice;
  clientName?: GatewayClientName;
  clientDisplayName: string;
  platform?: string;
  mode?: GatewayClientMode;
  timeoutMessage: string;
  message?: string;
}) {
  await expect(
    connectGatewayClient({
      url: `ws://127.0.0.1:${params.started.port}`,
      token: "secret",
      role: "node",
      clientName: params.clientName ?? GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: params.clientDisplayName,
      clientVersion: "1.0.0",
      platform: params.platform ?? "linux",
      mode: params.mode ?? GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands: ["system.run"],
      deviceIdentity: params.device.identity,
      timeoutMessage: params.timeoutMessage,
    }),
  ).rejects.toThrow(params.message ?? "role upgrade pending approval");
}

async function rotateOperatorToken(ws: WebSocket, params: { deviceId: string; scopes?: string[] }) {
  return await rpcReq(ws, "device.token.rotate", {
    deviceId: params.deviceId,
    role: "operator",
    ...(params.scopes ? { scopes: params.scopes } : {}),
  });
}

function expectDeniedRotation(response: Awaited<ReturnType<typeof rotateOperatorToken>>) {
  expect(response.ok).toBe(false);
  expect(response.error?.message).toBe("device token rotation denied");
}

function expectPairingOnlyOperatorToken(paired: PairedDevice | null | undefined, token?: string) {
  expect(paired?.tokens?.operator?.scopes).toEqual(["operator.pairing"]);
  if (token !== undefined) {
    expect(paired?.tokens?.operator?.token).toBe(token);
  }
}

async function withRevokedNodeDevice(
  name: string,
  callback: (context: RevokedNodeDeviceContext) => Promise<void>,
  opts?: { platform?: string },
) {
  const started = await startServerWithClient("secret");
  const device = await issueMixedRolePairingScopedDevice(name, opts);

  let pairingWs: WebSocket | undefined;
  try {
    await connectOk(started.ws);
    const revokedNodeToken = await revokeNodeToken(started.ws, device.deviceId);

    await callback({
      started,
      device,
      revokedNodeToken,
      connectPairingWs: async () => {
        pairingWs = await connectPairingScopedDeviceOperator(started.port, device);
        return pairingWs;
      },
    });
  } finally {
    pairingWs?.close();
    await closeStartedClient(started);
  }
}

describe("gateway device.token.rotate/revoke ownership guard (IDOR)", () => {
  let ownershipGuardServer: Awaited<ReturnType<typeof startServer>>;
  let pairingScopeDeniedCase: {
    pairedBAfterRevokeRevokedAtMs: unknown;
    pairedBToken: string | undefined;
    revokeMessage: string | undefined;
    revokeOk: boolean;
    rotateMessage: string | undefined;
    rotateOk: boolean;
    token: string;
  };

  beforeAll(async () => {
    ownershipGuardServer = await startServer("secret");
    const deviceA = await issuePairingScopedTokenForAdminApprovedDevice("idor-device-a");
    const deviceB = await issuePairingScopedTokenForAdminApprovedDevice("idor-device-b");

    let pairingWs: WebSocket | undefined;
    try {
      pairingWs = await connectPairingScopedOperator({
        port: ownershipGuardServer.port,
        identityPath: deviceA.identityPath,
        deviceToken: deviceA.pairingToken,
      });

      const rotate = await rpcReq(pairingWs, "device.token.rotate", {
        deviceId: deviceB.deviceId,
        role: "operator",
        scopes: ["operator.pairing"],
      });
      const pairedB = await getPairedDevice(deviceB.deviceId);

      const revoke = await rpcReq(pairingWs, "device.token.revoke", {
        deviceId: deviceB.deviceId,
        role: "operator",
      });
      const pairedBAfterRevoke = await getPairedDevice(deviceB.deviceId);
      pairingScopeDeniedCase = {
        pairedBAfterRevokeRevokedAtMs: pairedBAfterRevoke?.tokens?.operator?.revokedAtMs,
        pairedBToken: pairedB?.tokens?.operator?.token,
        revokeMessage: revoke.error?.message,
        revokeOk: revoke.ok,
        rotateMessage: rotate.error?.message,
        rotateOk: rotate.ok,
        token: deviceB.pairingToken,
      };
    } finally {
      pairingWs?.close();
    }
  });

  afterAll(async () => {
    await ownershipGuardServer.server.close();
    ownershipGuardServer.envSnapshot.restore();
  });

  test("rejects a device-token caller rotating or revoking another device's token", async () => {
    expect(pairingScopeDeniedCase.rotateOk).toBe(false);
    expect(pairingScopeDeniedCase.rotateMessage).toBe("device token rotation denied");
    expect(pairingScopeDeniedCase.pairedBToken).toBe(pairingScopeDeniedCase.token);
    expect(pairingScopeDeniedCase.revokeOk).toBe(false);
    expect(pairingScopeDeniedCase.revokeMessage).toBe("device token revocation denied");
    expect(pairingScopeDeniedCase.pairedBAfterRevokeRevokedAtMs).toBeUndefined();
  });

  test("allows an admin-scoped caller to rotate and revoke another device's token", async () => {
    const started = await startServerWithClient("secret");
    const device = await issuePairingScopedTokenForAdminApprovedDevice("idor-admin-rotate-revoke");

    try {
      await connectOk(started.ws);

      const rotate = await rpcReq<{ rotatedAtMs?: number; token?: string }>(
        started.ws,
        "device.token.rotate",
        {
          deviceId: device.deviceId,
          role: "operator",
          scopes: ["operator.pairing"],
        },
      );
      expect(rotate.ok).toBe(true);
      expect(rotate.payload?.rotatedAtMs).toBeTypeOf("number");
      expect(rotate.payload?.token).toBeUndefined();
      const pairedAfterRotate = await getPairedDevice(device.deviceId);
      const persistedToken = pairedAfterRotate?.tokens?.operator?.token;
      if (typeof persistedToken !== "string") {
        throw new Error("expected rotated operator token to persist");
      }
      expect(persistedToken.length).toBeGreaterThan(0);

      const revoke = await rpcReq<{ revokedAtMs?: number }>(started.ws, "device.token.revoke", {
        deviceId: device.deviceId,
        role: "operator",
      });
      expect(revoke.ok).toBe(true);
      expect(revoke.payload?.revokedAtMs).toBeTypeOf("number");

      const paired = await getPairedDevice(device.deviceId);
      expect(paired?.tokens?.operator?.revokedAtMs).toBeTypeOf("number");
    } finally {
      await closeStartedClient(started);
    }
  });

  test("rejects a pairing-scoped operator session rotating a revoked node token", async () => {
    await withRevokedNodeDevice(
      "same-device-node-token-rotate",
      async ({ device, revokedNodeToken, connectPairingWs }) => {
        const pairingWs = await connectPairingWs();

        const rotate = await rpcReq(pairingWs, "device.token.rotate", {
          deviceId: device.deviceId,
          role: "node",
        });
        expect(rotate.ok).toBe(false);
        expect(rotate.error?.message).toBe("device token rotation denied");

        const pairedAfterRotate = await getPairedDevice(device.deviceId);
        expectNodeTokenStillRevoked(pairedAfterRotate, revokedNodeToken);
      },
    );
  });

  test("rejects a pairing-scoped operator session approving a refreshed node token", async () => {
    await withRevokedNodeDevice(
      "same-device-node-pair-approve",
      async ({ device, revokedNodeToken, connectPairingWs }) => {
        const request = await requestDevicePairing({
          deviceId: device.deviceId,
          publicKey: device.publicKey,
          role: "node",
          clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
          clientMode: GATEWAY_CLIENT_MODES.NODE,
        });

        const pairingWs = await connectPairingWs();

        const approve = await rpcReq(pairingWs, "device.pair.approve", {
          requestId: request.request.requestId,
        });
        expect(approve.ok).toBe(false);
        expect(approve.error?.message).toBe("device pairing approval denied");

        const pairedAfterApprove = await getPairedDevice(device.deviceId);
        expectNodeTokenStillRevoked(pairedAfterApprove, revokedNodeToken);
      },
    );
  });

  test("rejects local node reconnect after node token revocation", async () => {
    await withRevokedNodeDevice(
      "same-device-node-reconnect",
      async ({ started, device, revokedNodeToken }) => {
        await expectLocalNodeReconnectDenied({
          started,
          device,
          clientDisplayName: "node-token-revoked",
          timeoutMessage: "timeout waiting for revoked node reconnect",
        });

        const pairedAfterReconnect = await getPairedDevice(device.deviceId);
        expectNodeTokenStillRevoked(pairedAfterReconnect, revokedNodeToken);
      },
    );
  });

  test("rejects local node reconnect with metadata mismatch after node token revocation", async () => {
    await withRevokedNodeDevice(
      "same-device-node-metadata-reconnect",
      async ({ started, device, revokedNodeToken }) => {
        const pairedAfterRevoke = await getPairedDevice(device.deviceId);
        expect(pairedAfterRevoke?.platform).toBe("linux");

        await expectLocalNodeReconnectDenied({
          started,
          device,
          clientName: GATEWAY_CLIENT_NAMES.MACOS_APP,
          clientDisplayName: "node-token-metadata-mismatch",
          platform: "macos",
          mode: GATEWAY_CLIENT_MODES.UI,
          timeoutMessage: "timeout waiting for metadata mismatch node reconnect",
          message: "device metadata change pending approval",
        });

        const pairedAfterReconnect = await getPairedDevice(device.deviceId);
        expect(pairedAfterReconnect?.platform).toBe("linux");
        expectNodeTokenStillRevoked(pairedAfterReconnect, revokedNodeToken);
      },
      { platform: "linux" },
    );
  });

  test("rejects self-removal before local node reconnect after node token revocation", async () => {
    await withRevokedNodeDevice(
      "same-device-node-remove-reconnect",
      async ({ started, device, revokedNodeToken, connectPairingWs }) => {
        const pairingWs = await connectPairingWs();

        const remove = await rpcReq(pairingWs, "device.pair.remove", {
          deviceId: device.deviceId,
        });
        expect(remove.ok).toBe(false);
        expect(remove.error?.message).toBe("device pairing removal denied");

        await expectLocalNodeReconnectDenied({
          started,
          device,
          clientDisplayName: "node-token-removal-denied",
          timeoutMessage: "timeout waiting for denied removal node reconnect",
        });

        const pairedAfterReconnect = await getPairedDevice(device.deviceId);
        expectNodeTokenStillRevoked(pairedAfterReconnect, revokedNodeToken);
      },
    );
  });
});

describe("gateway device.token.rotate/revoke caller scope guard", () => {
  test("rejects shared-token callers rotating or revoking above their session scopes", async () => {
    await withStartedServer(async (started) => {
      const target = await issueTestOperatorToken({
        name: "shared-pairing-target",
        approvedScopes: ["operator.admin"],
      });

      const pairingWs = await openTrackedWs(started.port);
      try {
        await connectOk(pairingWs, {
          token: "secret",
          scopes: ["operator.pairing"],
          deviceIdentityPath: resolveDeviceIdentityPath("shared-pairing-caller"),
        });

        const rotate = await rpcReq(pairingWs, "device.token.rotate", {
          deviceId: target.deviceId,
          role: "operator",
        });
        expect(rotate.ok).toBe(false);
        expect(rotate.error?.message).toBe("device token rotation denied");

        const afterRotate = await getPairedDevice(target.deviceId);
        expect(afterRotate?.tokens?.operator?.token).toBe(target.token);
        expect(afterRotate?.tokens?.operator?.revokedAtMs).toBeUndefined();

        const revoke = await rpcReq(pairingWs, "device.token.revoke", {
          deviceId: target.deviceId,
          role: "operator",
        });
        expect(revoke.ok).toBe(false);
        expect(revoke.error?.message).toBe("device token revocation denied");

        const afterRevoke = await getPairedDevice(target.deviceId);
        expect(afterRevoke?.tokens?.operator?.token).toBe(target.token);
        expect(afterRevoke?.tokens?.operator?.revokedAtMs).toBeUndefined();
      } finally {
        pairingWs.close();
      }
    });
  });

  test("rejects rotating an admin-approved device token above the caller session scopes", async () => {
    await withStartedServer(async (started) => {
      const attacker = await issuePairingScopedAdminToken("rotate-attacker");

      await withPairingScopedIssuedWs(started, attacker, async (pairingWs) => {
        const rotate = await rotateOperatorToken(pairingWs, {
          deviceId: attacker.deviceId,
          scopes: ["operator.admin"],
        });
        expectDeniedRotation(rotate);

        const paired = await getPairedDevice(attacker.deviceId);
        expectPairingOnlyOperatorToken(paired);
        expect(paired?.approvedScopes).toEqual(["operator.admin"]);
      });
    });
  });

  test("blocks the pairing-token to admin-node-invoke escalation chain", async () => {
    const started = await startServerWithClient("secret");
    const attacker = await issuePairingScopedAdminToken("rotate-rce-attacker");

    let sawInvoke = false;
    let pairingWs: WebSocket | undefined;
    let nodeClient: GatewayClient | undefined;

    try {
      await connectOk(started.ws);
      nodeClient = await connectApprovedNode({
        port: started.port,
        name: "rotate-rce-node",
        onInvoke: () => {
          sawInvoke = true;
        },
      });
      await getConnectedNodeIdForTest(started.ws);

      pairingWs = await connectPairingScopedIssuedOperator(started.port, attacker);

      const rotate = await rotateOperatorToken(pairingWs, {
        deviceId: attacker.deviceId,
        scopes: ["operator.admin"],
      });

      expectDeniedRotation(rotate);
      await waitForMacrotasks();
      expect(sawInvoke).toBe(false);

      const paired = await getPairedDevice(attacker.deviceId);
      expectPairingOnlyOperatorToken(paired, attacker.token);
    } finally {
      pairingWs?.close();
      nodeClient?.stop();
      await closeStartedClient(started);
    }
  });

  test("returns the same public deny for unknown devices and caller scope failures", async () => {
    await withStartedServer(async (started) => {
      const attacker = await issuePairingScopedAdminToken("rotate-deny-shape");

      await withPairingScopedIssuedWs(started, attacker, async (pairingWs) => {
        const missingScope = await rotateOperatorToken(pairingWs, {
          deviceId: attacker.deviceId,
          scopes: ["operator.admin"],
        });
        const unknownDevice = await rotateOperatorToken(pairingWs, {
          deviceId: "missing-device",
          scopes: ["operator.pairing"],
        });

        expectDeniedRotation(missingScope);
        expectDeniedRotation(unknownDevice);
      });
    });
  });

  test("rejects rotating a token for an unapproved role on an existing paired device", async () => {
    await withStartedServer(async (started) => {
      const attacker = await issuePairingOnlyOperatorToken("rotate-unapproved-role");

      await withPairingScopedIssuedWs(started, attacker, async (pairingWs) => {
        const rotate = await rpcReq(pairingWs, "device.token.rotate", {
          deviceId: attacker.deviceId,
          role: "node",
        });

        expectDeniedRotation(rotate);

        const paired = await getPairedDevice(attacker.deviceId);
        expect(paired?.tokens?.node).toBeUndefined();
        expectPairingOnlyOperatorToken(paired);
      });
    });
  });
});
