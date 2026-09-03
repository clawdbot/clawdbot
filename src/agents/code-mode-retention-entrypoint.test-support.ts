// Prepare the runtime graph before the retention child's bounded GC checks.
export const codeModeRetentionEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "code-mode-retention.test-support",
  distWorkerPath: "agents/code-mode-retention.test-support.js",
} as const;
