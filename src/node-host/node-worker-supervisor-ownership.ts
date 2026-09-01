import type { NodeWorkerCapacitySnapshot } from "../infra/node-runner-inventory.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { NodeWorkerContainerEngine } from "./node-worker-container-engine.js";
import type { NodeWorkerTerminalOutcome } from "./node-worker-launch-observation.js";
import type {
  NodeWorkerContainerIdentity,
  NodeWorkerLaunchClaim,
  NodeWorkerLaunchReceipt,
  NodeWorkerTerminalState,
} from "./node-worker-launch-store.js";
import type { NodeWorkerChildAdapter } from "./node-worker-launch-transport.js";
import type { NodeWorkerCredentialScrubber } from "./node-worker-output.js";
import type { NodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import type { NodeWorkerLaunchInput } from "./node-worker-supervisor-contract.js";
import type { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

export type NodeWorkerStopState = Extract<NodeWorkerTerminalState, "cancelled" | "interrupted">;

export type NodeWorkerEnvironmentBinding = ReturnType<typeof nodeWorkerEnvironmentBinding>;

/** Only environment facts survive a turn; descriptors contain disposable admission authority. */
export function nodeWorkerEnvironmentBinding(input: NodeWorkerLaunchInput) {
  const { admission, assignment } = input.descriptor;
  return {
    gatewayNamespace: input.gatewayNamespace,
    environmentId: admission.environmentId,
    sessionId: admission.sessionId,
    ownerEpoch: admission.ownerEpoch,
    placementGeneration: input.placementGeneration,
    bundleHash: input.expectedBundleHash,
    agentId: assignment.agentId,
    workspaceDir: assignment.workspaceDir,
    containmentRoot: assignment.workerContainmentRoot,
    permissionMode: assignment.permissionMode,
  };
}

export function nodeWorkerEnvironmentKey(
  binding: Pick<NodeWorkerEnvironmentBinding, "gatewayNamespace" | "environmentId">,
): string {
  return JSON.stringify([binding.gatewayNamespace, binding.environmentId]);
}

export function nodeWorkerEnvironmentMatches(
  binding: Pick<
    NodeWorkerEnvironmentBinding,
    "gatewayNamespace" | "environmentId" | "sessionId" | "ownerEpoch"
  >,
  expected: Pick<
    NodeWorkerEnvironmentBinding,
    "gatewayNamespace" | "environmentId" | "sessionId" | "ownerEpoch"
  >,
): boolean {
  return (
    binding.gatewayNamespace === expected.gatewayNamespace &&
    binding.environmentId === expected.environmentId &&
    binding.sessionId === expected.sessionId &&
    binding.ownerEpoch === expected.ownerEpoch
  );
}

export function createNodeWorkerActiveTurn(claim: NodeWorkerLaunchClaim) {
  const { promise, resolve } = createDeferredCore();
  return { claim, done: promise, settle: resolve, cancelled: false };
}

type NodeWorkerActiveTurn = ReturnType<typeof createNodeWorkerActiveTurn>;

type NodeWorkerActiveBase = {
  binding: NodeWorkerEnvironmentBinding;
  gatewayNamespace: string;
  launchId: string;
  planHash: string;
  supervisor: NodeWorkerProcessIdentity;
  worker: NodeWorkerProcessIdentity;
  container?: NodeWorkerContainerIdentity;
};

export type NodeWorkerRunningChild = NodeWorkerActiveBase & {
  state: "running";
  adapter: NodeWorkerChildAdapter;
  done: Promise<void>;
  journalReady: Promise<void>;
  scrubber: NodeWorkerCredentialScrubber;
  connectionFailure: { errorText?: string };
  turn?: NodeWorkerActiveTurn;
  retiring: boolean;
  stopState?: NodeWorkerStopState;
  containerCleanup?: Promise<void>;
  deferredOutcome?: NodeWorkerTerminalOutcome;
};

export type NodeWorkerObservedTerminal = NodeWorkerActiveBase & {
  state: "observed";
  outcome: NodeWorkerTerminalOutcome;
};

export type NodeWorkerActiveOwnership = NodeWorkerRunningChild | NodeWorkerObservedTerminal;

export type NodeWorkerSupervisorOptions = {
  bundleRoot?: string;
  env?: NodeJS.ProcessEnv;
  capacity?: number;
  capacityWaitMs?: number;
  onCapacityChanged?: (capacity: NodeWorkerCapacitySnapshot) => void;
  workspace?: NodeWorkerWorkspaceRuntime;
  containerEngine?: NodeWorkerContainerEngine;
  containerImage?: string;
};

/** Match both process bookkeeping and exact authoritative container identity. */
export function nodeWorkerReceiptMatchesOwner(
  receipt: NodeWorkerLaunchReceipt,
  supervisor: NodeWorkerProcessIdentity,
  worker: NodeWorkerProcessIdentity | null,
  container?: NodeWorkerContainerIdentity,
): boolean {
  const sameProcess = (
    left: NodeWorkerProcessIdentity | null,
    right: NodeWorkerProcessIdentity | null,
  ) =>
    left?.pid === right?.pid &&
    left?.startTime === right?.startTime &&
    (left !== null) === (right !== null);
  return (
    sameProcess(receipt.supervisor, supervisor) &&
    sameProcess(receipt.worker, worker) &&
    receipt.container?.engine === container?.engine &&
    receipt.container?.containerId === container?.containerId &&
    receipt.container?.engineTarget === container?.engineTarget
  );
}
