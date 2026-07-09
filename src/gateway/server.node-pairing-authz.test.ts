// Node pairing authorization tests cover approved node reconnects, visible
// command scopes, and gateway enforcement around node client identity.
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { approveNodePairing, listNodePairing, requestNodePairing } from "../infra/node-pairing.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { callGateway } from "./call.js";
import {
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

const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-node-pair-authz-" });

async function makeNodePairingStateDir(): Promise<string> {
  return await tempDirs.make("case");
}

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
  expectedMessage: string;
}): Promise<void> {
  const ws = await openTrackedWs(params.started.port);
  try {
    await connectOk(ws, {
      token: "secret",
      scopes: params.operatorScopes,
      deviceIdentityPath: `${await makeNodePairingStateDir()}/${params.operatorName}.json`,
    });
    const request = await requestNodePairing({
      nodeId: params.nodeId,
      platform: "macos",
      deviceFamily: "Mac",
      commands: ["system.run"],
    });

    const approve = await rpcReq(ws, "node.pair.approve", {
      requestId: request.request.requestId,
    });

    expect(approve.ok).toBe(false);
    expect(approve.error?.message).toContain(params.expectedMessage);
    await expect(findPairedNode(params.nodeId)).resolves.toBeNull();
  } finally {
    ws.close();
  }
}

function describeWithGatewayServer(
  name: string,
  defineTests: (getStarted: () => Awaited<ReturnType<typeof startServerWithClient>>) => void,
): void {
  describe(name, () => {
    let started: Awaited<ReturnType<typeof startServerWithClient>> | undefined;

    beforeAll(async () => {
      started = await startServerWithClient("secret");
    });

    afterAll(async () => {
      started?.ws.close();
      await started?.server.close();
      started?.envSnapshot.restore();
    });

    defineTests(() => {
      if (!started) {
        throw new Error("gateway test server was not started");
      }
      return started;
    });
  });
}

describe("gateway node pairing authorization", () => {
  beforeAll(async () => {
    await tempDirs.setup();
  });

  afterAll(async () => {
    await tempDirs.cleanup();
  });

  describe("approval scopes", () => {
    test("rejects node pairing approval without admin scope", async () => {
      const baseDir = await makeNodePairingStateDir();
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
        expectedMessage: "missing scope: operator.admin",
      });
    });

    test("rejects node pairing approval without pairing scope through rpc", async () => {
      await expectRpcNodePairingApprovalRejected({
        started: getStarted(),
        operatorScopes: ["operator.write"],
        operatorName: "operator-write",
        nodeId: "node-rpc-approve-reject-pairing",
        expectedMessage: "operator.pairing",
      });
    });
  });

  describeWithGatewayServer("pending diagnostics scopes", (getStarted) => {
    test("shows pending pairing records to direct-local backend shared-auth callers", async () => {
      const pendingOnlyNodeId = "node-local-backend-pending";
      const pending = await requestNodePairing({
        nodeId: pendingOnlyNodeId,
        platform: "macos",
        commands: ["system.run"],
      });

      const listed = await callGateway<{
        nodes?: Array<{
          nodeId: string;
          approvalState?: string;
          pendingRequestId?: string;
        }>;
      }>({
        config: {
          gateway: {
            mode: "local",
            bind: "loopback",
            port: getStarted().port,
            auth: { mode: "token", token: "secret" },
          },
        },
        method: "node.list",
        scopes: ["operator.read", "operator.pairing"],
        requireLocalBackendSharedAuth: true,
        timeoutMs: 2_000,
      });

      expect(listed.nodes).toContainEqual(
        expect.objectContaining({
          nodeId: pendingOnlyNodeId,
          approvalState: "pending-approval",
          pendingRequestId: pending.request.requestId,
        }),
      );
    });

    test("shows only the caller's pending request id to read-only callers", async () => {
      const pairedNodeId = "node-read-only-paired";
      const pendingOnlyNodeId = "node-read-only-pending";
      const visiblePendingNode = await pairDeviceIdentity({
        name: "node-read-only-visible-pending",
        role: "operator",
        scopes: ["operator.read"],
      });
      await pairDeviceIdentity({
        name: "node-read-only-visible-pending",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const initial = await requestNodePairing({
        nodeId: pairedNodeId,
        platform: "macos",
        commands: ["screen.snapshot"],
      });
      await approveNodePairing(initial.request.requestId, {
        callerScopes: ["operator.pairing", "operator.write"],
      });
      await requestNodePairing({
        nodeId: pairedNodeId,
        platform: "macos",
        commands: ["screen.snapshot", "system.run"],
      });
      await requestNodePairing({
        nodeId: pendingOnlyNodeId,
        platform: "macos",
        commands: ["system.run"],
      });
      const visiblePending = await requestNodePairing({
        nodeId: visiblePendingNode.identity.deviceId,
        platform: "android",
        commands: ["device.status"],
      });

      const ws = await openTrackedWs(getStarted().port);
      try {
        await connectOk(ws, {
          token: "secret",
          scopes: ["operator.read"],
          deviceIdentityPath: `${await makeNodePairingStateDir()}/read-only.json`,
        });

        type NodeDiagnostics = {
          nodeId: string;
          approvalState?: string;
          pendingRequestId?: string;
          pendingDeclaredCommands?: string[];
        };
        const listed = await rpcReq<{ nodes?: NodeDiagnostics[] }>(ws, "node.list", {});
        expect(listed.ok).toBe(true);
        const nodes = listed.payload?.nodes ?? [];
        expect(nodes.some((node) => node.nodeId === pendingOnlyNodeId)).toBe(false);
        expect(nodes.find((node) => node.nodeId === pairedNodeId)).toEqual(
          expect.objectContaining({
            nodeId: pairedNodeId,
            approvalState: "pending-reapproval",
          }),
        );
        expect(nodes.find((node) => node.nodeId === pairedNodeId)).not.toHaveProperty(
          "pendingRequestId",
        );
        expect(nodes.find((node) => node.nodeId === pairedNodeId)).not.toHaveProperty(
          "pendingDeclaredCommands",
        );
        expect(nodes.find((node) => node.nodeId === visiblePendingNode.identity.deviceId)).toEqual(
          expect.objectContaining({
            nodeId: visiblePendingNode.identity.deviceId,
            approvalState: "pending-approval",
          }),
        );
        expect(
          nodes.find((node) => node.nodeId === visiblePendingNode.identity.deviceId),
        ).not.toHaveProperty("pendingRequestId");
        expect(
          nodes.find((node) => node.nodeId === visiblePendingNode.identity.deviceId),
        ).not.toHaveProperty("pendingDeclaredCommands");

        const described = await rpcReq<NodeDiagnostics>(ws, "node.describe", {
          nodeId: pairedNodeId,
        });
        expect(described.payload).toEqual(
          expect.objectContaining({
            nodeId: pairedNodeId,
            approvalState: "pending-reapproval",
          }),
        );
        expect(described.payload).not.toHaveProperty("pendingRequestId");
        expect(described.payload).not.toHaveProperty("pendingDeclaredCommands");

        const describedVisiblePending = await rpcReq<NodeDiagnostics>(ws, "node.describe", {
          nodeId: visiblePendingNode.identity.deviceId,
        });
        expect(describedVisiblePending.payload).toEqual(
          expect.objectContaining({
            nodeId: visiblePendingNode.identity.deviceId,
            approvalState: "pending-approval",
          }),
        );
        expect(describedVisiblePending.payload).not.toHaveProperty("pendingRequestId");
        expect(describedVisiblePending.payload).not.toHaveProperty("pendingDeclaredCommands");

        const pendingOnly = await rpcReq(ws, "node.describe", { nodeId: pendingOnlyNodeId });
        expect(pendingOnly.ok).toBe(false);
        expect(pendingOnly.error?.message).toContain("unknown nodeId");

        const selfWs = await openTrackedWs(getStarted().port);
        try {
          await connectOk(selfWs, {
            token: "secret",
            scopes: ["operator.read"],
            deviceIdentityPath: visiblePendingNode.identityPath,
          });
          const selfListed = await rpcReq<{ nodes?: NodeDiagnostics[] }>(selfWs, "node.list", {});
          const selfNodes = selfListed.payload?.nodes ?? [];
          expect(
            selfNodes.find((node) => node.nodeId === visiblePendingNode.identity.deviceId),
          ).toEqual(
            expect.objectContaining({
              approvalState: "pending-approval",
              pendingRequestId: visiblePending.request.requestId,
            }),
          );
          expect(selfNodes.find((node) => node.nodeId === pairedNodeId)).not.toHaveProperty(
            "pendingRequestId",
          );

          const selfDescribed = await rpcReq<NodeDiagnostics>(selfWs, "node.describe", {
            nodeId: visiblePendingNode.identity.deviceId,
          });
          expect(selfDescribed.payload).toEqual(
            expect.objectContaining({
              approvalState: "pending-approval",
              pendingRequestId: visiblePending.request.requestId,
            }),
          );
        } finally {
          selfWs.close();
        }
      } finally {
        ws.close();
      }
    });
  });

  describeWithGatewayServer("paired node reconnects", (getStarted) => {
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
