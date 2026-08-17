/** Tracks capacity-triggered child ticks without leaking the parent timer lifecycle. */
export function createCronCapacityRecheckTracker(requestRecheck: () => Promise<void> | undefined) {
  let pendingActivations = 0;
  let activationsAllowRecheck = true;
  let activationGateResolved = false;
  let resolveActivationGate!: (allowRecheck: boolean) => void;
  const activationGate = new Promise<boolean>((resolve) => {
    resolveActivationGate = resolve;
  });
  const trackedRechecks = new Set<Promise<void>>();

  const resolveActivationGateOnce = (allowRecheck: boolean) => {
    if (activationGateResolved) {
      return;
    }
    activationGateResolved = true;
    resolveActivationGate(allowRecheck);
  };

  return {
    initializeActivations(count: number) {
      pendingActivations = count;
      if (count === 0) {
        resolveActivationGateOnce(false);
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
      const recheck = activationGate.then(async (allowRecheck) => {
        if (allowRecheck) {
          await requestRecheck();
        }
      });
      trackedRechecks.add(recheck);
      void recheck.finally(() => trackedRechecks.delete(recheck));
    },
    abort() {
      resolveActivationGateOnce(false);
    },
    async drain() {
      while (trackedRechecks.size > 0) {
        await Promise.all(trackedRechecks);
      }
    },
  };
}
