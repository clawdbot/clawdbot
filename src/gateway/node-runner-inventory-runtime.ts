import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import {
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_SUPERVISOR_BINARY_CAPACITY_PROTOCOL_FEATURE,
  NODE_WORKER_SUPERVISOR_BUILD_PROTOCOL_FEATURE,
  NODE_WORKER_SUPERVISOR_EXECUTION_CONTEXT_V1_PROTOCOL_FEATURE,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE,
  type NodeRunnerInventoryIssue,
  type NodeWorkerHostDeclaration,
} from "../infra/node-runner-inventory.js";

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
  protocolFeatures: readonly string[];
  workerHost?: NodeWorkerHostDeclaration;
};

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
        left.bundleStatus === right.bundleStatus))
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
    declaration.clientId === GATEWAY_CLIENT_IDS.NODE_HOST &&
    declaration.clientMode === "node" &&
    declaration.protocolFeatures.length === 1 &&
    (declaration.protocolFeatures[0] === NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE ||
      declaration.protocolFeatures[0] === NODE_WORKER_SUPERVISOR_BUILD_PROTOCOL_FEATURE ||
      declaration.protocolFeatures[0] ===
        NODE_WORKER_SUPERVISOR_EXECUTION_CONTEXT_V1_PROTOCOL_FEATURE ||
      declaration.protocolFeatures[0] === NODE_WORKER_SUPERVISOR_BINARY_CAPACITY_PROTOCOL_FEATURE)
    ? NODE_RUNNER_UPDATE_REQUIRED_ISSUE
    : undefined;
}
