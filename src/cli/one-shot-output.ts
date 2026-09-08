const ONE_SHOT_EXIT_DRAIN_TIMEOUT_MS = 5_000;

/** Drain both output pipes before a bounded one-shot process exit. */
export function drainOneShotOutput(exit: () => void): void {
  let pendingStreams = 2;

  // A missing pipe callback must not leave a completed one-shot command alive forever.
  const fallback = setTimeout(exit, ONE_SHOT_EXIT_DRAIN_TIMEOUT_MS);
  fallback.unref();

  const drain = (stream: NodeJS.WriteStream) => {
    stream.write("", () => {
      pendingStreams -= 1;
      if (pendingStreams === 0) {
        clearTimeout(fallback);
        setImmediate(exit);
      }
    });
  };

  drain(process.stdout);
  drain(process.stderr);
}
