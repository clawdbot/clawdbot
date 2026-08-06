/**
 * Runtime SDK type surface for plugin-scoped keyed state stores.
 */
import type { PluginRuntime } from "../plugins/runtime/types.js";

export function createPluginStateErrorReporter(
  getRuntime: () => Pick<PluginRuntime, "logging"> | null | undefined,
  plugin: string,
  feature: string,
  message: string,
  formatError = (error: unknown): Record<string, unknown> => ({ error: String(error) }),
) {
  return (error: unknown): void => {
    try {
      getRuntime()?.logging.getChildLogger({ plugin, feature }).warn(message, formatError(error));
    } catch {
      // State fallback must remain available even when logger setup or formatting fails.
    }
  };
}

export { configureSqliteConnectionPragmas } from "../infra/sqlite-wal.js";
export {
  migrateSqliteSchemaToStrict,
  type SqliteStrictMigrationOptions,
  type SqliteStrictMigrationResult,
} from "../infra/sqlite-strict.js";
export type {
  OpenKeyedStoreOptions,
  PluginStateEntry,
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "../plugin-state/plugin-state-store.js";
export type {
  OpenBlobStoreOptions,
  PluginBlobEntry,
  PluginBlobEntryInfo,
  PluginBlobStore,
} from "../plugin-state/plugin-blob-store.js";
export {
  PluginStateLeaseError,
  type PluginStateLeaseContext,
  type PluginStateLeaseDatabase,
  type PluginStateLeaseErrorCode,
  type PluginStateLeaseOptions,
  type PluginStateLeaseRunner,
} from "../plugin-state/plugin-state-lease.types.js";
