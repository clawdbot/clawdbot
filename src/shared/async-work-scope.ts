import { AsyncLocalStorage } from "node:async_hooks";
import { createDeferredCore } from "./deferred.js";
import { resolveGlobalSingleton } from "./global-singleton.js";

// Lazy runtime chunks share the context carrier, never the lifetime of its owners.
const currentWorkScope = resolveGlobalSingleton(
  Symbol.for("openclaw.asyncWorkScope"),
  () => new AsyncLocalStorage<AsyncWorkScope>(),
);

/** Joins cooperating descendants even when their caller returns a cached value first. */
export class AsyncWorkScope {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly controller = new AbortController();
  private phase: "open" | "closing" | "closed" = "open";

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isClosing(): boolean {
    return this.phase !== "open";
  }

  track<T>(run: () => T | Promise<T>): Promise<T> {
    if (this.phase === "closed") {
      return Promise.reject(new Error("Async work scope is closed"));
    }
    // Register before invoking without delaying received node results behind
    // a subsequent socket-close event. Async descendants inherit this exact owner.
    const operation = createDeferredCore<T>();
    this.pending.add(operation.promise);
    void operation.promise.then(
      () => this.pending.delete(operation.promise),
      () => this.pending.delete(operation.promise),
    );
    try {
      operation.resolve(currentWorkScope.run(this, run));
    } catch (error) {
      operation.reject(error);
    }
    return operation.promise;
  }

  beginClose(): void {
    if (this.phase !== "open") {
      return;
    }
    this.phase = "closing";
    this.controller.abort();
  }

  async drain(): Promise<void> {
    this.beginClose();
    // An admitted parent can register a cleanup tail while it settles.
    while (this.pending.size > 0) {
      await Promise.allSettled(this.pending);
    }
    this.phase = "closed";
  }
}

/** Outside a managed scope, the returned promise remains the caller's responsibility. */
export async function trackAsyncWork<T>(run: () => T | Promise<T>): Promise<T> {
  const scope = currentWorkScope.getStore();
  return await (scope ? scope.track(run) : run());
}

/** Captures only work ownership, never the caller's authorization or other async context. */
export function captureAsyncWorkTracker(): typeof trackAsyncWork {
  const scope = currentWorkScope.getStore();
  return async (run) => await (scope ? scope.track(run) : currentWorkScope.exit(run));
}

export function getAsyncWorkSignal(): AbortSignal | undefined {
  return currentWorkScope.getStore()?.signal;
}
