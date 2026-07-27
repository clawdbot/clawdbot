// Early JSON-output detection and console-log routing for parseable CLI stdout.
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
  options: { machineOutput?: boolean; restoreChanges?: boolean } = {},
): Promise<T> {
  const forceStderr = hasJsonOutputFlag(argv) || options.machineOutput;
  if (!forceStderr && !options.restoreChanges) {
    return run();
  }
  const previousForceStderr = loggingState.forceConsoleToStderr;
  const previousEarlyRestore = loggingState.earlyConsoleRoutingRestore;
  if (forceStderr) {
    loggingState.earlyConsoleRoutingRestore = previousForceStderr;
    loggingState.forceConsoleToStderr = true;
  }
  try {
    return await run();
  } finally {
    // Restore the process-wide logging switch so nested/serial CLI calls keep their own output mode.
    loggingState.forceConsoleToStderr = previousForceStderr;
    loggingState.earlyConsoleRoutingRestore = previousEarlyRestore;
  }
}

/** Let resolved command metadata override conservative early literal-flag routing. */
export function applyResolvedCommandOutputMode(machineOutput: boolean): void {
  const restore = loggingState.earlyConsoleRoutingRestore;
  if (!machineOutput && restore !== null) {
    loggingState.forceConsoleToStderr = restore;
  }
}

/** Route startup diagnostics to stderr while a command's output mode is still being discovered. */
export async function withConsoleLogsRoutedToStderr<T>(run: () => Promise<T>): Promise<T> {
  const previousForceStderr = loggingState.forceConsoleToStderr;
  loggingState.forceConsoleToStderr = true;
  try {
    return await run();
  } finally {
    loggingState.forceConsoleToStderr = previousForceStderr;
  }
}
