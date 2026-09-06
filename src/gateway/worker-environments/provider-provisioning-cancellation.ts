import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createDeferredCore } from "../../shared/deferred.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";

export function createWorkerProvisionCancellation(
  store: WorkerEnvironmentStore,
  record: WorkerEnvironmentRecord,
  signal: AbortSignal,
) {
  let owners = 1;
  const settled = createDeferredCore();
  let intentError: Error | undefined;
  const requestStop = () => {
    try {
      const current = store.get(record.environmentId);
      if (
        current?.provisionOperationId === record.provisionOperationId &&
        current.ownerEpoch === record.ownerEpoch &&
        (current.state === "requested" ||
          current.state === "provisioning" ||
          current.state === "bootstrapping")
      ) {
        store.requestDestroy({ environmentId: current.environmentId, state: current.state });
      }
    } catch (error) {
      // Abort listeners cannot throw into the caller. The operation still drains its child,
      // then reports the failed durable intent through its ordinary completion path.
      intentError = toErrorObject(error, "Worker cancellation intent failed");
    }
  };
  signal.addEventListener("abort", requestStop, { once: true });
  if (signal.aborted) {
    requestStop();
  }
  const close = () => {
    if (--owners === 0) {
      signal.removeEventListener("abort", requestStop);
      settled.resolve();
    }
  };
  return {
    signal,
    settled: settled.promise,
    close,
    assertActive: () => {
      if (intentError !== undefined) {
        throw intentError;
      }
      signal.throwIfAborted();
    },
    retainProvider: <T>(run: () => Promise<T>) => {
      // A caller timeout does not settle the queued provider. Retain cancellation until
      // that exact operation exits, including while later cleanup waits behind it.
      owners += 1;
      return async () => {
        try {
          signal.throwIfAborted();
          return await run();
        } finally {
          close();
        }
      };
    },
  };
}
