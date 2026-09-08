// Compile the real cleanup graph once, outside each fresh child's execution deadline.
export const qaGatewayCleanupRuntimeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "gateway-child-artifacts-child.test-support",
  distWorkerPath: "extensions/qa-lab/gateway-child-artifacts-child.test-support.js",
} as const;
