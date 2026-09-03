// Process-local logging state shared by logger, console capture, and test reset helpers.
import type { OpenClawConfig } from "../config/types.openclaw.js";

const LOGGING_STATE_KEY = Symbol.for("openclaw.loggingState");
export const APPLIED_LOGGING_CONFIG_UNOWNED = "unowned" as const;

function createUnownedAppliedLoggingConfig():
  | OpenClawConfig["logging"]
  | typeof APPLIED_LOGGING_CONFIG_UNOWNED {
  return APPLIED_LOGGING_CONFIG_UNOWNED;
}

function createLoggingState() {
  return {
    generation: 0,
    appliedConfig: createUnownedAppliedLoggingConfig(),
    cachedLogger: null as unknown,
    cachedSettings: null as unknown,
    cachedConsoleSettings: null as unknown,
    overrideSettings: null as unknown,
    invalidEnvLogLevelValue: null as string | null,
    consolePatched: false,
    forceConsoleToStderr: false,
    earlyConsoleRoutingRestore: null as boolean | null,
    consoleTimestampPrefix: false,
    consoleSubsystemFilter: null as string[] | null,
    streamErrorHandlersInstalled: false,
    rawConsole: null as {
      log: typeof console.log;
      info: typeof console.info;
      warn: typeof console.warn;
      error: typeof console.error;
    } | null,
  };
}

type LoggingState = ReturnType<typeof createLoggingState>;
const globalStore = globalThis as Record<PropertyKey, unknown>;

// Test runners can reload modules without creating a new process. Keep one
// state object so overrides and caches remain coherent across those copies.
export const loggingState =
  (globalStore[LOGGING_STATE_KEY] as LoggingState | undefined) ?? createLoggingState();
if (!Object.hasOwn(loggingState, "appliedConfig")) {
  loggingState.appliedConfig = APPLIED_LOGGING_CONFIG_UNOWNED;
}
globalStore[LOGGING_STATE_KEY] = loggingState;
