import { NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE } from "../infra/node-commands.js";
import {
  NodeWorkerLaunchStore,
  type NodeWorkerLaunchClaim,
  type NodeWorkerLaunchClaimResult,
  type NodeWorkerLaunchReceipt,
} from "./node-worker-launch-store.js";
import {
  inspectNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";

const DEFAULT_WORKER_CAPACITY = 2;
const DEFAULT_CAPACITY_WAIT_MS = 10_000;
const CAPACITY_POLL_MS = 100;

type NodeWorkerCapacityOptions = {
  capacity?: number;
  capacityWaitMs?: number;
  onAvailabilityChanged?: (available: boolean) => void;
};

function capacityAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("node worker admission aborted");
}

export class NodeWorkerCapacityExhaustedError extends Error {
  readonly code = NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE;

  constructor(waitMs: number) {
    super(`node worker capacity remained full for ${waitMs} ms`);
    this.name = "NodeWorkerCapacityExhaustedError";
  }
}

/** Owns durable worker slot admission and live full/free publication edges. */
export class NodeWorkerCapacity {
  private readonly capacity: number;
  private readonly waitMs: number;
  private readonly onAvailabilityChanged?: (available: boolean) => void;
  private readonly waiters = new Set<() => void>();
  private readonly closeAbort = new AbortController();
  private availability?: boolean;

  constructor(
    private readonly store: NodeWorkerLaunchStore,
    options: NodeWorkerCapacityOptions = {},
  ) {
    this.capacity = options.capacity ?? DEFAULT_WORKER_CAPACITY;
    this.waitMs = options.capacityWaitMs ?? DEFAULT_CAPACITY_WAIT_MS;
    this.onAvailabilityChanged = options.onAvailabilityChanged;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) {
      throw new Error("node worker capacity must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.waitMs) || this.waitMs < 0) {
      throw new Error("node worker capacity wait must be a non-negative safe integer");
    }
  }

  async initialize(
    recoverRunning: (receipt: NodeWorkerLaunchReceipt) => Promise<void>,
  ): Promise<void> {
    this.publish(false);
    for (const receipt of this.store.listNonterminal()) {
      if (receipt.state === "pending") {
        const supervisorState = inspectNodeWorkerProcessIdentity(receipt.supervisor);
        if (supervisorState === "dead" || supervisorState === "reused") {
          this.finish(
            {
              launchId: receipt.launchId,
              planHash: receipt.planHash,
              supervisor: receipt.supervisor,
              worker: null,
              state: "interrupted",
              errorText: "node host stopped before the worker launch started",
            },
            false,
          );
        }
        continue;
      }
      await recoverRunning(receipt);
    }
    this.store.pruneExpiredTerminal();
    this.refresh();
  }

  async claim(
    claim: NodeWorkerLaunchClaim,
    supervisor: NodeWorkerProcessIdentity,
    signal?: AbortSignal,
  ): Promise<Exclude<NodeWorkerLaunchClaimResult, { action: "at-capacity" }>> {
    const deadlineMs = Date.now() + this.waitMs;
    while (true) {
      if (this.closeAbort.signal.aborted) {
        throw new Error("node worker supervisor is closed");
      }
      signal?.throwIfAborted();
      const result = this.store.claim(claim, supervisor, this.capacity);
      this.publish(result.nonterminalCount < this.capacity);
      if (result.action !== "at-capacity") {
        return result;
      }
      await this.wait(deadlineMs, signal);
    }
  }

  finish(
    params: Parameters<NodeWorkerLaunchStore["finish"]>[0],
    notify = true,
  ): NodeWorkerLaunchReceipt {
    const receipt = this.store.finish(params);
    if (notify && receipt.state !== "pending" && receipt.state !== "running") {
      this.changed();
    }
    return receipt;
  }

  finishCancelled(
    params: Parameters<NodeWorkerLaunchStore["finishCancelled"]>[0],
  ): NodeWorkerLaunchReceipt | undefined {
    const receipt = this.store.finishCancelled(params);
    if (receipt && receipt.state !== "pending" && receipt.state !== "running") {
      this.changed();
    }
    return receipt;
  }

  close(): void {
    this.closeAbort.abort();
    this.wake();
  }

  private publish(available: boolean): void {
    if (this.availability === available) {
      return;
    }
    this.availability = available;
    this.onAvailabilityChanged?.(available);
  }

  private refresh(): void {
    const count = this.store.nonterminalCount();
    this.publish(count < this.capacity);
    if (count < this.capacity) {
      this.wake();
    }
  }

  private changed(): void {
    this.wake();
    try {
      this.refresh();
    } catch {
      this.publish(false);
    }
  }

  private wake(): void {
    for (const wake of this.waiters) {
      wake();
    }
  }

  private async wait(deadlineMs: number, signal?: AbortSignal): Promise<void> {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new NodeWorkerCapacityExhaustedError(this.waitMs);
    }
    if (signal?.aborted) {
      throw capacityAbortReason(signal);
    }
    if (this.closeAbort.signal.aborted) {
      throw new Error("node worker supervisor is closed");
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (operation: () => void) => {
        clearTimeout(pollTimer);
        this.waiters.delete(wake);
        signal?.removeEventListener("abort", onAbort);
        this.closeAbort.signal.removeEventListener("abort", onClose);
        operation();
      };
      const wake = () => finish(resolve);
      const onAbort = () =>
        finish(() =>
          reject(signal ? capacityAbortReason(signal) : new Error("node worker admission aborted")),
        );
      const onClose = () => finish(() => reject(new Error("node worker supervisor is closed")));
      const pollTimer = setTimeout(wake, Math.min(CAPACITY_POLL_MS, remainingMs));
      pollTimer.unref?.();
      this.waiters.add(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.closeAbort.signal.addEventListener("abort", onClose, { once: true });
    });
  }
}
