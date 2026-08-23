// Synthetic API module exposes the plugin public contract.
export { applySyntheticConfig, applySyntheticProviderConfig } from "./onboard.js";
export {
  buildSyntheticModelDefinition,
  SYNTHETIC_BASE_URL,
  SYNTHETIC_DEFAULT_MODEL_ID,
  SYNTHETIC_DEFAULT_MODEL_REF,
  SYNTHETIC_MODEL_CATALOG,
} from "./models.js";
export { buildSyntheticProvider } from "./provider-catalog.js";
