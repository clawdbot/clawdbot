// Prepare the runtime graph before the retention child's bounded GC checks.
export const sessionListCacheRetentionEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "sessions-list-cache-retention.test-support",
  distWorkerPath: "gateway/server-methods/sessions-list-cache-retention.test-support.js",
} as const;
