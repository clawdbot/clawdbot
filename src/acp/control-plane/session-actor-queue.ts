/** Per-session async queue wrapper used by ACP manager operations. */
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";

/** Per-session async queue that serializes ACP runtime operations and exposes queue depth. */
export class SessionActorQueue {
  private readonly queue = new KeyedAsyncQueue();
  private readonly pendingBySession = new Map<string, number>();

  getTotalPendingCount(): number {
    let total = 0;
    for (const count of this.pendingBySession.values()) {
      total += count;
    }
    return total;
  }

  async run<T>(actorKey: string, op: () => Promise<T>): Promise<T> {
    return this.queue.enqueue(actorKey, op, {
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
    });
  }
}
