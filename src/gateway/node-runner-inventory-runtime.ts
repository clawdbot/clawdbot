import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import {
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  type NodeRunnerInventoryIssue,
  type NodeWorkerHostDeclaration,
} from "../infra/node-runner-inventory.js";
import type { NodeWorkerBundleStatus } from "../shared/node-list-types.js";

export type NodeWorkerBundleStatusObservation = {
  bundleHash: string;
  status: NodeWorkerBundleStatus;
};

export function sameBundleStatusObservation(
  left: NodeWorkerBundleStatusObservation | undefined,
  right: NodeWorkerBundleStatusObservation | undefined,
): boolean {
  return (
    left?.bundleHash === right?.bundleHash &&
    left?.status.status === right?.status.status &&
    (left?.status.status !== "installed" ||
      (right?.status.status === "installed" && left.status.version === right.status.version))
  );
}

export type NodeRunnerRegistrySession = {
  nodeId: string;
  connId: string;
  pairingIdentity?: string;
  pairingGeneration?: string;
  client: { invalidated?: boolean };
  clientId?: string;
  clientMode?: string;
  commands: string[];
};

export type NodeWorkerSupervisorNodeProof = {
  nodeId: string;
  connId: string;
  pairingIdentity: string;
  pairingGeneration: string;
  clientId: typeof GATEWAY_CLIENT_IDS.NODE_HOST;
  clientMode: "node";
  protocolFeature: typeof NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE;
  workerHost: Extract<NodeWorkerHostDeclaration, { enabled: true }>;
  commands: readonly string[];
};

export type NodeRunnerInventoryRecord = Omit<
  NodeWorkerSupervisorNodeProof,
  "commands" | "pairingGeneration" | "protocolFeature" | "workerHost"
> & {
  pairingGeneration?: string;
  protocolFeatures: readonly string[];
  workerHost?: NodeWorkerHostDeclaration;
};

export type NodeRunnerStateChange = {
  inventoryChanged: boolean;
  availabilityChanged: boolean;
};

export function createNodeRunnerStatePublisher(
  getNode: (nodeId: string) => NodeRunnerRegistrySession | undefined,
  runnerInventoryByConn: ReadonlyMap<string, NodeRunnerInventoryRecord>,
) {
  // Availability is an edge over the last published proof, not an inventory mutation alias.
  const availableNodeIds = new Set<string>();
  let listener = (_nodeId: string, _change: NodeRunnerStateChange) => {};
  const hasCurrent = (nodeId: string) => {
    const node = getNode(nodeId);
    return Boolean(
      node &&
      node.client.invalidated !== true &&
      resolveNodeWorkerSupervisorProof(node, runnerInventoryByConn),
    );
  };
  return {
    hasCurrent,
    reconcile: (nodeId: string, inventoryChanged: boolean) => {
      const available = hasCurrent(nodeId);
      const availabilityChanged = availableNodeIds.has(nodeId) !== available;
      if (available) {
        availableNodeIds.add(nodeId);
      } else {
        availableNodeIds.delete(nodeId);
      }
      if (inventoryChanged || availabilityChanged) {
        listener(nodeId, { inventoryChanged, availabilityChanged });
      }
    },
    setListener: (next: typeof listener) => {
      listener = next;
    },
  };
}

export type NodeRunnerStatePublisher = ReturnType<typeof createNodeRunnerStatePublisher>;

export function sameNodeWorkerHostDeclaration(
  left: NodeWorkerHostDeclaration | undefined,
  right: NodeWorkerHostDeclaration | undefined,
): boolean {
  return (
    left?.enabled === right?.enabled &&
    (left?.enabled !== true ||
      (right?.enabled === true &&
        left.capacity.total === right.capacity.total &&
        left.capacity.available === right.capacity.available &&
        left.bundlePrewarm === right.bundlePrewarm &&
        left.bundleRetention === right.bundleRetention &&
        left.bundleStatus === right.bundleStatus &&
        left.portalStream === right.portalStream))
  );
}

export function resolveNodeWorkerSupervisorProof(
  node: NodeRunnerRegistrySession,
  runnerInventoryByConn: ReadonlyMap<string, NodeRunnerInventoryRecord>,
): NodeWorkerSupervisorNodeProof | undefined {
  const declaration = runnerInventoryByConn.get(node.connId);
  if (
    !declaration ||
    !node.pairingIdentity ||
    !node.pairingGeneration ||
    node.clientId !== GATEWAY_CLIENT_IDS.NODE_HOST ||
    node.clientMode !== "node" ||
    declaration.nodeId !== node.nodeId ||
    declaration.pairingIdentity !== node.pairingIdentity ||
    declaration.pairingGeneration !== node.pairingGeneration ||
    declaration.clientId !== node.clientId ||
    declaration.clientMode !== node.clientMode ||
    !declaration.protocolFeatures.includes(NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE) ||
    declaration.workerHost?.enabled !== true
  ) {
    return undefined;
  }
  return {
    nodeId: node.nodeId,
    connId: node.connId,
    pairingIdentity: node.pairingIdentity,
    pairingGeneration: node.pairingGeneration,
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: "node",
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: {
      ...declaration.workerHost,
      capacity: { ...declaration.workerHost.capacity },
    },
    commands: [...node.commands],
  };
}

export function resolveNodeRunnerInventoryIssue(
  node: NodeRunnerRegistrySession,
  runnerInventoryByConn: ReadonlyMap<string, NodeRunnerInventoryRecord>,
): NodeRunnerInventoryIssue | undefined {
  const declaration = runnerInventoryByConn.get(node.connId);
  return declaration &&
    node.client.invalidated !== true &&
    declaration.nodeId === node.nodeId &&
    declaration.pairingIdentity === node.pairingIdentity &&
    declaration.pairingGeneration !== undefined &&
    declaration.pairingGeneration === node.pairingGeneration &&
    declaration.clientId === GATEWAY_CLIENT_IDS.NODE_HOST &&
    declaration.clientMode === "node" &&
    declaration.protocolFeatures.length === 1 &&
    declaration.protocolFeatures[0] !== NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE
    ? NODE_RUNNER_UPDATE_REQUIRED_ISSUE
    : undefined;
}
