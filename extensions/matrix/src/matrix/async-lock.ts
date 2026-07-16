export type AsyncLock = <T>(fn: () => Promise<T>) => Promise<T>;

export function createAsyncLock(): AsyncLock {
  let lock: Promise<void> = Promise.resolve();
  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = lock;
    let release: (() => void) | undefined;
    lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release?.();
    }
  };
}
