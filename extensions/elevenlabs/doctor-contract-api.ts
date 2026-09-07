// Elevenlabs API module exposes the plugin public contract.
export {
  ELEVENLABS_TALK_PROVIDER_ID,
  ELEVENLABS_TALK_LEGACY_CONFIG_RULES,
  hasLegacyTalkFields,
  legacyConfigRules,
  normalizeCompatibilityConfig,
} from "./doctor-contract.js";
export { migrateElevenLabsLegacyTalkConfig } from "./config-compat.js";
