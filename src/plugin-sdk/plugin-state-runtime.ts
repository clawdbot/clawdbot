/**
 * Runtime SDK type surface for plugin-scoped keyed state stores.
 */
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
