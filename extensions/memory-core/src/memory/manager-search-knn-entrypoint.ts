// The plugin owns its native subprocess's source and packaged locations.
export const vectorKnnProcessEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "manager-search-knn.child",
  distWorkerPath: "extensions/memory-core/memory-search-knn.child.js",
} as const;
