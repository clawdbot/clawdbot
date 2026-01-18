export const loggingState = {
  cachedLogger: null as unknown,
  cachedSettings: null as unknown,
  cachedConsoleSettings: null as unknown,
  overrideSettings: null as unknown,
  consolePatched: false,
  forceConsoleToStderr: false,
  consoleTimestampPrefix: false,
  consoleSubsystemFilter: null as string[] | null,
  rawConsole: null as {
    log: typeof console.log;
    info: typeof console.info;
    warn: typeof console.warn;
    error: typeof console.error;
  } | null,
};
