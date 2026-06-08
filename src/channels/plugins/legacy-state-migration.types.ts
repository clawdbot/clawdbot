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
      scopeKey: string;
      stateDir?: string;
      cleanupSource?: "rename";
      cleanupWhenEmpty?: boolean;
      preview?: string;
      shouldReplaceExistingEntry?: (params: {
        key: string;
        existingValue: unknown;
        incomingValue: unknown;
      }) => boolean | Promise<boolean>;
      readEntries: () =>
        | Array<{ key: string; value: unknown; ttlMs?: number }>
        | Promise<Array<{ key: string; value: unknown; ttlMs?: number }>>;
    };
