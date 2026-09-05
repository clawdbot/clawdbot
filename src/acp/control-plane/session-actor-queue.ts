import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";

/** Per-session async queue that serializes ACP runtime operations and exposes queue depth. */
export class SessionActorQueue {
  private readonly queue = new KeyedAsyncQueue();
  private pendingCount = 0;

  getTotalPendingCount(): number {
    return this.pendingCount;
  }

  async run<T>(actorKey: string, op: () => Promise<T>): Promise<T> {
    return this.queue.enqueue(actorKey, op, {
      onEnqueue: () => {
        this.pendingCount += 1;
      },
      onSettle: () => {
        // Keep queue-depth accounting symmetric with enqueue even when operations reject.
        this.pendingCount -= 1;
      },
    });
  }
}
