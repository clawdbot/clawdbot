import { AsyncLocalStorage } from "node:async_hooks";

/** Tracks capacity-triggered child ticks without leaking the parent timer lifecycle. */
export function createCronCapacityRecheckTracker(
  requestRecheck: () => Promise<void> | undefined,
  requestRecheckAfterClose: () => Promise<void> | undefined,
) {
  let pendingActivations = 0;
  let activationsAllowRecheck = true;
  let activationGateResolved = false;
  let activationGateAllowsRecheck = false;
  let closed = false;
  let resolveActivationGate!: (allowRecheck: boolean) => void;
  const activationGate = new Promise<boolean>((resolve) => {
    resolveActivationGate = resolve;
  });
  const trackedRechecks = new Set<Promise<void>>();
  // Capacity may be released from an unrelated async chain. Open requests are
  // still parent-owned, so restore the creation context before starting them.
  const runInParentContext = AsyncLocalStorage.snapshot();

  const resolveActivationGateOnce = (allowRecheck: boolean) => {
    if (activationGateResolved) {
      return;
    }
    activationGateResolved = true;
    activationGateAllowsRecheck = allowRecheck;
    resolveActivationGate(allowRecheck);
  };

  return {
    initializeActivations(count: number, allowRecheckWhenEmpty = false) {
      pendingActivations = count;
      if (count === 0) {
        resolveActivationGateOnce(allowRecheckWhenEmpty);
      }
    },
    settleActivation(allowRecheck: boolean) {
      if (activationGateResolved) {
        return;
      }
      activationsAllowRecheck &&= allowRecheck;
      pendingActivations -= 1;
      if (pendingActivations === 0) {
        resolveActivationGateOnce(activationsAllowRecheck);
      }
    },
    request() {
      if (closed) {
        if (activationGateAllowsRecheck) {
          void requestRecheckAfterClose();
        }
        return;
      }
      const recheck = activationGate.then(async (allowRecheck) => {
        if (allowRecheck) {
          await runInParentContext(requestRecheck);
        }
      });
      trackedRechecks.add(recheck);
      void recheck.finally(() => trackedRechecks.delete(recheck));
    },
    abort() {
      closed = true;
      resolveActivationGateOnce(false);
    },
    async drain() {
      while (trackedRechecks.size > 0) {
        await Promise.all(trackedRechecks);
      }
    },
  };
}
