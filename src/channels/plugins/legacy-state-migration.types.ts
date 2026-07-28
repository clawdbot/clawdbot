export type ChannelLegacyStateMigrationPlan =
  | {
      kind: "copy" | "move";
      label: string;
      sourcePath: string;
      targetPath: string;
    }
  | {
      kind: "plugin-state-import";
      label: string;
      sourcePath: string;
      targetPath: string;
      pluginId: string;
      namespace: string;
      maxEntries: number;
      defaultTtlMs?: number;
      scopeKey: string;
      stateDir?: string;
      cleanupSource?: "rename" | "remove";
      cleanupWhenEmpty?: boolean;
      /** Deletes a non-file legacy source (e.g. plugin-state rows) once all entries are covered. */
      removeSource?: () => void | Promise<void>;
      preview?: string;
      shouldReplaceExistingEntry?: (params: {
        key: string;
        existingValue: unknown;
        incomingValue: unknown;
      }) => boolean | Promise<boolean>;
      /**
       * `timestamp` (epoch ms) and `ttlMs` order entries newest-first when capacity forces a
       * partial import; `timestamp` is also persisted as the migrated row's creation time so
       * cap eviction keeps treating imported rows as old as their legacy source.
       */
      readEntries: () =>
        | Array<{ key: string; value: unknown; ttlMs?: number; timestamp?: number }>
        | Promise<Array<{ key: string; value: unknown; ttlMs?: number; timestamp?: number }>>;
    };
