/** Per-session async queue wrapper used by ACP manager operations. */
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";

/** Per-session async queue that serializes ACP runtime operations and exposes queue depth. */
export class SessionActorQueue {
  private readonly queue = new KeyedAsyncQueue();
  private readonly pendingBySession = new Map<string, number>();
  private readonly epochBySession = new Map<string, number>();

  getTotalPendingCount(): number {
    let total = 0;
    for (const count of this.pendingBySession.values()) {
      total += count;
    }
    return total;
  }

  getEpoch(actorKey: string): number {
    return this.epochBySession.get(actorKey) ?? 0;
  }

  isCurrentEpoch(actorKey: string, epoch: number): boolean {
    return this.getEpoch(actorKey) === epoch;
  }

  async run<T>(actorKey: string, op: () => Promise<T>): Promise<T> {
    const epoch = this.getEpoch(actorKey);
    const queueKey = `${actorKey}\u0000${epoch}`;
    return this.queue.enqueue(
      queueKey,
      async () => {
        if (!this.isCurrentEpoch(actorKey, epoch)) {
          throw new Error(`ACP session actor was superseded for ${actorKey}.`);
        }
        return await op();
      },
      {
        onEnqueue: () => {
          this.pendingBySession.set(actorKey, (this.pendingBySession.get(actorKey) ?? 0) + 1);
        },
        onSettle: () => {
          // Keep queue-depth accounting symmetric with enqueue even when operations reject.
          const pending = (this.pendingBySession.get(actorKey) ?? 1) - 1;
          if (pending <= 0) {
            this.pendingBySession.delete(actorKey);
          } else {
            this.pendingBySession.set(actorKey, pending);
          }
        },
      },
    );
  }

  /** Starts a fresh actor lane so new work can bypass a stuck operation. */
  rotate(actorKey: string): void {
    this.epochBySession.set(actorKey, this.getEpoch(actorKey) + 1);
  }
}
