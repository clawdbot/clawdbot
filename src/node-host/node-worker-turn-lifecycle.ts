import { addAbortListener } from "node:events";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { WorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import type { WorkerProcessResult } from "../worker/worker-process-protocol.js";
import type { NodeWorkerLaunchClaim, NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import { sendNodeWorkerInput } from "./node-worker-launch-transport.js";
import { createNodeWorkerCredentialScrubber } from "./node-worker-output.js";
import type { NodeWorkerSupervisorIdentity } from "./node-worker-supervisor-contract.js";
import {
  createNodeWorkerActiveTurn,
  type NodeWorkerRunningChild,
  type NodeWorkerStopState,
} from "./node-worker-supervisor-ownership.js";
import type { NodeWorkerTurnStore } from "./node-worker-turn-store.js";

/** Shutdown must be able to abort admission before it stops the retiring physical owner. */
export async function waitForNodeWorkerRetirement(
  active: NodeWorkerRunningChild,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!active.retiring) {
    return;
  }
  const aborted = createDeferredCore();
  const listener = addAbortListener(signal, () => aborted.resolve());
  try {
    await Promise.race([active.done, aborted.promise]);
  } finally {
    listener[Symbol.dispose]();
  }
}

export function nodeWorkerDescriptorSecrets(descriptor: WorkerLaunchDescriptor): string[] {
  const endpoint = descriptor.connectionEndpoint;
  const access = endpoint.kind === "websocket" ? endpoint.cloudflareAccess : undefined;
  return [
    descriptor.admission.credential,
    ...(access ? [access.clientId, access.clientSecret] : []),
  ];
}

/** Persist completion before releasing the turn; the physical launch still owns cleanup. */
export function settleNodeWorkerTurn(
  active: NodeWorkerRunningChild,
  frame: WorkerProcessResult,
  store: NodeWorkerTurnStore,
): void {
  if (active.stopState) {
    return;
  }
  const turn = active.turn;
  if (!turn || turn.claim.launchId !== frame.turnId || active.retiring) {
    throw new Error("node worker returned a result outside its active turn");
  }
  const receipt = store.finish({
    expected: turn.claim,
    ownerLaunchId: active.launchId,
    supervisor: active.supervisor,
    worker: active.worker,
    ...(turn.cancelled
      ? ({
          state: "cancelled",
          errorText: active.connectionFailure.errorText ?? "node worker turn cancelled",
        } as const)
      : ({ state: "completed", resultJson: JSON.stringify(frame.result) } as const)),
  });
  if (!receipt || receipt.state === "pending" || receipt.state === "running") {
    throw new Error("node worker turn completion lost its physical owner");
  }
  active.turn = undefined;
  active.retiring = !frame.retainWorker;
  turn.settle();
}

export async function startNodeWorkerTurn({
  active,
  descriptor,
  claim,
  signal,
  store,
  cancel,
  stopChild,
}: {
  active: NodeWorkerRunningChild;
  descriptor: WorkerLaunchDescriptor;
  claim: NodeWorkerLaunchClaim;
  signal: AbortSignal;
  store: NodeWorkerTurnStore;
  cancel: (expected: NodeWorkerSupervisorIdentity) => Promise<NodeWorkerLaunchReceipt | undefined>;
  stopChild: (active: NodeWorkerRunningChild, state: NodeWorkerStopState) => Promise<void>;
}): Promise<NodeWorkerLaunchReceipt> {
  signal.throwIfAborted();
  const admitted = store.claim({
    claim,
    ownerLaunchId: active.launchId,
    supervisor: active.supervisor,
    worker: active.worker,
  });
  if (admitted.action === "replay") {
    return admitted.receipt;
  }
  active.turn = createNodeWorkerActiveTurn(claim);
  const secrets = nodeWorkerDescriptorSecrets(descriptor);
  for (const value of secrets) {
    registerSecretValueForRedaction(value);
  }
  // The IPC diagnostic handler shares this object, so rotate its contents rather than its owner.
  Object.assign(active.scrubber, createNodeWorkerCredentialScrubber(secrets));
  active.connectionFailure.errorText = undefined;
  const onAbort = () => {
    void cancel(claim).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await sendNodeWorkerInput(active.adapter, {
      type: "turn",
      turnId: claim.launchId,
      descriptor,
    });
    if (signal.aborted) {
      await cancel(claim);
    }
  } catch {
    await stopChild(active, "interrupted");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return store.get(claim.launchId) ?? admitted.receipt;
}
