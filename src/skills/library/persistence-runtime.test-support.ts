// Compile once per test invocation; each persistence operation still owns a fresh process.
export const persistenceRuntimeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "persistence-child.test-support",
  distWorkerPath: "skills/library/persistence-child.test-support.js",
} as const;
