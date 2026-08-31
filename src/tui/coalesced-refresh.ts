type CoalescedRefreshWork = (requestRerun: () => void) => Promise<boolean | void>;

/** Keeps refresh bursts to one active lookup plus one latest-state rerun. */
export function createTuiRefreshCoalescer(refresh: CoalescedRefreshWork, afterDrain?: () => void) {
  let active: Promise<void> | undefined;
  let rerunRequested = false;
  const requestRerun = () => {
    rerunRequested = true;
  };

  return {
    isRunning: () => active !== undefined,
    async run(): Promise<void> {
      if (active) {
        requestRerun();
        return await active;
      }
      const current = (async () => {
        do {
          rerunRequested = false;
          if ((await refresh(requestRerun)) === false) {
            return;
          }
        } while (rerunRequested);
        afterDrain?.();
      })();
      active = current;
      try {
        await current;
      } finally {
        if (active === current) {
          active = undefined;
        }
      }
    },
  };
}
