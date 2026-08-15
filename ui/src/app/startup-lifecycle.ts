type StartupDisposer = () => void;
export type StartupStep = () => void | StartupDisposer | Promise<void | StartupDisposer>;

export function createStartupLifecycle() {
  const abort = new AbortController();
  const disposers = new Set<StartupDisposer>();

  const addDisposer = (dispose: StartupDisposer) => {
    if (abort.signal.aborted) {
      dispose();
      return;
    }
    disposers.add(dispose);
  };

  return {
    signal: abort.signal,
    addDisposer,
    async run(steps: readonly StartupStep[]): Promise<void> {
      for (const step of steps) {
        if (abort.signal.aborted) {
          return;
        }
        const dispose = await step();
        if (dispose) {
          addDisposer(dispose);
        }
      }
    },
    trackDisposer(pending: Promise<StartupDisposer>, onError: (error: unknown) => void): void {
      void pending.then(addDisposer).catch((error: unknown) => {
        if (!abort.signal.aborted) {
          onError(error);
        }
      });
    },
    stop(): void {
      abort.abort();
      for (const dispose of [...disposers].toReversed()) {
        dispose();
      }
      disposers.clear();
    },
  };
}
