/** Max time allowed for plugin host cleanup hooks before failing shutdown. */
const PLUGIN_HOST_CLEANUP_TIMEOUT_MS = 5_000;

/** Runs plugin host cleanup with a bounded timeout and clears the timer afterward. */
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
          reject(new Error(`plugin host cleanup timed out: ${hookId}`));
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
