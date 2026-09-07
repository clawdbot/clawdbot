type PermitRelease = () => void;
type PermitWaiter = {
  expired: () => boolean;
  settle: (release: PermitRelease | null) => void;
};

/**
 * FIFO admission with caller-owned lifetime. Cancellation/deadlines only stop
 * waiting: an acquired permit stays held until its idempotent release is called.
 * A null result means admission was aborted or its deadline elapsed.
 */
export function createPermitPool(limit: number) {
  let active = 0;
  const waiters: PermitWaiter[] = [];

  const createRelease = (): PermitRelease => {
    active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      active -= 1;
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        if (!waiter) {
          break;
        }
        if (waiter.expired()) {
          waiter.settle(null);
          continue;
        }
        waiter.settle(createRelease());
        break;
      }
    };
  };

  return {
    async acquire({
      signal,
      deadlineAtMs,
    }: { signal?: AbortSignal; deadlineAtMs?: number } = {}): Promise<PermitRelease | null> {
      const expired = () =>
        signal?.aborted === true || (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs);
      if (expired()) {
        return null;
      }
      if (active < limit) {
        return createRelease();
      }
      return await new Promise<PermitRelease | null>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cancel = () => waiter.settle(null);
        const waiter: PermitWaiter = {
          expired,
          settle: (release) => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", cancel);
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            resolve(release);
          },
        };
        if (deadlineAtMs !== undefined) {
          timer = setTimeout(cancel, Math.max(1, deadlineAtMs - Date.now()));
          timer.unref();
        }
        signal?.addEventListener("abort", cancel, { once: true });
        waiters.push(waiter);
      });
    },
  };
}
