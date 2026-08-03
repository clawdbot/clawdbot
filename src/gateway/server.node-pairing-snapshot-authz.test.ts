// Pairing snapshot authorization tests cover scope, self-scoping, shared-auth,
// and admin device-token access through a temporary Gateway server.
import { expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { approveNodePairing, requestNodePairing } from "../infra/node-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  issueOperatorToken,
  openTrackedWs,
  pairDeviceIdentity,
} from "./device-authz.test-helpers.js";
import { describeWithGatewayServer } from "./server.node-pairing.test-support.js";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

function requireApprovedPairing(
  result: Awaited<ReturnType<typeof approveNodePairing>>,
): Exclude<typeof result, null | { status: "forbidden"; missingScope: string }> {
  if (!result || "status" in result) {
    throw new Error(`Expected approved node pairing, got ${JSON.stringify(result)}`);
  }
  return result;
}

describeWithGatewayServer("gateway node pairing snapshot authorization", (getStarted) => {
  async function openDeviceTokenSession(params: {
    name: string;
    scopes: string[];
  }): Promise<{ ws: WebSocket; deviceId: string }> {
    const operator = await issueOperatorToken({
      name: params.name,
      approvedScopes: params.scopes,
      tokenScopes: params.scopes,
    });
    const ws = await openTrackedWs(getStarted().port);
    await connectOk(ws, {
      skipDefaultAuth: true,
      deviceToken: operator.token.trim(),
      deviceIdentityPath: operator.identityPath,
      scopes: params.scopes,
    });
    return { ws, deviceId: operator.deviceId };
  }

  async function createApprovedNode(name: string) {
    const node = await pairDeviceIdentity({
      name,
      role: "node",
      scopes: [],
      clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientMode: GATEWAY_CLIENT_MODES.NODE,
    });
    const request = await requestNodePairing({
      nodeId: node.identity.deviceId,
      platform: "macos",
      deviceFamily: "Mac",
    });
    requireApprovedPairing(
      await approveNodePairing(request.request.requestId, {
        callerScopes: ["operator.pairing"],
      }),
    );
    return node;
  }

  test("rejects pairing snapshots with operator.read alone", async () => {
    const operator = await issueOperatorToken({
      name: "node-pairing-snapshot-read-only",
      approvedScopes: ["operator.read"],
    });
    const ws = await openTrackedWs(getStarted().port);
    try {
      await connectOk(ws, {
        token: "secret",
        deviceIdentityPath: operator.identityPath,
        scopes: ["operator.read"],
      });
      const snapshot = await rpcReq(ws, "node.pairing.snapshot", { nodeId: "any-node" });
      expect(snapshot.ok).toBe(false);
      expect(snapshot.error).toEqual({
        code: "FORBIDDEN",
        message: "missing scope: operator.pairing",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.pairing",
          requiredScopes: ["operator.pairing"],
        },
      });
    } finally {
      ws.close();
    }
  });

  test("denies a non-admin device-token caller another node's pairing snapshot", async () => {
    const victim = await createApprovedNode("node-pairing-snapshot-cross-device-victim");
    const { ws } = await openDeviceTokenSession({
      name: "node-pairing-snapshot-cross-device-attacker",
      scopes: ["operator.pairing"],
    });
    try {
      const snapshot = await rpcReq(ws, "node.pairing.snapshot", {
        nodeId: victim.identity.deviceId,
      });
      expect(snapshot.ok).toBe(false);
      expect(snapshot.error?.message).toBe("node pairing snapshot denied");
    } finally {
      ws.close();
    }
  });

  test("allows a non-admin device-token caller to read its own pairing snapshot", async () => {
    const operator = await issueOperatorToken({
      name: "node-pairing-snapshot-self",
      approvedScopes: ["operator.pairing"],
      tokenScopes: ["operator.pairing"],
    });
    const nodeRequest = await requestDevicePairing({
      deviceId: operator.deviceId,
      publicKey: (await getPairedDevice(operator.deviceId))?.publicKey ?? "",
      role: "node",
      roles: ["node"],
      scopes: [],
    });
    await approveDevicePairing(nodeRequest.request.requestId, {
      callerScopes: ["operator.admin"],
    });
    const surfaceRequest = await requestNodePairing({ nodeId: operator.deviceId });
    requireApprovedPairing(
      await approveNodePairing(surfaceRequest.request.requestId, {
        callerScopes: ["operator.pairing"],
      }),
    );
    const ws = await openTrackedWs(getStarted().port);
    try {
      await connectOk(ws, {
        skipDefaultAuth: true,
        deviceToken: operator.token.trim(),
        deviceIdentityPath: operator.identityPath,
        scopes: ["operator.pairing"],
      });
      const snapshot = await rpcReq<{
        publicKeySha256?: string;
        pairingGenerationKey?: string;
        paired?: boolean;
        nodeSurfaceApproved?: boolean;
      }>(ws, "node.pairing.snapshot", { nodeId: operator.deviceId });
      expect(snapshot.ok).toBe(true);
      expect(snapshot.payload).toMatchObject({
        paired: true,
        nodeSurfaceApproved: true,
        publicKeySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        pairingGenerationKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    } finally {
      ws.close();
    }
  });

  test("allows a shared-auth operator session to read another node's pairing snapshot", async () => {
    const victim = await createApprovedNode("node-pairing-snapshot-shared-auth-victim");
    const operator = await issueOperatorToken({
      name: "node-pairing-snapshot-shared-auth-operator",
      approvedScopes: ["operator.pairing"],
    });
    const ws = await openTrackedWs(getStarted().port);
    try {
      await connectOk(ws, {
        token: "secret",
        deviceIdentityPath: operator.identityPath,
        scopes: ["operator.pairing"],
      });
      const snapshot = await rpcReq<{ nodeId?: string }>(ws, "node.pairing.snapshot", {
        nodeId: victim.identity.deviceId,
      });
      expect(snapshot).toMatchObject({
        ok: true,
        payload: { nodeId: victim.identity.deviceId },
      });
    } finally {
      ws.close();
    }
  });

  test("allows an admin device-token session to read another node's pairing snapshot", async () => {
    const victim = await createApprovedNode("node-pairing-snapshot-admin-device-victim");
    const { ws } = await openDeviceTokenSession({
      name: "node-pairing-snapshot-admin-device-operator",
      scopes: ["operator.admin", "operator.pairing"],
    });
    try {
      const snapshot = await rpcReq<{ nodeId?: string }>(ws, "node.pairing.snapshot", {
        nodeId: victim.identity.deviceId,
      });
      expect(snapshot).toMatchObject({
        ok: true,
        payload: { nodeId: victim.identity.deviceId },
      });
    } finally {
      ws.close();
    }
  });
});
