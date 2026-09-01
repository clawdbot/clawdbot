// Task-lane config types: operator-configured JSON-file lane providers.

export type TaskLaneJsonFileProviderConfig = {
  /** Provider id; must match the task-lane provider id pattern. */
  id: string;
  /** Containment root; the resolved filePath must live inside it. */
  rootDir: string;
  /** JSON lane file, absolute or rootDir-relative. */
  filePath: string;
};

export type TaskLanesConfig = {
  /** Enabled by being present; each entry registers one JSON-file provider. */
  providers?: TaskLaneJsonFileProviderConfig[];
};
