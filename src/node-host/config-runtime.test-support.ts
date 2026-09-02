// The invocation compiles this worker before the concurrent configure readiness deadline.
export const nodeHostConfigRuntimeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "config-worker.test-support",
  distWorkerPath: "node-host/config-worker.test-support.js",
} as const;
