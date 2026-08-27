import type { NodeWorkerCapacitySnapshot } from "../infra/node-runner-inventory.js";
import type { NodeWorkerContainerEngine } from "./node-worker-container-engine.js";
import type { NodeWorkerTerminalOutcome } from "./node-worker-launch-observation.js";
import type {
  NodeWorkerContainerIdentity,
  NodeWorkerLaunchReceipt,
  NodeWorkerTerminalState,
} from "./node-worker-launch-store.js";
import type { NodeWorkerChildAdapter } from "./node-worker-launch-transport.js";
import type { NodeWorkerCredentialScrubber } from "./node-worker-output.js";
import type { NodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import type { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

export type NodeWorkerStopState = Extract<NodeWorkerTerminalState, "cancelled" | "interrupted">;

type NodeWorkerActiveBase = {
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
  releaseJournal: () => void;
  scrubber: NodeWorkerCredentialScrubber;
  connectionFailure: { errorText?: string };
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

/** Delay result observation until the launch's exact owner has been journaled. */
export function createNodeWorkerJournalGate(): {
  journalReady: Promise<void>;
  releaseJournal: () => void;
} {
  let released = false;
  let resolveReady!: () => void;
  const journalReady = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  return {
    journalReady,
    releaseJournal: () => {
      if (!released) {
        released = true;
        resolveReady();
      }
    },
  };
}
