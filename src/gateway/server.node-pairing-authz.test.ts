import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import {
  approveNodePairing,
  getPairedNode,
  listNodePairing,
  requestNodePairing,
} from "../infra/node-pairing.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
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
  }
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
      await expect(getPairedNode("node-approve-reject-admin", baseDir)).resolves.toBeNull();
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
      await expect(getPairedNode("node-approve-reject-pairing", baseDir)).resolves.toBeNull();
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

      const pairedNode = await getPairedNode("node-approve-target", baseDir);
      expect(pairedNode?.nodeId).toBe("node-approve-target");
    });
  });

  describe("paired node reconnects", () => {
    let started: Awaited<ReturnType<typeof startServerWithClient>>;

    beforeAll(async () => {
      started = await startServerWithClient("secret");
    });

    afterAll(async () => {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    });

    test("requests re-pairing when a paired node reconnects with upgraded commands", async () => {
      await expectRePairingRequest({
        started,
        pairedName: "node-command-pin",
        initialCommands: ["screen.snapshot"],
        reconnectCommands: ["screen.snapshot", "system.run"],
        approvalScopes: ["operator.pairing", "operator.write"],
        expectedVisibleCommands: ["screen.snapshot"],
      });
    });

    test("requests re-pairing when a commandless paired node reconnects with system.run", async () => {
      await expectRePairingRequest({
        started,
        pairedName: "node-command-empty",
        reconnectCommands: ["screen.snapshot", "system.run"],
        approvalScopes: ["operator.pairing"],
        expectedVisibleCommands: [],
      });
    });
  });
});
