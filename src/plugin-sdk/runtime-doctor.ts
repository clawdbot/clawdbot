/**
 * Runtime SDK subpath for plugin doctor migrations, compat checks, and uninstall helpers.
 */
export { collectProviderDangerousNameMatchingScopes } from "../config/dangerous-name-matching.js";
export {
  asObjectRecord,
  hasLegacyAccountStreamingAliases,
  hasLegacyStreamingAliases,
  normalizeLegacyChannelAliases,
  normalizeLegacyDmAliases,
  normalizeLegacyStreamingAliases,
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
export { removePluginFromConfig } from "../plugins/uninstall.js";
export type {
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
} from "../plugins/doctor-contract-registry.js";
export type { DoctorSessionRouteStateOwner } from "../plugins/doctor-session-route-state-owner-types.js";
