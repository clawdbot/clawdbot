import { loggingState } from "../logging/state.js";

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
    loggingState.forceConsoleToStderr = previousForceStderr;
  }
}
