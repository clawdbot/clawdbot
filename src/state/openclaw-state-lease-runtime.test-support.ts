// Compile once per test invocation so process-exit proof uses packaged worker startup.
export const stateLeaseProcessExitRuntimeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "openclaw-state-lease-process-exit-child.test-support",
  distWorkerPath: "state/openclaw-state-lease-process-exit-child.test-support.js",
} as const;

export const agentDatabaseHeldRuntimeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "openclaw-agent-db-held-child.test-support",
  distWorkerPath: "state/openclaw-agent-db-held-child.test-support.js",
} as const;
