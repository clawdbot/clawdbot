import { AsyncLocalStorage } from "node:async_hooks";
import type { Dispatcher } from "undici";
import { closeDispatcher } from "./ssrf.js";

// Gateway startup imports this module before admitting requests. Pool timers and
// cleanup must keep that context instead of retaining the last request's stores.
const runInDispatcherPoolContext = AsyncLocalStorage.snapshot();

export type PinnedDispatcherLease = {
  dispatcher: Dispatcher;
  reused: boolean;
  release: () => Promise<void>;
};

type PinnedDispatcherPoolEntry = {
  key: string;
  groupKey: string;
  dispatcher: Dispatcher;
  activeLeases: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  closePromise?: Promise<void>;
};

type PinnedDispatcherPoolOptions = {
  maxEntries: number;
  idleTtlMs: number;
};

/**
 * Bounded cache of reusable DNS-pinned dispatchers.
 *
 * Callers must perform fresh DNS and SSRF validation before every acquisition
 * and include the resulting origin, address set, and connection policy in the key.
 */
export class PinnedDispatcherPool {
  private readonly entries = new Map<string, PinnedDispatcherPoolEntry>();
  private readonly ownedEntries = new Set<PinnedDispatcherPoolEntry>();
  private readonly maxEntries: number;
  private readonly idleTtlMs: number;
  private closed = false;

  constructor(options: PinnedDispatcherPoolOptions) {
    this.maxEntries = options.maxEntries;
    this.idleTtlMs = options.idleTtlMs;
  }

  acquire(params: {
    key: string;
    groupKey: string;
    createDispatcher: () => Dispatcher;
  }): PinnedDispatcherLease | undefined {
    if (this.closed) {
      return undefined;
    }

    const existing = this.entries.get(params.key);
    if (existing) {
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = undefined;
      }
      existing.activeLeases += 1;
      // Map insertion order is the cache's LRU order.
      this.entries.delete(existing.key);
      this.entries.set(existing.key, existing);
      return this.createLease(existing, true);
    }

    // A changed pin, timeout, or policy for one origin must fence the old
    // dispatcher before a replacement becomes reusable.
    for (const entry of this.entries.values()) {
      if (entry.groupKey === params.groupKey) {
        this.retireEntry(entry);
      }
    }

    if (this.entries.size >= this.maxEntries) {
      const idleEntry = [...this.entries.values()].find((entry) => entry.activeLeases === 0);
      if (idleEntry) {
        this.retireEntry(idleEntry);
      }
    }
    if (this.entries.size >= this.maxEntries) {
      // Never evict a live stream merely to satisfy the reusable-cache cap.
      return undefined;
    }

    const entry: PinnedDispatcherPoolEntry = {
      key: params.key,
      groupKey: params.groupKey,
      dispatcher: params.createDispatcher(),
      activeLeases: 1,
    };
    this.ownedEntries.add(entry);
    this.entries.set(entry.key, entry);
    return this.createLease(entry, false);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const entries = [...this.ownedEntries];
    this.entries.clear();
    await Promise.all(
      entries.map((entry) => {
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer);
          entry.idleTimer = undefined;
        }
        // Explicit lifecycle shutdown is bounded by closeDispatcher and must not
        // wait indefinitely for an abandoned response-body finalizer.
        return this.startClose(entry);
      }),
    );
  }

  private createLease(entry: PinnedDispatcherPoolEntry, reused: boolean): PinnedDispatcherLease {
    let released = false;
    return {
      dispatcher: entry.dispatcher,
      reused,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        entry.activeLeases -= 1;
        if (entry.activeLeases > 0) {
          return;
        }
        if (this.closed || this.entries.get(entry.key) !== entry) {
          await this.startClose(entry);
          return;
        }
        entry.idleTimer = runInDispatcherPoolContext(() =>
          setTimeout(() => this.retireEntry(entry), this.idleTtlMs),
        );
        entry.idleTimer.unref?.();
      },
    };
  }

  private retireEntry(entry: PinnedDispatcherPoolEntry): void {
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key);
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    if (entry.activeLeases === 0) {
      void this.startClose(entry);
    }
  }

  private startClose(entry: PinnedDispatcherPoolEntry): Promise<void> {
    entry.closePromise ??= runInDispatcherPoolContext(() =>
      closeDispatcher(entry.dispatcher).finally(() => {
        this.ownedEntries.delete(entry);
      }),
    );
    return entry.closePromise;
  }
}
