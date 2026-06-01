import { loggingState } from "../logging/state.js";

/** Detects CLI JSON mode before Commander parses options, stopping at the argv sentinel. */
export function hasJsonOutputFlag(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") {
      return false;
    }
    if (arg === "--json" || arg.startsWith("--json=")) {
      return true;
    }
  }
  return false;
}

/** Keeps structured JSON stdout clean by routing incidental console logs to stderr. */
export async function withConsoleLogsRoutedToStderrForJson<T>(
  argv: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  if (!hasJsonOutputFlag(argv)) {
    return run();
  }
  const previousForceStderr = loggingState.forceConsoleToStderr;
  loggingState.forceConsoleToStderr = true;
  try {
    return await run();
  } finally {
    // Restore the process-wide logging switch so nested/serial CLI calls keep their own output mode.
    loggingState.forceConsoleToStderr = previousForceStderr;
  }
}
