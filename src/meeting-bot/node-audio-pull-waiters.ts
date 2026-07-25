import { setTimeout as sleep } from "node:timers/promises";

/** Internal pull-wait ownership used by the node-host long poll. */
export class MeetingNodeAudioPullWaiters {
  readonly #waiters = new Set<() => void>();

  get size(): number {
    return this.#waiters.size;
  }

  async wait(timeoutMs: number): Promise<void> {
    let wake!: () => void;
    const ready = new Promise<void>((resolve) => {
      wake = resolve;
      this.#waiters.add(wake);
    });
    try {
      await Promise.race([sleep(timeoutMs), ready]);
    } finally {
      // A stalled bridge can be polled indefinitely. Timeout must release its
      // resolver instead of retaining one waiter per empty pull.
      this.#waiters.delete(wake);
    }
  }

  wake(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }
}
