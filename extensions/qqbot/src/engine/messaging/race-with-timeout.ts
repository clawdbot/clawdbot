interface TimeoutRaceState {
  readonly timedOut: boolean;
}

export async function raceWithTimeout<T>(
  operation: (state: TimeoutRaceState) => Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const state: TimeoutRaceState = {
    get timedOut() {
      return timedOut;
    },
  };

  try {
    return await Promise.race([
      operation(state),
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve(onTimeout());
        }, timeoutMs);
      }),
    ]);
  } finally {
    // Successful sends must release the guard timer or Node stays alive until it fires.
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
