/** Snapshot of global console methods that tests can restore after capture patches. */
export type ConsoleSnapshot = {
  log: typeof console.log;
  info: typeof console.info;
  warn: typeof console.warn;
  error: typeof console.error;
  debug: typeof console.debug;
  trace: typeof console.trace;
};

/** Captures current global console methods. */
export function captureConsoleSnapshot(): ConsoleSnapshot {
  return {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    trace: console.trace,
  };
}

/** Restores global console methods from a prior snapshot. */
export function restoreConsoleSnapshot(snapshot: ConsoleSnapshot): void {
  console.log = snapshot.log;
  console.info = snapshot.info;
  console.warn = snapshot.warn;
  console.error = snapshot.error;
  console.debug = snapshot.debug;
  console.trace = snapshot.trace;
}
