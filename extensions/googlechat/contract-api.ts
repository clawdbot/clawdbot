// Googlechat API module exposes the plugin public contract.
export {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./src/secret-contract.js";
export { normalizeCompatibilityConfig, legacyConfigRules } from "./src/doctor-contract.js";
