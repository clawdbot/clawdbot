/**
 * Runtime SDK subpath for plugin doctor migrations, compat checks, and uninstall helpers.
 *
 * This barrel value-loads the state DB and plugin state store graphs. Doctor
 * contract closures (`doctor-contract-api.ts` and its imports) must use the
 * dependency-light `runtime-doctor-migrations` subpath instead so doctor
 * enumeration stays cheap; enumeration cold-loads those closures per plugin.
 */
export {
  archiveLegacyStateSource,
  asObjectRecord,
  collectChannelAccountScopes,
  collectProviderDangerousNameMatchingScopes,
  defineChannelAliasMigration,
  defineKeyMoveMigration,
  defineLegacyJsonStateMigration,
  hasLegacyAccountStreamingAliases,
  hasLegacyStreamingAliases,
  legacyStateFileExists,
  materializeInheritedAccountStreaming,
  normalizeChannelAccounts,
  normalizeChannelConfigEntries,
  normalizeLegacyChannelAliases,
  normalizeLegacyDmAliases,
  normalizeLegacyStreamingAliases,
  resolveLegacyAliasStreamingMode,
  stripRetiredChannelKeys,
} from "./runtime-doctor-migrations.js";
export type {
  ChannelAliasMigrationSpec,
  CompatMutationResult,
  DoctorSessionRouteStateOwner,
  LegacyStreamingAliasOptions,
  NormalizeChannelConfigEntryParams,
  NormalizeLegacyChannelAccountParams,
  OpenKeyedStoreOptions,
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
  PluginStateKeyedStore,
  RetiredChannelKeyRemoval,
  StreamingAliasMode,
} from "./runtime-doctor-migrations.js";

export {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
} from "../infra/plugin-install-path-warnings.js";
export { createPluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
export {
  detectOpenClawStateDatabaseSchemaMigrations,
  repairOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
export type { OpenClawStateDatabaseSchemaMigration } from "../state/openclaw-state-db.js";
export { removePluginFromConfig } from "../plugins/uninstall-config.js";
