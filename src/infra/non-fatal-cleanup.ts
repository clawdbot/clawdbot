// Best-effort cleanup helper for temp files and disposable resources where
// cleanup failure should be reported but not replace the main result.
/** Run cleanup and swallow failures after invoking the optional error hook. */
export async function runBestEffortCleanup<T>(params: {
  cleanup: () => Promise<T>;
  onError?: (error: unknown) => void;
}): Promise<T | undefined> {
  try {
    return await params.cleanup();
  } catch (error) {
    params.onError?.(error);
    return undefined;
  }
}
