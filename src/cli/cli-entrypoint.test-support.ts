// Both concurrent writers must use the same runtime graph and version metadata.
export const cliRecoveryEntrypoints = {
  cli: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../entry",
    distWorkerPath: "entry.js",
  },
  sessionAccessor: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../config/sessions/session-accessor",
    distWorkerPath: "config/sessions/session-accessor.js",
  },
  cliSession: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../agents/cli-session",
    distWorkerPath: "agents/cli-session.js",
  },
} as const;
