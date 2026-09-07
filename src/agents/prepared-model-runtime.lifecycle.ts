/** Process close owns every admitted model runtime and native catalog worker. */
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type ModelRuntimeClose = (error: Error) => Promise<void>;
class ProcessModelRuntimeLifetimes {
  readonly closeCallbacks = new Set<ModelRuntimeClose>();
  epoch = 0;
  closing?: Promise<void>;
}

const lifetimes = resolveGlobalSingleton(
  Symbol.for("openclaw.preparedModelRuntimeLifetimes"),
  () => new ProcessModelRuntimeLifetimes(),
  () => closePreparedModelRuntimeSnapshots(),
);

export function capturePreparedModelRuntimeLifetime(): () => void {
  const epoch = lifetimes.epoch;
  const assertCurrent = () => {
    if (lifetimes.closing || epoch !== lifetimes.epoch) {
      throw new Error("prepared model runtime process lifetime closed");
    }
  };
  assertCurrent();
  return assertCurrent;
}

export function registerPreparedModelRuntimeClose(close: ModelRuntimeClose): () => void {
  capturePreparedModelRuntimeLifetime();
  lifetimes.closeCallbacks.add(close);
  return () => lifetimes.closeCallbacks.delete(close);
}

/** Fence admission before abort callbacks run; old publications cannot enter the next lifetime. */
export function closePreparedModelRuntimeSnapshots(): Promise<void> {
  if (lifetimes.closing) {
    return lifetimes.closing;
  }
  const closed = createDeferredCore();
  lifetimes.closing = closed.promise;
  lifetimes.epoch += 1;
  const error = new Error("prepared model runtime process lifetime closed");
  void Promise.allSettled([...lifetimes.closeCallbacks].map((close) => close(error))).then(
    (results) => {
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) {
        closed.reject(new AggregateError(failures, "Prepared model runtime failed to close"));
      } else {
        lifetimes.closing = undefined;
        closed.resolve();
      }
    },
  );
  return closed.promise;
}
