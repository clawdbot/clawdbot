// The plugin owns its publication worker's source and packaged locations.
export const memoryPublishWorkerEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "manager-publish.worker",
  distWorkerPath: "extensions/memory-core/memory-publish.worker.js",
} as const;
