const REFRESH_DELAYS_MS = [250, 750, 1_500, 3_000, 6_000, 30_000] as const;

export function createAppliedConfigRefreshController(options: {
  shouldRefresh: () => boolean;
  refresh: (isCurrent: () => boolean) => Promise<unknown>;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let generation = 0;
  let disposed = false;

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    attempt = 0;
    generation += 1;
  };
  const reconcile = () => {
    if (disposed || !options.shouldRefresh()) {
      cancel();
      return;
    }
    if (timer) {
      return;
    }
    const delay = REFRESH_DELAYS_MS[Math.min(attempt, REFRESH_DELAYS_MS.length - 1)];
    timer = setTimeout(() => {
      timer = null;
      const refreshGeneration = generation;
      attempt = Math.min(attempt + 1, REFRESH_DELAYS_MS.length - 1);
      void options
        .refresh(() => refreshGeneration === generation)
        .then(
          () => refreshGeneration === generation && reconcile(),
          () => refreshGeneration === generation && reconcile(),
        );
    }, delay);
  };
  return {
    cancel,
    reconcile,
    dispose: () => {
      disposed = true;
      cancel();
    },
  };
}
