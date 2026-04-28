import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { getPairedDevice } from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import {
  issueOperatorToken,
  openTrackedWs,
  pairDeviceIdentity,
  resolveDeviceIdentityPath,
} from "./device-authz.test-helpers.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServer,
  startServerWithClient,
} from "./test-helpers.js";

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
    onEvent: (event) => {
      if (event.event !== "node.invoke.request") {
        return;
      }
      params.onInvoke(event.payload);
      const payload = event.payload as { id?: string; nodeId?: string };
      if (!payload.id || !payload.nodeId) {
        return;
      }
      void client.request("node.invoke.result", {
        id: payload.id,
        nodeId: payload.nodeId,
        ok: true,
        payloadJSON: JSON.stringify({ ok: true }),
      });
    },
  });
  client.start();
  await Promise.race([
    ready,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("timeout waiting for node hello")), 5_000);
    }),
  ]);
  return client;
}

async function getConnectedNodeId(ws: WebSocket): Promise<string> {
  const nodes = await rpcReq<{ nodes?: Array<{ nodeId: string; connected?: boolean }> }>(
    ws,
    "node.list",
    {},
  );
  expect(nodes.ok).toBe(true);
  const nodeId = nodes.payload?.nodes?.find((node) => node.connected)?.nodeId ?? "";
  expect(nodeId).toBeTruthy();
  return nodeId;
}

async function waitForMacrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

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

describe("gateway device.token.rotate/revoke ownership guard (IDOR)", () => {
  test("rejects a device-token caller rotating or revoking another device's token", async () => {
    const started = await startServer("secret");
    const deviceA = await issuePairingScopedTokenForAdminApprovedDevice("idor-device-a");
    const deviceB = await issuePairingScopedTokenForAdminApprovedDevice("idor-device-b");

    let pairingWs: WebSocket | undefined;
    try {
      pairingWs = await connectPairingScopedOperator({
        port: started.port,
        identityPath: deviceA.identityPath,
        deviceToken: deviceA.pairingToken,
      });

      const rotate = await rpcReq(pairingWs, "device.token.rotate", {
        deviceId: deviceB.deviceId,
        role: "operator",
        scopes: ["operator.pairing"],
      });
      expect(rotate.ok).toBe(false);
      expect(rotate.error?.message).toBe("device token rotation denied");

      const pairedB = await getPairedDevice(deviceB.deviceId);
      expect(pairedB?.tokens?.operator?.token).toBe(deviceB.pairingToken);

      const revoke = await rpcReq(pairingWs, "device.token.revoke", {
        deviceId: deviceB.deviceId,
        role: "operator",
      });
      expect(revoke.ok).toBe(false);
      expect(revoke.error?.message).toBe("device token revocation denied");

      const pairedBAfterRevoke = await getPairedDevice(deviceB.deviceId);
      expect(pairedBAfterRevoke?.tokens?.operator?.revokedAtMs).toBeUndefined();
    } finally {
      pairingWs?.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
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
      expect(pairedAfterRotate?.tokens?.operator?.token).toBeTruthy();

      const revoke = await rpcReq<{ revokedAtMs?: number }>(started.ws, "device.token.revoke", {
        deviceId: device.deviceId,
        role: "operator",
      });
      expect(revoke.ok).toBe(true);
      expect(revoke.payload?.revokedAtMs).toBeTypeOf("number");

      const paired = await getPairedDevice(device.deviceId);
      expect(paired?.tokens?.operator?.revokedAtMs).toBeTypeOf("number");
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});

describe("gateway device.token.rotate/revoke caller scope guard", () => {
  test("rejects shared-token callers rotating or revoking above their session scopes", async () => {
    const started = await startServer("secret");
    const target = await issueOperatorToken({
      name: "shared-pairing-target",
      approvedScopes: ["operator.admin"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });

    let pairingWs: WebSocket | undefined;
    try {
      pairingWs = await openTrackedWs(started.port);
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
      pairingWs?.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("rejects rotating an admin-approved device token above the caller session scopes", async () => {
    const started = await startServer("secret");
    const attacker = await issueOperatorToken({
      name: "rotate-attacker",
      approvedScopes: ["operator.admin"],
      tokenScopes: ["operator.pairing"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });

    let pairingWs: WebSocket | undefined;
    try {
      pairingWs = await connectPairingScopedOperator({
        port: started.port,
        identityPath: attacker.identityPath,
        deviceToken: attacker.token,
      });

      const rotate = await rpcReq(pairingWs, "device.token.rotate", {
        deviceId: attacker.deviceId,
        role: "operator",
        scopes: ["operator.admin"],
      });
      expect(rotate.ok).toBe(false);
      expect(rotate.error?.message).toBe("device token rotation denied");

      const paired = await getPairedDevice(attacker.deviceId);
      expect(paired?.tokens?.operator?.scopes).toEqual(["operator.pairing"]);
      expect(paired?.approvedScopes).toEqual(["operator.admin"]);
    } finally {
      pairingWs?.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("blocks the pairing-token to admin-node-invoke escalation chain", async () => {
    const started = await startServerWithClient("secret");
    const attacker = await issueOperatorToken({
      name: "rotate-rce-attacker",
      approvedScopes: ["operator.admin"],
      tokenScopes: ["operator.pairing"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });

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
      await getConnectedNodeId(started.ws);

      pairingWs = await connectPairingScopedOperator({
        port: started.port,
        identityPath: attacker.identityPath,
        deviceToken: attacker.token,
      });

      const rotate = await rpcReq<{ token?: string }>(pairingWs, "device.token.rotate", {
        deviceId: attacker.deviceId,
        role: "operator",
        scopes: ["operator.admin"],
      });

      expect(rotate.ok).toBe(false);
      expect(rotate.error?.message).toBe("device token rotation denied");
      await waitForMacrotasks();
      expect(sawInvoke).toBe(false);

      const paired = await getPairedDevice(attacker.deviceId);
      expect(paired?.tokens?.operator?.scopes).toEqual(["operator.pairing"]);
      expect(paired?.tokens?.operator?.token).toBe(attacker.token);
    } finally {
      pairingWs?.close();
      nodeClient?.stop();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("returns the same public deny for unknown devices and caller scope failures", async () => {
    const started = await startServer("secret");
    const attacker = await issueOperatorToken({
      name: "rotate-deny-shape",
      approvedScopes: ["operator.admin"],
      tokenScopes: ["operator.pairing"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });

    let pairingWs: WebSocket | undefined;
    try {
      pairingWs = await connectPairingScopedOperator({
        port: started.port,
        identityPath: attacker.identityPath,
        deviceToken: attacker.token,
      });

      const missingScope = await rpcReq(pairingWs, "device.token.rotate", {
        deviceId: attacker.deviceId,
        role: "operator",
        scopes: ["operator.admin"],
      });
      const unknownDevice = await rpcReq(pairingWs, "device.token.rotate", {
        deviceId: "missing-device",
        role: "operator",
        scopes: ["operator.pairing"],
      });

      expect(missingScope.ok).toBe(false);
      expect(unknownDevice.ok).toBe(false);
      expect(missingScope.error?.message).toBe("device token rotation denied");
      expect(unknownDevice.error?.message).toBe("device token rotation denied");
    } finally {
      pairingWs?.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("rejects rotating a token for an unapproved role on an existing paired device", async () => {
    const started = await startServer("secret");
    const attacker = await issueOperatorToken({
      name: "rotate-unapproved-role",
      approvedScopes: ["operator.pairing"],
      tokenScopes: ["operator.pairing"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });

    let pairingWs: WebSocket | undefined;
    try {
      pairingWs = await connectPairingScopedOperator({
        port: started.port,
        identityPath: attacker.identityPath,
        deviceToken: attacker.token,
      });

      const rotate = await rpcReq(pairingWs, "device.token.rotate", {
        deviceId: attacker.deviceId,
        role: "node",
      });

      expect(rotate.ok).toBe(false);
      expect(rotate.error?.message).toBe("device token rotation denied");

      const paired = await getPairedDevice(attacker.deviceId);
      expect(paired?.tokens?.node).toBeUndefined();
      expect(paired?.tokens?.operator?.scopes).toEqual(["operator.pairing"]);
    } finally {
      pairingWs?.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
