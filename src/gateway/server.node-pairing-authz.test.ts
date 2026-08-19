// Node pairing authorization tests cover approved node reconnects, visible
// command scopes, and gateway enforcement around node client identity.
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import {
  type HelloOk,
  MIN_NODE_PROTOCOL_VERSION,
} from "../../packages/gateway-protocol/src/index.js";
import {
  approveNodePairing,
  listNodePairing,
  requestNodePairing,
} from "../infra/device-pairing-node.js";
import { getPairedDevice, listDevicePairing } from "../infra/device-pairing.js";
import { NODE_MCP_TOOLS_CALL_COMMAND } from "../infra/node-commands.js";
import { resolveNodeIdFromNodeList } from "../shared/node-resolve.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientName,
} from "../utils/message-channel.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
  pairDeviceIdentity,
} from "./device-authz.test-helpers.js";
import {
  createNodePairingTestState,
  describeWithGatewayServer,
} from "./server.node-pairing.test-support.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const {
  cleanup: cleanupNodePairingTestState,
  makeStateDir: makeNodePairingStateDir,
  seedNodeDevice,
  setup: setupNodePairingTestState,
} = createNodePairingTestState("openclaw-node-pair-authz-");

async function findPairedNode(nodeId: string, baseDir?: string) {
  const pairing = await listNodePairing(baseDir);
  return pairing.paired.find((node) => node.nodeId === nodeId) ?? null;
}

function requireApprovedPairing(
  result: Awaited<ReturnType<typeof approveNodePairing>>,
): Exclude<typeof result, null | { status: "forbidden"; missingScope: string }> {
  if (!result || "status" in result) {
    throw new Error(`Expected approved node pairing, got ${JSON.stringify(result)}`);
  }
  return result;
}

async function connectNodeClient(params: {
  port: number;
  deviceIdentity: ReturnType<typeof loadDeviceIdentity>["identity"];
  commands: string[];
  clientName?: GatewayClientName;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  caps?: string[];
  onHelloOk?: (hello: HelloOk) => void;
  protocol?: "current" | "legacy";
}) {
  return await connectGatewayClient({
    url: `ws://127.0.0.1:${params.port}`,
    token: "secret",
    role: "node",
    clientName: params.clientName ?? GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: params.displayName ?? "node-command-pin",
    clientVersion: params.protocol === "legacy" ? "2026.5.7" : "1.0.0",
    platform: params.protocol === "legacy" ? "darwin" : (params.platform ?? "macos"),
    deviceFamily: params.protocol === "legacy" ? undefined : (params.deviceFamily ?? "Mac"),
    mode: GATEWAY_CLIENT_MODES.NODE,
    minProtocol: params.protocol === "legacy" ? MIN_NODE_PROTOCOL_VERSION : undefined,
    maxProtocol: params.protocol === "legacy" ? MIN_NODE_PROTOCOL_VERSION : undefined,
    scopes: [],
    caps: params.caps,
    commands: params.commands,
    deviceIdentity: params.deviceIdentity,
    onHelloOk: params.onHelloOk,
    timeoutMessage: "timeout waiting for paired node to connect",
  });
}

async function expectRePairingRequest(params: {
  started: Awaited<ReturnType<typeof startServerWithClient>>;
  pairedName: string;
  initialCommands?: string[];
  reconnectCommands: string[];
  approvalScopes: string[];
  expectedVisibleCommands: string[];
}) {
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
    controlWs = await openTrackedWs(params.started.port);
    await connectOk(controlWs, { token: "secret" });

    if (params.initialCommands) {
      firstClient = await connectNodeClient({
        port: params.started.port,
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
      port: params.started.port,
      deviceIdentity: pairedNode.identity,
      commands: params.reconnectCommands,
    });
    const connectedControlWs = controlWs;

    type NodeDiagnostics = {
      nodeId: string;
      connected?: boolean;
      commands?: string[];
      approvalState?: string;
      pendingRequestId?: string;
      pendingDeclaredCommands?: string[];
    };
    let lastNodes: NodeDiagnostics[] = [];
    await vi.waitFor(async () => {
      const list = await rpcReq<{
        nodes?: NodeDiagnostics[];
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
    const listedNode = lastNodes.find((entry) => entry.nodeId === pairedNode.identity.deviceId);
    expect(listedNode).toMatchObject({
      approvalState: "pending-reapproval",
      pendingRequestId: pending?.requestId,
      pendingDeclaredCommands: params.reconnectCommands,
      commands: params.expectedVisibleCommands,
    });

    const described = await rpcReq<NodeDiagnostics>(connectedControlWs, "node.describe", {
      nodeId: pairedNode.identity.deviceId,
    });
    expect(described.payload).toMatchObject({
      approvalState: "pending-reapproval",
      pendingRequestId: pending?.requestId,
      pendingDeclaredCommands: params.reconnectCommands,
      commands: params.expectedVisibleCommands,
    });
  } finally {
    controlWs?.close();
    await firstClient?.stopAndWait();
    await nodeClient?.stopAndWait();
  }
}

async function expectRpcNodePairingApprovalRejected(params: {
  started: Awaited<ReturnType<typeof startServerWithClient>>;
  operatorScopes: string[];
  operatorName: string;
  nodeId: string;
  commands: string[];
  expectedMissingScope: string;
  expectedRequiredScopes: string[];
}): Promise<void> {
  const ws = await openTrackedWs(params.started.port);
  try {
    await connectOk(ws, {
      token: "secret",
      scopes: params.operatorScopes,
      deviceIdentityPath: `${await makeNodePairingStateDir()}/${params.operatorName}.sqlite`,
    });
    await seedNodeDevice(params.nodeId);
    const request = await requestNodePairing({
      nodeId: params.nodeId,
      platform: "macos",
      deviceFamily: "Mac",
      commands: params.commands,
    });

    const approve = await rpcReq(ws, "node.pair.approve", {
      requestId: request.request.requestId,
    });

    expect(approve.ok).toBe(false);
    expect(approve.error).toEqual({
      code: "FORBIDDEN",
      message: `missing scope: ${params.expectedMissingScope}`,
      details: {
        code: "MISSING_SCOPE",
        missingScope: params.expectedMissingScope,
        requiredScopes: params.expectedRequiredScopes,
      },
    });
    await expect(findPairedNode(params.nodeId)).resolves.toBeNull();
  } finally {
    ws.close();
  }
}

describe("gateway node pairing authorization", () => {
  beforeAll(async () => {
    await setupNodePairingTestState();
  });

  afterAll(async () => {
    await cleanupNodePairingTestState();
  });

  describe("approval scopes", () => {
    test("rejects node pairing approval without admin scope", async () => {
      const baseDir = await makeNodePairingStateDir();
      await seedNodeDevice("node-approve-reject-admin", baseDir);
      const request = await requestNodePairing(
        {
          nodeId: "node-approve-reject-admin",
          platform: "macos",
          deviceFamily: "Mac",
          commands: ["system.run"],
        },
        baseDir,
      );

      await expect(
        approveNodePairing(
          request.request.requestId,
          { callerScopes: ["operator.pairing"] },
          baseDir,
        ),
      ).resolves.toEqual({
        status: "forbidden",
        missingScope: "operator.admin",
      });
      await expect(findPairedNode("node-approve-reject-admin", baseDir)).resolves.toBeNull();
    });

    test("rejects node pairing approval without pairing scope", async () => {
      const baseDir = await makeNodePairingStateDir();
      await seedNodeDevice("node-approve-reject-pairing", baseDir);
      const request = await requestNodePairing(
        {
          nodeId: "node-approve-reject-pairing",
          platform: "macos",
          deviceFamily: "Mac",
          commands: ["system.run"],
        },
        baseDir,
      );

      await expect(
        approveNodePairing(
          request.request.requestId,
          { callerScopes: ["operator.write"] },
          baseDir,
        ),
      ).resolves.toEqual({
        status: "forbidden",
        missingScope: "operator.pairing",
      });
      await expect(findPairedNode("node-approve-reject-pairing", baseDir)).resolves.toBeNull();
    });

    test("approves commandless node pairing with pairing scope", async () => {
      const baseDir = await makeNodePairingStateDir();
      await seedNodeDevice("node-approve-target", baseDir);
      const request = await requestNodePairing(
        {
          nodeId: "node-approve-target",
          platform: "macos",
          deviceFamily: "Mac",
        },
        baseDir,
      );

      const approved = requireApprovedPairing(
        await approveNodePairing(
          request.request.requestId,
          { callerScopes: ["operator.pairing"] },
          baseDir,
        ),
      );
      expect(approved.requestId).toBe(request.request.requestId);
      expect(approved.node.nodeId).toBe("node-approve-target");

      const pairedNode = await findPairedNode("node-approve-target", baseDir);
      expect(pairedNode?.nodeId).toBe("node-approve-target");
    });
  });

  describeWithGatewayServer("rpc approval scopes", (getStarted) => {
    test("rejects system.run node pairing approval without admin scope through rpc", async () => {
      await expectRpcNodePairingApprovalRejected({
        started: getStarted(),
        operatorScopes: ["operator.pairing"],
        operatorName: "operator-pairing",
        nodeId: "node-rpc-approve-reject-admin",
        commands: ["system.run"],
        expectedMissingScope: "operator.admin",
        expectedRequiredScopes: ["operator.pairing", "operator.admin"],
      });
    });

    test.each([
      ["fs.listDir", "fs-list-dir"],
      ["system.execApprovals.get", "exec-approvals-get"],
      ["system.execApprovals.set", "exec-approvals-set"],
    ])("rejects %s node pairing approval without admin scope through rpc", async (command, id) => {
      await expectRpcNodePairingApprovalRejected({
        started: getStarted(),
        operatorScopes: ["operator.pairing", "operator.write"],
        operatorName: `operator-write-${id}`,
        nodeId: `node-rpc-${id}`,
        commands: [command],
        expectedMissingScope: "operator.admin",
        expectedRequiredScopes: ["operator.pairing", "operator.admin"],
      });
    });

    test("rejects node pairing approval without pairing scope through rpc", async () => {
      await expectRpcNodePairingApprovalRejected({
        started: getStarted(),
        operatorScopes: ["operator.write"],
        operatorName: "operator-write",
        nodeId: "node-rpc-approve-reject-pairing",
        commands: ["system.run"],
        expectedMissingScope: "operator.pairing",
        expectedRequiredScopes: ["operator.pairing"],
      });
    });
  });

  describeWithGatewayServer("cross-device management guard", (getStarted) => {
    async function requestVictimNodeSurface(nodeId: string) {
      await seedNodeDevice(nodeId);
      return await requestNodePairing({
        nodeId,
        platform: "macos",
        deviceFamily: "Mac",
        commands: [NODE_MCP_TOOLS_CALL_COMMAND],
      });
    }

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

    test("denies non-admin cross-device list, approve, reject, and rename", async () => {
      const approveVictimId = "node-cross-device-approve-victim";
      const approveRequest = await requestVictimNodeSurface(approveVictimId);
      const rejectVictimId = "node-cross-device-reject-victim";
      const rejectRequest = await requestVictimNodeSurface(rejectVictimId);
      const renameVictimId = "node-cross-device-rename-victim";
      const renameRequest = await requestVictimNodeSurface(renameVictimId);
      requireApprovedPairing(
        await approveNodePairing(renameRequest.request.requestId, {
          callerScopes: ["operator.pairing", "operator.write"],
        }),
      );

      const { ws } = await openDeviceTokenSession({
        name: "node-cross-device-attacker",
        scopes: ["operator.pairing", "operator.write"],
      });
      try {
        const listed = await rpcReq<Awaited<ReturnType<typeof listNodePairing>>>(
          ws,
          "node.pair.list",
          {},
        );
        expect(listed.ok).toBe(true);
        expect(listed.payload).toEqual({ pending: [], paired: [] });

        const approve = await rpcReq(ws, "node.pair.approve", {
          requestId: approveRequest.request.requestId,
        });
        expect(approve.ok).toBe(false);
        expect(approve.error?.message).toBe("node pairing approval denied");
        await expect(findPairedNode(approveVictimId)).resolves.toBeNull();

        const reject = await rpcReq(ws, "node.pair.reject", {
          requestId: rejectRequest.request.requestId,
        });
        expect(reject.ok).toBe(false);
        expect(reject.error?.message).toBe("node pairing rejection denied");
        expect((await listNodePairing()).pending).toContainEqual(
          expect.objectContaining({ nodeId: rejectVictimId }),
        );

        const unknownApprove = await rpcReq(ws, "node.pair.approve", {
          requestId: "unknown-cross-device-approve",
        });
        expect(unknownApprove.error?.message).toBe("node pairing approval denied");
        const unknownReject = await rpcReq(ws, "node.pair.reject", {
          requestId: "unknown-cross-device-reject",
        });
        expect(unknownReject.error?.message).toBe("node pairing rejection denied");

        const rename = await rpcReq(ws, "node.rename", {
          nodeId: renameVictimId,
          displayName: "attacker rename",
        });
        expect(rename.ok).toBe(false);
        expect(rename.error?.message).toBe("node rename denied");
        await expect(findPairedNode(renameVictimId)).resolves.not.toMatchObject({
          displayName: "attacker rename",
        });
      } finally {
        ws.close();
      }
    });

    test("allows a non-admin device-token session to manage its own node surface", async () => {
      const name = "node-self-device";
      const attacker = await issueOperatorToken({
        name,
        approvedScopes: ["operator.pairing", "operator.write"],
        tokenScopes: ["operator.pairing", "operator.write"],
      });
      await pairDeviceIdentity({
        name,
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const request = await requestNodePairing({
        nodeId: attacker.deviceId,
        platform: "macos",
        deviceFamily: "Mac",
        commands: [NODE_MCP_TOOLS_CALL_COMMAND],
      });

      const ws = await openTrackedWs(getStarted().port);
      try {
        await connectOk(ws, {
          skipDefaultAuth: true,
          deviceToken: attacker.token.trim(),
          deviceIdentityPath: attacker.identityPath,
          scopes: ["operator.pairing", "operator.write"],
        });

        const listed = await rpcReq<Awaited<ReturnType<typeof listNodePairing>>>(
          ws,
          "node.pair.list",
          {},
        );
        expect(listed.payload?.pending.map((entry) => entry.nodeId)).toEqual([attacker.deviceId]);

        const approve = await rpcReq(ws, "node.pair.approve", {
          requestId: request.request.requestId,
        });
        expect(approve.ok).toBe(true);

        const rename = await rpcReq(ws, "node.rename", {
          nodeId: attacker.deviceId,
          displayName: "self renamed",
        });
        expect(rename.ok).toBe(true);
        await expect(findPairedNode(attacker.deviceId)).resolves.toMatchObject({
          displayName: "self renamed",
        });

        const nextRequest = await requestNodePairing({
          nodeId: attacker.deviceId,
          platform: "macos",
          deviceFamily: "Mac",
          commands: [],
        });
        const reject = await rpcReq(ws, "node.pair.reject", {
          requestId: nextRequest.request.requestId,
        });
        expect(reject.ok).toBe(true);
        expect((await listNodePairing()).pending).not.toContainEqual(
          expect.objectContaining({ requestId: nextRequest.request.requestId }),
        );
      } finally {
        ws.close();
      }
    });

    test("allows a shared-auth operator session to manage another device's node surface", async () => {
      const victimNodeId = "node-shared-auth-victim";
      const request = await requestVictimNodeSurface(victimNodeId);
      const operator = await issueOperatorToken({
        name: "node-shared-auth-operator",
        approvedScopes: ["operator.pairing", "operator.write"],
      });

      const ws = await openTrackedWs(getStarted().port);
      try {
        await connectOk(ws, {
          token: "secret".trim(),
          deviceIdentityPath: operator.identityPath,
          scopes: ["operator.pairing", "operator.write"],
        });

        const listed = await rpcReq<Awaited<ReturnType<typeof listNodePairing>>>(
          ws,
          "node.pair.list",
          {},
        );
        expect(listed.payload?.pending).toContainEqual(
          expect.objectContaining({ nodeId: victimNodeId }),
        );

        const approve = await rpcReq(ws, "node.pair.approve", {
          requestId: request.request.requestId,
        });
        expect(approve.ok).toBe(true);
        await expect(findPairedNode(victimNodeId)).resolves.toMatchObject({
          commands: [NODE_MCP_TOOLS_CALL_COMMAND],
        });

        const rename = await rpcReq(ws, "node.rename", {
          nodeId: victimNodeId,
          displayName: "shared renamed",
        });
        expect(rename.ok).toBe(true);

        const nextRequest = await requestNodePairing({
          nodeId: victimNodeId,
          platform: "macos",
          deviceFamily: "Mac",
          commands: [],
        });
        const reject = await rpcReq(ws, "node.pair.reject", {
          requestId: nextRequest.request.requestId,
        });
        expect(reject.ok).toBe(true);
      } finally {
        ws.close();
      }
    });

    test("allows an admin device-token session to manage another device's node surface", async () => {
      const victimNodeId = "node-admin-device-victim";
      const request = await requestVictimNodeSurface(victimNodeId);
      const { ws } = await openDeviceTokenSession({
        name: "node-admin-device-operator",
        scopes: ["operator.admin", "operator.pairing", "operator.write"],
      });
      try {
        const listed = await rpcReq<Awaited<ReturnType<typeof listNodePairing>>>(
          ws,
          "node.pair.list",
          {},
        );
        expect(listed.payload?.pending).toContainEqual(
          expect.objectContaining({ nodeId: victimNodeId }),
        );

        const approve = await rpcReq(ws, "node.pair.approve", {
          requestId: request.request.requestId,
        });
        expect(approve.ok).toBe(true);

        const rename = await rpcReq(ws, "node.rename", {
          nodeId: victimNodeId,
          displayName: "admin renamed",
        });
        expect(rename.ok).toBe(true);

        const nextRequest = await requestNodePairing({
          nodeId: victimNodeId,
          platform: "macos",
          deviceFamily: "Mac",
          commands: [],
        });
        const reject = await rpcReq(ws, "node.pair.reject", {
          requestId: nextRequest.request.requestId,
        });
        expect(reject.ok).toBe(true);
      } finally {
        ws.close();
      }
    });

    test("projects an operator rename immediately and after the node reconnects", async () => {
      const pairedNode = await pairDeviceIdentity({
        name: "node-rename-projection",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const requested = await requestNodePairing({
        nodeId: pairedNode.identity.deviceId,
        displayName: "Approval Name",
        platform: "macos",
        deviceFamily: "Mac",
        commands: [],
      });
      requireApprovedPairing(
        await approveNodePairing(requested.request.requestId, {
          callerScopes: ["operator.pairing"],
        }),
      );

      const controlWs = await openTrackedWs(getStarted().port);
      let nodeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      try {
        await connectOk(controlWs, { token: "secret" });
        nodeClient = await connectNodeClient({
          port: getStarted().port,
          deviceIdentity: pairedNode.identity,
          commands: [],
          displayName: "Live Name",
        });

        const renamed = await rpcReq(controlWs, "node.rename", {
          nodeId: pairedNode.identity.deviceId,
          displayName: "Operator Name",
        });
        expect(renamed.ok).toBe(true);

        type NodeRead = { nodeId: string; displayName?: string; connected?: boolean };
        const readNodes = async (): Promise<NodeRead[]> => {
          const listed = await rpcReq<{ nodes?: NodeRead[] }>(controlWs, "node.list", {});
          return listed.payload?.nodes ?? [];
        };
        const readConnectedNode = async (): Promise<NodeRead | undefined> => {
          return (await readNodes()).find((entry) => entry.nodeId === pairedNode.identity.deviceId);
        };
        await vi.waitFor(async () => {
          expect(await readConnectedNode()).toMatchObject({
            displayName: "Operator Name",
            connected: true,
          });
        });
        const listedNodes = await readNodes();
        expect(resolveNodeIdFromNodeList(listedNodes, "Operator Name")).toBe(
          pairedNode.identity.deviceId,
        );
        expect(() => resolveNodeIdFromNodeList(listedNodes, "Live Name")).toThrow(
          "unknown node: Live Name",
        );
        const described = await rpcReq<NodeRead>(controlWs, "node.describe", {
          nodeId: pairedNode.identity.deviceId,
        });
        expect(described.payload).toMatchObject({
          displayName: "Operator Name",
          connected: true,
        });

        await nodeClient.stopAndWait();
        nodeClient = undefined;
        nodeClient = await connectNodeClient({
          port: getStarted().port,
          deviceIdentity: pairedNode.identity,
          commands: [],
          displayName: "Replacement Live Name",
        });
        await vi.waitFor(async () => {
          expect(await readConnectedNode()).toMatchObject({
            displayName: "Operator Name",
            connected: true,
          });
        });
      } finally {
        await nodeClient?.stopAndWait();
        controlWs.close();
      }
    });
  });

  describeWithGatewayServer("paired node reconnects", (getStarted) => {
    test("normalizes a fresh v3 node pairing to canonical metadata", async () => {
      const legacyNode = loadDeviceIdentity("node-v3-pairing-normalization");
      const connected = await connectNodeClient({
        port: getStarted().port,
        deviceIdentity: legacyNode.identity,
        commands: [],
        protocol: "legacy",
      });
      try {
        expect(await getPairedDevice(legacyNode.identity.deviceId)).toMatchObject({
          platform: "macos",
          deviceFamily: "Mac",
          clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
          clientMode: GATEWAY_CLIENT_MODES.NODE,
        });
        expect(
          (await listDevicePairing()).pending.find(
            (entry) => entry.deviceId === legacyNode.identity.deviceId,
          ),
        ).toBeUndefined();
      } finally {
        await connected.stopAndWait();
      }
    });

    test("normalizes signed blank desktop family before device metadata reapproval", async () => {
      const pairedNode = await pairDeviceIdentity({
        name: "node-blank-family-reconnect",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
        platform: "macos",
        deviceFamily: "Mac",
      });
      const nodeClient = await connectNodeClient({
        port: getStarted().port,
        deviceIdentity: pairedNode.identity,
        commands: [],
        platform: "darwin",
        deviceFamily: "   ",
      });
      try {
        expect(await getPairedDevice(pairedNode.identity.deviceId)).toMatchObject({
          platform: "macos",
          deviceFamily: "Mac",
        });
        expect(
          (await listDevicePairing()).pending.filter(
            (entry) => entry.deviceId === pairedNode.identity.deviceId,
          ),
        ).toEqual([]);
      } finally {
        await nodeClient.stopAndWait();
      }
    });

    test("withholds plugin surface URLs until the node capability is approved", async () => {
      // The shared Gateway harness disables Canvas startup; expose its descriptor
      // so this handshake test exercises production capability issuance.
      const previousSkipCanvasHost = process.env.OPENCLAW_SKIP_CANVAS_HOST;
      delete process.env.OPENCLAW_SKIP_CANVAS_HOST;
      try {
        const pairedNode = await pairDeviceIdentity({
          name: "node-plugin-surface-approval",
          role: "node",
          scopes: [],
          clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
          clientMode: GATEWAY_CLIENT_MODES.NODE,
        });
        let pendingHello: HelloOk | undefined;
        const pendingClient = await connectNodeClient({
          port: getStarted().port,
          deviceIdentity: pairedNode.identity,
          caps: ["canvas"],
          commands: [],
          onHelloOk: (hello) => {
            pendingHello = hello;
          },
        });
        await pendingClient.stopAndWait();

        expect(pendingHello?.pluginSurfaceUrls).toBeUndefined();
        const pending = (await listNodePairing()).pending.find(
          (entry) => entry.nodeId === pairedNode.identity.deviceId,
        );
        expect(pending?.caps).toEqual(["canvas"]);
        requireApprovedPairing(
          await approveNodePairing(pending?.requestId ?? "", {
            callerScopes: ["operator.pairing"],
          }),
        );

        let approvedHello: HelloOk | undefined;
        const approvedClient = await connectNodeClient({
          port: getStarted().port,
          deviceIdentity: pairedNode.identity,
          caps: ["canvas"],
          commands: [],
          onHelloOk: (hello) => {
            approvedHello = hello;
          },
        });
        try {
          expect(approvedHello?.pluginSurfaceUrls?.canvas).toMatch(
            /^http:\/\/127\.0\.0\.1:\d+\/__openclaw__\/cap\/[^/]+$/,
          );
        } finally {
          await approvedClient.stopAndWait();
        }
      } finally {
        if (previousSkipCanvasHost === undefined) {
          delete process.env.OPENCLAW_SKIP_CANVAS_HOST;
        } else {
          process.env.OPENCLAW_SKIP_CANVAS_HOST = previousSkipCanvasHost;
        }
      }
    });

    test("keeps iOS approval when a transient permission becomes unavailable", async () => {
      const pairedNode = await pairDeviceIdentity({
        name: "ios-transient-permission",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.IOS_APP,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const initialPermissions = { camera: true, watchReachable: true };
      const initial = await requestNodePairing({
        nodeId: pairedNode.identity.deviceId,
        platform: "ios",
        deviceFamily: "iPhone",
        commands: [],
        permissions: initialPermissions,
      });
      await approveNodePairing(initial.request.requestId, {
        callerScopes: ["operator.pairing", "operator.write"],
      });

      const nodeClient = await connectGatewayClient({
        url: `ws://127.0.0.1:${getStarted().port}`,
        token: "secret",
        role: "node",
        clientName: GATEWAY_CLIENT_NAMES.IOS_APP,
        clientDisplayName: "iPhone",
        clientVersion: "1.0.0",
        platform: "ios",
        deviceFamily: "iPhone",
        mode: GATEWAY_CLIENT_MODES.NODE,
        scopes: [],
        commands: [],
        permissions: { camera: true, watchReachable: false },
        deviceIdentity: pairedNode.identity,
      });
      await nodeClient.stopAndWait();

      const pairing = await listNodePairing();
      expect(pairing.pending.some((entry) => entry.nodeId === pairedNode.identity.deviceId)).toBe(
        false,
      );
      await expect(findPairedNode(pairedNode.identity.deviceId)).resolves.toMatchObject({
        permissions: initialPermissions,
      });
    });

    test("clears stale reapproval when a node returns to its approved surface", async () => {
      const pairedNode = await pairDeviceIdentity({
        name: "node-reverted-reapproval",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const initial = await requestNodePairing({
        nodeId: pairedNode.identity.deviceId,
        platform: "macos",
        deviceFamily: "Mac",
        commands: ["screen.snapshot"],
      });
      await approveNodePairing(initial.request.requestId, {
        callerScopes: ["operator.pairing", "operator.write"],
      });

      const upgraded = await connectNodeClient({
        port: getStarted().port,
        deviceIdentity: pairedNode.identity,
        commands: ["screen.snapshot", "system.run"],
      });
      await upgraded.stopAndWait();
      expect(
        (await listNodePairing()).pending.some(
          (entry) => entry.nodeId === pairedNode.identity.deviceId,
        ),
      ).toBe(true);

      const reverted = await connectNodeClient({
        port: getStarted().port,
        deviceIdentity: pairedNode.identity,
        commands: ["screen.snapshot"],
      });
      await reverted.stopAndWait();

      await vi.waitFor(async () => {
        expect(
          (await listNodePairing()).pending.some(
            (entry) => entry.nodeId === pairedNode.identity.deviceId,
          ),
        ).toBe(false);
      });
    });

    test("refreshes a paired macOS app node version without a repair request", async () => {
      const started = getStarted();
      const pairedNode = await pairDeviceIdentity({
        name: "macos-version-refresh",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.MACOS_APP,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
        platform: "macOS 26.5.1",
        deviceFamily: "Mac",
      });
      const nodeRequest = await requestNodePairing({
        nodeId: pairedNode.identity.deviceId,
        platform: "macOS 26.5.1",
        deviceFamily: "Mac",
        commands: ["system.info"],
      });
      requireApprovedPairing(
        await approveNodePairing(nodeRequest.request.requestId, {
          callerScopes: ["operator.pairing", "operator.write", "operator.admin"],
        }),
      );

      const nodeClient = await connectNodeClient({
        port: started.port,
        deviceIdentity: pairedNode.identity,
        commands: ["system.info"],
        clientName: GATEWAY_CLIENT_NAMES.MACOS_APP,
        platform: "macOS 26.5.2",
        deviceFamily: "Mac",
      });
      try {
        await vi.waitFor(async () => {
          const pairedDevice = await getPairedDevice(pairedNode.identity.deviceId);
          expect(pairedDevice?.platform).toBe("macOS 26.5.2");
        });
        const devicePairing = await listDevicePairing();
        expect(
          devicePairing.pending.find((entry) => entry.deviceId === pairedNode.identity.deviceId),
        ).toBeUndefined();
      } finally {
        await nodeClient.stopAndWait();
      }
    });

    test("requests re-pairing when a paired node reconnects with upgraded commands", async () => {
      await expectRePairingRequest({
        started: getStarted(),
        pairedName: "node-command-pin",
        initialCommands: ["screen.snapshot"],
        reconnectCommands: ["screen.snapshot", "system.run"],
        approvalScopes: ["operator.pairing", "operator.write"],
        expectedVisibleCommands: ["screen.snapshot"],
      });
    });

    test("requests re-pairing when a commandless paired node reconnects with system.run", async () => {
      await expectRePairingRequest({
        started: getStarted(),
        pairedName: "node-command-empty",
        reconnectCommands: ["screen.snapshot", "system.run"],
        approvalScopes: ["operator.pairing"],
        expectedVisibleCommands: [],
      });
    });
  });
});
