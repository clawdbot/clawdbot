// Narrow barrel for config compatibility helpers consumed outside the plugin.
// Keep this separate from api.ts so config migration code does not pull in the
// full runtime-oriented voice-call surface.

export {
  VOICE_CALL_LEGACY_CONFIG_REMOVAL_VERSION,
  collectVoiceCallLegacyConfigIssues,
  formatVoiceCallLegacyConfigWarnings,
  migrateVoiceCallLegacyConfigInput,
  normalizeVoiceCallLegacyConfigInput,
  parseVoiceCallPluginConfig,
} from "./src/config-compat.js";
