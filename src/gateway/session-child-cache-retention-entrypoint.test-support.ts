// Prepare the listing graph before the retention child's bounded GC checks.
export const sessionChildCacheRetentionEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "session-utils.child-cache-retention.test-support",
  distWorkerPath: "gateway/session-utils.child-cache-retention.test-support.js",
} as const;
