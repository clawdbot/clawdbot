// Process-local logging state shared by logger, console capture, and test reset helpers.
const LOGGING_STATE_KEY = Symbol.for("openclaw.loggingState");

function createLoggingState() {
  return {
    cachedLogger: null as unknown,
    cachedSettings: null as unknown,
    cachedConsoleSettings: null as unknown,
    overrideSettings: null as unknown,
    invalidEnvLogLevelValue: null as string | null,
    consolePatched: false,
    forceConsoleToStderr: false,
    consoleTimestampPrefix: false,
    consoleSubsystemFilter: null as string[] | null,
    resolvingConsoleSettings: false,
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
globalStore[LOGGING_STATE_KEY] = loggingState;
