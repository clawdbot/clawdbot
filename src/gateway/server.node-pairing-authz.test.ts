import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import {
  approveNodePairing,
  getPairedNode,
  listNodePairing,
  requestNodePairing,
} from "../infra/node-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
  pairDeviceIdentity,
} from "./device-authz.test-helpers.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function connectNodeClient(params: {
  port: number;
  deviceIdentity: ReturnType<typeof loadDeviceIdentity>["identity"];
  commands: string[];
}) {
  return await connectGatewayClient({
    url: `ws://127.0.0.1:${params.port}`,
    token: "secret",
    role: "node",
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: "node-command-pin",
    clientVersion: "1.0.0",
    platform: "macos",
    deviceFamily: "Mac",
    mode: GATEWAY_CLIENT_MODES.NODE,
    scopes: [],
    commands: params.commands,
    deviceIdentity: params.deviceIdentity,
    timeoutMessage: "timeout waiting for paired node to connect",
  });
}

async function expectPairingApprovalRejected(params: {
  started: Awaited<ReturnType<typeof startServerWithClient>>;
  nodeId: string;
  approverName: string;
  tokenScopes: string[];
  connectedScopes: string[];
  requestCommands?: string[];
  expectedMessage: string;
}) {
  const { started } = params;
  const approver = await issueOperatorToken({
    name: params.approverName,
    approvedScopes: ["operator.admin"],
    tokenScopes: params.tokenScopes,
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
  });

  let pairingWs: WebSocket | undefined;
  try {
    const request = await requestNodePairing({
      nodeId: params.nodeId,
      platform: "macos",
      deviceFamily: "Mac",
      ...(params.requestCommands ? { commands: params.requestCommands } : {}),
    });

    pairingWs = await openTrackedWs(started.port);
    await connectOk(pairingWs, {
      skipDefaultAuth: true,
      deviceToken: approver.token,
      deviceIdentityPath: approver.identityPath,
      scopes: params.connectedScopes,
    });

    const approve = await rpcReq(pairingWs, "node.pair.approve", {
      requestId: request.request.requestId,
    });
    expect(approve.ok).toBe(false);
    expect(approve.error?.message).toBe(params.expectedMessage);

    await expect(getPairedNode(params.nodeId)).resolves.toBeNull();
  } finally {
    pairingWs?.close();
  }
}

async function expectRePairingRequest(params: {
  pairedName: string;
  initialCommands?: string[];
  reconnectCommands: string[];
  approvalScopes: string[];
  expectedVisibleCommands: string[];
}) {
  const started = await startServerWithClient("secret");
  const pairedNode = await pairDeviceIdentity({
    name: params.pairedName,
    role: "node",
    scopes: [],
    clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
  });

  let controlWs: WebSocket | undefined;
  let firstClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let nodeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  try {
    controlWs = await openTrackedWs(started.port);
    await connectOk(controlWs, { token: "secret" });

    if (params.initialCommands) {
      firstClient = await connectNodeClient({
        port: started.port,
        deviceIdentity: pairedNode.identity,
        commands: params.initialCommands,
      });
      await firstClient.stopAndWait();
    }

    const request = await requestNodePairing({
      nodeId: pairedNode.identity.deviceId,
      platform: "macos",
      deviceFamily: "Mac",
      ...(params.initialCommands ? { commands: params.initialCommands } : {}),
    });
    await approveNodePairing(request.request.requestId, {
      callerScopes: params.approvalScopes,
    });

    nodeClient = await connectNodeClient({
      port: started.port,
      deviceIdentity: pairedNode.identity,
      commands: params.reconnectCommands,
    });
    const connectedControlWs = controlWs;

    let lastNodes: Array<{ nodeId: string; connected?: boolean; commands?: string[] }> = [];
    await vi.waitFor(async () => {
      const list = await rpcReq<{
        nodes?: Array<{ nodeId: string; connected?: boolean; commands?: string[] }>;
      }>(connectedControlWs, "node.list", {});
      lastNodes = list.payload?.nodes ?? [];
      const node = lastNodes.find(
        (entry) => entry.nodeId === pairedNode.identity.deviceId && entry.connected,
      );
      if (
        JSON.stringify(node?.commands?.toSorted() ?? []) ===
        JSON.stringify(params.expectedVisibleCommands)
      ) {
        return;
      }
      throw new Error(`node commands not visible yet: ${JSON.stringify(lastNodes)}`);
    });

    expect(
      lastNodes
        .find((entry) => entry.nodeId === pairedNode.identity.deviceId && entry.connected)
        ?.commands?.toSorted(),
      JSON.stringify(lastNodes),
    ).toEqual(params.expectedVisibleCommands);

    const pairing = await listNodePairing();
    const pending = pairing.pending?.find((entry) => entry.nodeId === pairedNode.identity.deviceId);
    expect(pending?.nodeId).toBe(pairedNode.identity.deviceId);
    expect(pending?.commands).toEqual(params.reconnectCommands);
  } finally {
    controlWs?.close();
    await firstClient?.stopAndWait();
    await nodeClient?.stopAndWait();
    started.ws.close();
    await started.server.close();
    started.envSnapshot.restore();
  }
}

describe("gateway node pairing authorization", () => {
  test("enforces node pairing approval scopes", async () => {
    const started = await startServerWithClient("secret");
    let pairingWs: WebSocket | undefined;
    try {
      await expectPairingApprovalRejected({
        started,
        nodeId: "node-approve-reject-admin",
        approverName: "node-pair-approve-pairing-only",
        tokenScopes: ["operator.pairing"],
        connectedScopes: ["operator.pairing"],
        requestCommands: ["system.run"],
        expectedMessage: "missing scope: operator.admin",
      });

      await expectPairingApprovalRejected({
        started,
        nodeId: "node-approve-reject-pairing",
        approverName: "node-pair-approve-attacker",
        tokenScopes: ["operator.write"],
        connectedScopes: ["operator.write"],
        requestCommands: ["system.run"],
        expectedMessage: "missing scope: operator.pairing",
      });

      const approver = await issueOperatorToken({
        name: "node-pair-approve-commandless",
        approvedScopes: ["operator.admin"],
        tokenScopes: ["operator.pairing"],
        clientId: GATEWAY_CLIENT_NAMES.TEST,
        clientMode: GATEWAY_CLIENT_MODES.TEST,
      });

      const request = await requestNodePairing({
        nodeId: "node-approve-target",
        platform: "macos",
        deviceFamily: "Mac",
      });

      pairingWs = await openTrackedWs(started.port);
      await connectOk(pairingWs, {
        skipDefaultAuth: true,
        deviceToken: approver.token,
        deviceIdentityPath: approver.identityPath,
        scopes: ["operator.pairing"],
      });

      const approve = await rpcReq<{
        requestId?: string;
        node?: { nodeId?: string };
      }>(pairingWs, "node.pair.approve", {
        requestId: request.request.requestId,
      });
      expect(approve.ok).toBe(true);
      expect(approve.payload?.requestId).toBe(request.request.requestId);
      expect(approve.payload?.node?.nodeId).toBe("node-approve-target");

      const pairedNode = await getPairedNode("node-approve-target");
      expect(pairedNode?.nodeId).toBe("node-approve-target");
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("requests re-pairing when a paired node reconnects with upgraded commands", async () => {
    await expectRePairingRequest({
      pairedName: "node-command-pin",
      initialCommands: ["screen.snapshot"],
      reconnectCommands: ["screen.snapshot", "system.run"],
      approvalScopes: ["operator.pairing", "operator.write"],
      expectedVisibleCommands: ["screen.snapshot"],
    });
  });

  test("requests re-pairing when a commandless paired node reconnects with system.run", async () => {
    await expectRePairingRequest({
      pairedName: "node-command-empty",
      reconnectCommands: ["screen.snapshot", "system.run"],
      approvalScopes: ["operator.pairing"],
      expectedVisibleCommands: [],
    });
  });
});
