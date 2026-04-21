import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  getPairedDevice,
  getPendingDevicePairing,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
} from "./device-authz.test-helpers.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function issuePairingOnlyOperator(name: string) {
  return await issueOperatorToken({
    name,
    approvedScopes: ["operator.admin"],
    tokenScopes: ["operator.pairing"],
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
  });
}

async function requestOperatorDevicePairing(params: {
  identity: ReturnType<typeof loadDeviceIdentity>;
  scopes: string[];
}) {
  return await requestDevicePairing({
    deviceId: params.identity.identity.deviceId,
    publicKey: params.identity.publicKey,
    role: "operator",
    scopes: params.scopes,
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
  });
}

async function openPairingSession(
  port: number,
  operator: Awaited<ReturnType<typeof issueOperatorToken>>,
): Promise<WebSocket> {
  const pairingWs = await openTrackedWs(port);
  await connectOk(pairingWs, {
    skipDefaultAuth: true,
    deviceToken: operator.token,
    deviceIdentityPath: operator.identityPath,
    scopes: ["operator.pairing"],
  });
  return pairingWs;
}

describe("gateway device.pair.approve caller scope guard", () => {
  test("rejects approving device scopes above the caller session scopes", async () => {
    const started = await startServerWithClient("secret");
    const approver = await issuePairingOnlyOperator("approve-attacker");
    const approverIdentity = loadDeviceIdentity("approve-attacker");

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestOperatorDevicePairing({
        identity: approverIdentity,
        scopes: ["operator.admin"],
      });
      pairingWs = await openPairingSession(started.port, approver);

      const approve = await rpcReq(pairingWs, "device.pair.approve", {
        requestId: request.request.requestId,
      });
      expect(approve.ok).toBe(false);
      expect(approve.error?.message).toBe("missing scope: operator.admin");

      const paired = await getPairedDevice(approverIdentity.identity.deviceId);
      expect(paired).not.toBeNull();
      expect(paired?.approvedScopes).toEqual(["operator.admin"]);
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("rejects approving another device from a non-admin paired-device session", async () => {
    const started = await startServerWithClient("secret");
    const approver = await issuePairingOnlyOperator("approve-cross-device-attacker");
    const pending = loadDeviceIdentity("approve-cross-device-target");

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestOperatorDevicePairing({
        identity: pending,
        scopes: ["operator.pairing"],
      });
      pairingWs = await openPairingSession(started.port, approver);

      const approve = await rpcReq(pairingWs, "device.pair.approve", {
        requestId: request.request.requestId,
      });
      expect(approve.ok).toBe(false);
      expect(approve.error?.message).toBe("device pairing approval denied");

      const paired = await getPairedDevice(pending.identity.deviceId);
      expect(paired).toBeNull();
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("rejects rejecting another device from a non-admin paired-device session", async () => {
    const started = await startServerWithClient("secret");
    const attacker = await issuePairingOnlyOperator("reject-cross-device-attacker");
    const pending = loadDeviceIdentity("reject-cross-device-target");

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestOperatorDevicePairing({
        identity: pending,
        scopes: ["operator.pairing"],
      });
      pairingWs = await openPairingSession(started.port, attacker);

      const reject = await rpcReq(pairingWs, "device.pair.reject", {
        requestId: request.request.requestId,
      });
      expect(reject.ok).toBe(false);
      expect(reject.error?.message).toBe("device pairing rejection denied");

      const stillPending = await getPendingDevicePairing(request.request.requestId);
      expect(stillPending).not.toBeNull();
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
