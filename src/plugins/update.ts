/** Updates installed plugins across npm, ClawHub, marketplace, Git, and bundled bridge sources. */
export type { PluginUpdateIntegrityDriftParams, PluginUpdateOutcome } from "./update-source.js";

export {
  isPluginInstallRecordUpdateSource,
  pluginInstallRecordMayMigrateConfigId,
} from "./update-source.js";
export { isClawHubTrustSkippedOutcome } from "./update-attempt.js";
export { updateNpmInstalledPlugins } from "./update-installed.js";
export { syncPluginsForUpdateChannel } from "./update-channel.js";
