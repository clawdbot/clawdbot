import { createDeferredCore } from "./deferred.js";
import { resolveGlobalSingleton } from "./global-singleton.js";

export type KeyedFifoLease = {
  wait(signal?: AbortSignal): Promise<boolean>;
  release(): void;
};

type KeyedFifoLeaseState = {
  tails: Map<string, Promise<void>>;
  releases: Set<() => void>;
};

type KeyedFifoLeaseRegistry = {
  reserve(keys: readonly string[]): KeyedFifoLease | undefined;
};

/** Creates a close-owned FIFO registry shared by every runtime chunk using globalKey. */
export function createKeyedFifoLeaseRegistry(globalKey: symbol): KeyedFifoLeaseRegistry {
  const state = resolveGlobalSingleton<KeyedFifoLeaseState>(
    globalKey,
    () => ({ tails: new Map(), releases: new Set() }),
    (current) => {
      // Full close must unblock every predecessor chain before forgetting its tails.
      for (const release of current.releases) {
        release();
      }
      current.tails.clear();
    },
    "close-only",
  );

  return {
    reserve(inputKeys) {
      const keys = [...new Set(inputKeys)].toSorted();
      if (keys.length === 0) {
        return undefined;
      }

      const { promise: completed, resolve: complete } = createDeferredCore();
      const predecessors: Promise<void>[] = [];
      const owned = keys.map((key) => {
        const predecessor = state.tails.get(key);
        if (predecessor) {
          predecessors.push(predecessor);
        }
        // Early release must not couple an idle key to another key's busy predecessor.
        const tail = predecessor?.then(() => completed) ?? completed;
        state.tails.set(key, tail);
        return { key, tail };
      });
      const release = () => {
        if (!state.releases.delete(release)) {
          return;
        }
        complete();
        for (const { key, tail } of owned) {
          void tail.then(() => state.tails.get(key) === tail && state.tails.delete(key));
        }
      };
      state.releases.add(release);

      return {
        async wait(signal) {
          if (signal?.aborted) {
            return false;
          }
          const ready = Promise.all(predecessors).then(() => true);
          if (!signal) {
            return await ready;
          }
          return await new Promise<boolean>((resolve) => {
            const abort = () => resolve(false);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) {
              abort();
            }
            void ready.then((value) => {
              signal.removeEventListener("abort", abort);
              resolve(value);
            });
          });
        },
        release,
      };
    },
  };
}
