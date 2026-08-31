import type { NodeWorkerCapacity } from "./node-worker-capacity.js";
import type { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import type { NodeWorkerLaunchReceipt, NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import { inspectNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import { nodeWorkerReceiptMatchesOwner } from "./node-worker-supervisor-ownership.js";
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
  state?: "cancelled" | "interrupted";
}): Promise<NodeWorkerLaunchReceipt> {
  const { receipt } = params;
  const state = params.state ?? "interrupted";
  const latest = () => params.store.get(receipt.launchId) ?? receipt;
  const stillOwned = () => {
    const current = params.store.getMatching(receipt);
    return (
      current?.state === receipt.state &&
      current.gatewayNamespace === receipt.gatewayNamespace &&
      nodeWorkerReceiptMatchesOwner(current, receipt.supervisor, receipt.worker, receipt.container)
    );
  };
  if ((receipt.state !== "pending" && receipt.state !== "running") || !stillOwned()) {
    return latest();
  }
  const previousSupervisor = inspectNodeWorkerProcessIdentity(receipt.supervisor);
  if (previousSupervisor !== "dead" && previousSupervisor !== "reused") {
    return latest();
  }
  if (!receipt.worker && params.containerLifecycle) {
    // A pending container can exist before its identity reaches the journal.
    // Sweep it before releasing the reservation, then revalidate any pending adoption.
    await params.containerLifecycle.initialize();
    if (!stillOwned()) {
      return latest();
    }
  }
  if (receipt.container) {
    if (!params.containerLifecycle) {
      throw new Error("node worker container isolation has no lifecycle owner");
    }
    const containerState = await params.containerLifecycle.inspect(receipt.container, receipt);
    if (!stillOwned()) {
      return latest();
    }
    if (containerState === "unknown") {
      if (state === "cancelled") {
        return latest();
      }
      throw new Error(
        `node worker container ${receipt.container.containerId} could not be inspected; restore its ${receipt.container.engine} engine before enabling worker hosting`,
      );
    }
    if (containerState === "reused") {
      if (state === "cancelled") {
        return latest();
      }
      throw new Error(`node worker launch ${receipt.launchId} lost its container ownership`);
    }
    await params.containerLifecycle.remove(receipt.container, receipt);
  } else if (receipt.worker) {
    let workerState = inspectOwnedNodeWorkerTree(receipt.worker);
    if (workerState === "unknown") {
      return latest();
    }
    if (workerState === "live") {
      if (!stillOwned()) {
        return latest();
      }
      await signalOwnedNodeWorkerTree(receipt.worker, "SIGTERM");
      workerState = await waitForOwnedNodeWorkerTreeDeath(receipt.worker, STOP_GRACE_MS);
    }
    if (workerState === "live") {
      if (!stillOwned()) {
        return latest();
      }
      await signalOwnedNodeWorkerTree(receipt.worker, "SIGKILL");
      workerState = await waitForOwnedNodeWorkerTreeDeath(receipt.worker, FORCE_STOP_WAIT_MS);
    }
    if (workerState !== "dead") {
      return latest();
    }
  }
  if (!stillOwned()) {
    return latest();
  }
  return params.capacity.finish(
    {
      launchId: receipt.launchId,
      planHash: receipt.planHash,
      supervisor: receipt.supervisor,
      worker: receipt.worker,
      state,
      errorText:
        state === "cancelled"
          ? "node worker launch cancelled"
          : receipt.worker
            ? "node host stopped before the worker launch completed"
            : "node host stopped before the worker launch started",
    },
    params.notifyCapacity,
  );
}
