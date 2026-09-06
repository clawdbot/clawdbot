// Early JSON-output detection and console-log routing for parseable CLI stdout.
import { loggingState } from "../logging/state.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { isConfigSetJsonParseOnly } from "./config-output-mode.js";

let resolvedJsonOutputMode: boolean | null = null;

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

/** Uses Commander-resolved output ownership when available, then falls back to argv. */
export function isJsonOutputModeActive(argv: readonly string[]): boolean {
  const commandPath = resolveCliArgvInvocation([...argv]).commandPath;
  const parseOnlyJson =
    commandPath[0] === "config" && commandPath[1] === "set" && isConfigSetJsonParseOnly(argv);
  return resolvedJsonOutputMode ?? (hasJsonOutputFlag(argv) && !parseOnlyJson);
}

/** Keeps structured JSON stdout clean by routing incidental console logs to stderr. */
export async function withConsoleLogsRoutedToStderrForJson<T>(
  argv: readonly string[],
  run: () => Promise<T>,
  options: {
    machineOutput?: boolean;
    restoreChanges?: boolean;
    retainRoutingUntilProcessExit?: boolean;
  } = {},
): Promise<T> {
  const forceStderr = hasJsonOutputFlag(argv) || options.machineOutput;
  if (!forceStderr && !options.restoreChanges) {
    return run();
  }
  const previousForceStderr = loggingState.forceConsoleToStderr;
  const previousEarlyRestore = loggingState.earlyConsoleRoutingRestore;
  const previousJsonOutputMode = resolvedJsonOutputMode;
  resolvedJsonOutputMode = null;
  if (forceStderr) {
    loggingState.earlyConsoleRoutingRestore = previousForceStderr;
    loggingState.forceConsoleToStderr = true;
  }
  try {
    return await run();
  } finally {
    if (!options.retainRoutingUntilProcessExit) {
      // Restore the process-wide logging switch so nested/serial CLI calls keep their own output mode.
      loggingState.forceConsoleToStderr = previousForceStderr;
      loggingState.earlyConsoleRoutingRestore = previousEarlyRestore;
      resolvedJsonOutputMode = previousJsonOutputMode;
    }
  }
}

/** Let resolved command metadata override conservative early literal-flag routing. */
export function applyResolvedCommandOutputMode(
  jsonOutputMode: boolean,
  machineOutputMode = jsonOutputMode,
): void {
  resolvedJsonOutputMode = jsonOutputMode;
  const restore = loggingState.earlyConsoleRoutingRestore;
  if (!machineOutputMode && restore !== null) {
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
