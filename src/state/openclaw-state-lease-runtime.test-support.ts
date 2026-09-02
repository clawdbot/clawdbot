// Compile once per test invocation so process-exit proof uses packaged worker startup.
export const stateLeaseProcessExitRuntimeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "openclaw-state-lease-process-exit-child.test-support",
  distWorkerPath: "state/openclaw-state-lease-process-exit-child.test-support.js",
} as const;
