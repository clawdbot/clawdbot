export const PLUGIN_HOST_CLEANUP_TIMEOUT_MS = 5_000;

export class PluginHostCleanupTimeoutError extends Error {
  constructor(hookId: string) {
    super(`plugin host cleanup timed out: ${hookId}`);
    this.name = "PluginHostCleanupTimeoutError";
  }
}

export async function withPluginHostCleanupTimeout<T>(
  hookId: string,
  cleanup: () => T | Promise<T>,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(cleanup),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new PluginHostCleanupTimeoutError(hookId));
        }, PLUGIN_HOST_CLEANUP_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
