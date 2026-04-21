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
export { removePluginFromConfig } from "../plugins/uninstall.js";
