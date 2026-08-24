import type { NodeWorkerCapacity } from "./node-worker-capacity.js";
import type { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import type { NodeWorkerLaunchReceipt, NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import { inspectNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import {
  inspectOwnedNodeWorkerTree,
  signalOwnedNodeWorkerTree,
  waitForOwnedNodeWorkerTreeDeath,
} from "./node-worker-tree-control.js";

const STOP_GRACE_MS = 1_000;
const FORCE_STOP_WAIT_MS = 4_000;

/** Reconcile stale launch ownership against its actual process or container authority. */
export async function recoverNodeWorkerLaunch(params: {
  receipt: NodeWorkerLaunchReceipt;
  store: NodeWorkerLaunchStore;
  capacity: NodeWorkerCapacity;
  containerLifecycle?: NodeWorkerContainerLifecycle;
  notifyCapacity: boolean;
}): Promise<NodeWorkerLaunchReceipt> {
  const { receipt } = params;
  if (receipt.state !== "running" || !receipt.worker) {
    return receipt;
  }
  const previousSupervisor = inspectNodeWorkerProcessIdentity(receipt.supervisor);
  if (previousSupervisor !== "dead" && previousSupervisor !== "reused") {
    return params.store.get(receipt.launchId) ?? receipt;
  }
  if (receipt.container) {
    if (!params.containerLifecycle) {
      throw new Error("node worker container isolation has no lifecycle owner");
    }
    const containerState = await params.containerLifecycle.inspect(receipt.container, receipt);
    if (containerState === "unknown") {
      throw new Error(
        `node worker container ${receipt.container.containerId} could not be inspected; restore its ${receipt.container.engine} engine before enabling worker hosting`,
      );
    }
    if (containerState === "reused") {
      throw new Error(`node worker launch ${receipt.launchId} lost its container ownership`);
    }
    await params.containerLifecycle.remove(receipt.container, receipt);
  } else {
    let workerState = inspectOwnedNodeWorkerTree(receipt.worker);
    if (workerState === "unknown") {
      return params.store.get(receipt.launchId) ?? receipt;
    }
    if (workerState === "live") {
      await signalOwnedNodeWorkerTree(receipt.worker, "SIGTERM");
      workerState = await waitForOwnedNodeWorkerTreeDeath(receipt.worker, STOP_GRACE_MS);
    }
    if (workerState === "live") {
      await signalOwnedNodeWorkerTree(receipt.worker, "SIGKILL");
      workerState = await waitForOwnedNodeWorkerTreeDeath(receipt.worker, FORCE_STOP_WAIT_MS);
    }
    if (workerState !== "dead") {
      return params.store.get(receipt.launchId) ?? receipt;
    }
  }
  return params.capacity.finish(
    {
      launchId: receipt.launchId,
      planHash: receipt.planHash,
      supervisor: receipt.supervisor,
      worker: receipt.worker,
      state: "interrupted",
      errorText: "node host stopped before the worker launch completed",
    },
    params.notifyCapacity,
  );
}
