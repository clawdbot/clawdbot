import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { PairedDevice } from "../../infra/device-pairing.js";
import { resolveNodePairingState } from "../../infra/device-pairing.js";
import {
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE,
} from "../../infra/node-runner-inventory.js";
import { createNodeRegistryRuntime, updateNodeRunnerInventory } from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import { nodeReadHandlers } from "./nodes.read.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const { listDevicePairingMock, resolveLocalNodeIdMock } = vi.hoisted(() => ({
  listDevicePairingMock: vi.fn(),
  resolveLocalNodeIdMock: vi.fn(),
}));

vi.mock("../../infra/device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/device-pairing.js")>(
    "../../infra/device-pairing.js",
  );
  return { ...actual, listDevicePairing: listDevicePairingMock };
});

vi.mock("../../node-host/local-id.js", () => ({
  resolveLocalNodeId: resolveLocalNodeIdMock,
}));

function createPairedNode(nodeId: string): PairedDevice {
  return {
    deviceId: nodeId,
    publicKey: `public-key-${nodeId}`,
    roles: ["node"],
    tokens: {
      node: {
        token: `token-${nodeId}`,
        role: "node",
        scopes: [],
        createdAtMs: 1,
      },
    },
    nodeSurface: {
      displayName: nodeId,
      caps: [],
      commands: [],
      createdAtMs: 1,
      approvedAtMs: 1,
    },
    createdAtMs: 1,
    approvedAtMs: 1,
  };
}

function registerNode(registry: NodeRegistry, pairedNode: PairedDevice) {
  const pairingState = expectDefined(
    resolveNodePairingState(pairedNode),
    `${pairedNode.deviceId} pairing state`,
  );
  const client = {
    connId: `connection-${pairedNode.deviceId}`,
    connect: {
      client: {
        id: "node-host",
        version: "1.0.0",
        platform: "linux",
        mode: "node",
        displayName: pairedNode.deviceId,
      },
      device: { id: pairedNode.deviceId },
      scopes: [],
    },
  } as unknown as Parameters<NodeRegistry["register"]>[0];
  registry.register(client, {
    pairingIdentity: pairingState.identity.key,
    ...(pairingState.generation ? { pairingGeneration: pairingState.generation.key } : {}),
  });
  return client;
}

describe("node read projections", () => {
  it("preserves Gateway-local ownership across list and describe", async () => {
    const localNodeId = "local-node";
    const remoteNodeId = "remote-node";
    const pairedNodes = [createPairedNode(localNodeId), createPairedNode(remoteNodeId)];
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const { nodeRegistry } = runtime;
    let remoteClient: ReturnType<typeof registerNode> | undefined;
    for (const pairedNode of pairedNodes) {
      const client = registerNode(nodeRegistry, pairedNode);
      if (pairedNode.deviceId === remoteNodeId) {
        remoteClient = client;
      }
    }
    expect(
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: remoteNodeId,
        connId: remoteClient?.connId,
        declaration: { protocolFeatures: [NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE] },
      }),
    ).toEqual({ changed: true });
    listDevicePairingMock.mockResolvedValue({ pending: [], paired: pairedNodes });
    resolveLocalNodeIdMock.mockResolvedValue(localNodeId);

    const client = {
      connect: { scopes: ["operator.read"] },
    } as GatewayRequestHandlerOptions["client"];
    const context = {
      logGateway: { warn: vi.fn() },
      nodeRegistry,
    } as unknown as GatewayRequestHandlerOptions["context"];

    async function request(method: "node.list" | "node.describe", params: Record<string, unknown>) {
      const respond = vi.fn();
      await expectDefined(
        nodeReadHandlers[method],
        `${method} handler`,
      )({
        req: { type: "req", id: `request-${method}`, method, params },
        params,
        client,
        isWebchatConnect: () => false,
        respond,
        context,
      });
      expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
      return respond.mock.calls[0]?.[1];
    }

    const list = (await request("node.list", {})) as {
      nodes: Array<{ nodeId: string; gatewayLocal?: boolean; issues?: unknown[] }>;
    };
    expect(list.nodes.filter((node) => node.gatewayLocal)).toEqual([
      expect.objectContaining({ nodeId: localNodeId, gatewayLocal: true }),
    ]);
    expect(list.nodes.find((node) => node.nodeId === remoteNodeId)).not.toHaveProperty(
      "gatewayLocal",
    );
    expect(list.nodes.find((node) => node.nodeId === localNodeId)).not.toHaveProperty("issues");
    expect(list.nodes.find((node) => node.nodeId === remoteNodeId)?.issues).toEqual([
      NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
    ]);

    await expect(request("node.describe", { nodeId: localNodeId })).resolves.toEqual(
      expect.objectContaining({ nodeId: localNodeId, gatewayLocal: true }),
    );
    await expect(request("node.describe", { nodeId: remoteNodeId })).resolves.toMatchObject({
      issues: [NODE_RUNNER_UPDATE_REQUIRED_ISSUE],
    });
  });
});
