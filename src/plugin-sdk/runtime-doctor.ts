/**
 * Runtime SDK subpath for plugin doctor migrations, compat checks, and uninstall helpers.
 */
export { collectProviderDangerousNameMatchingScopes } from "../config/dangerous-name-matching.js";
export { defineChannelAliasMigration } from "../config/channel-alias-migration.js";
export type {
  ChannelAliasMigrationSpec,
  StreamingAliasMode,
} from "../config/channel-alias-migration.js";
export {
  asObjectRecord,
  hasLegacyAccountStreamingAliases,
  hasLegacyStreamingAliases,
  normalizeLegacyChannelAliases,
  normalizeLegacyDmAliases,
  normalizeLegacyStreamingAliases,
  resolveLegacyAliasStreamingMode,
} from "../config/channel-compat-normalization.js";
export type {
  CompatMutationResult,
  LegacyStreamingAliasOptions,
  NormalizeLegacyChannelAccountParams,
} from "../config/channel-compat-normalization.js";
export {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
} from "../infra/plugin-install-path-warnings.js";
export type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "../plugin-state/plugin-state-store.js";
export { createPluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
export {
  detectOpenClawStateDatabaseSchemaMigrations,
  repairOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
export type { OpenClawStateDatabaseSchemaMigration } from "../state/openclaw-state-db.js";
export { removePluginFromConfig } from "../plugins/uninstall.js";
export type {
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
} from "../plugins/doctor-contract-registry.js";
export {
  archiveLegacyStateSource,
  legacyStateFileExists,
} from "../plugins/doctor-state-migration-fs.js";
export type { DoctorSessionRouteStateOwner } from "../plugins/doctor-session-route-state-owner-types.js";
