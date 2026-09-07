import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import {
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  NODE_WORKER_WORKSPACE_MANIFEST_VERSION,
  NODE_WORKER_WORKSPACE_SKILL_RESOURCES_VERSION,
  type NodeRunnerInventoryIssue,
  type NodeWorkerHostDeclaration,
} from "../infra/node-runner-inventory.js";
import type { NodeWorkerBundleStatus } from "../shared/node-list-types.js";

type NodeWorkerHostClientId =
  | typeof GATEWAY_CLIENT_IDS.NODE_HOST
  | typeof GATEWAY_CLIENT_IDS.MACOS_APP;

/** Both first-party hosts run the shared node runtime without changing client identity. */
export function isNodeWorkerHostClientId(
  clientId: string | undefined,
): clientId is NodeWorkerHostClientId {
  return clientId === GATEWAY_CLIENT_IDS.NODE_HOST || clientId === GATEWAY_CLIENT_IDS.MACOS_APP;
}

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
  clientId: NodeWorkerHostClientId;
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

export function resolveNodeWorkerSupervisorProof(
  node: NodeRunnerRegistrySession,
  runnerInventoryByConn: ReadonlyMap<string, NodeRunnerInventoryRecord>,
): NodeWorkerSupervisorNodeProof | undefined {
  const declaration = runnerInventoryByConn.get(node.connId);
  if (
    !declaration ||
    !node.pairingIdentity ||
    !node.pairingGeneration ||
    !isNodeWorkerHostClientId(node.clientId) ||
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
    clientId: node.clientId,
    clientMode: "node",
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: {
      ...declaration.workerHost,
      capacity: { ...declaration.workerHost.capacity },
    },
    commands: [...node.commands],
  };
}

export type NodeWorkerSupervisorProofRequirements = {
  launchEligibility?: boolean;
  commands?: readonly string[];
  environmentSession?: boolean;
  workspaceManifest?: boolean;
  workspaceSkillResources?: boolean;
};

/** Match a captured proof against the registry's current connection and inventory. */
export function isNodeWorkerSupervisorProofCurrent(
  node: NodeRunnerRegistrySession | undefined,
  runnerInventoryByConn: ReadonlyMap<string, NodeRunnerInventoryRecord>,
  proof: NodeWorkerSupervisorNodeProof,
  requirements: NodeWorkerSupervisorProofRequirements = {},
): boolean {
  if (!node || node.client.invalidated === true || node.connId !== proof.connId) {
    return false;
  }
  const current = resolveNodeWorkerSupervisorProof(node, runnerInventoryByConn);
  return (
    current?.pairingIdentity === proof.pairingIdentity &&
    current.pairingGeneration === proof.pairingGeneration &&
    current.clientId === proof.clientId &&
    current.clientMode === proof.clientMode &&
    current.protocolFeature === proof.protocolFeature &&
    (!requirements.launchEligibility || current.workerHost.capacity.available > 0) &&
    (!requirements.environmentSession ||
      current.workerHost.environmentSession === NODE_WORKER_ENVIRONMENT_SESSION_VERSION) &&
    (!requirements.workspaceManifest ||
      current.workerHost.workspaceManifest === NODE_WORKER_WORKSPACE_MANIFEST_VERSION) &&
    (!requirements.workspaceSkillResources ||
      current.workerHost.workspaceSkillResources ===
        NODE_WORKER_WORKSPACE_SKILL_RESOURCES_VERSION) &&
    (requirements.commands?.every((command) => current.commands.includes(command)) ?? true)
  );
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
    isNodeWorkerHostClientId(node.clientId) &&
    declaration.clientId === node.clientId &&
    node.clientMode === "node" &&
    declaration.clientMode === "node" &&
    declaration.protocolFeatures.length === 1 &&
    (declaration.protocolFeatures[0] !== NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE ||
      (declaration.workerHost?.enabled === true &&
        declaration.workerHost.workspaceManifest !== NODE_WORKER_WORKSPACE_MANIFEST_VERSION))
    ? NODE_RUNNER_UPDATE_REQUIRED_ISSUE
    : undefined;
}
