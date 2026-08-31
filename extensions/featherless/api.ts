// Public Featherless provider plugin API exports.
export {
  FEATHERLESS_BASE_URL,
  FEATHERLESS_DEFAULT_CONTEXT_WINDOW,
  FEATHERLESS_DEFAULT_MAX_TOKENS,
  FEATHERLESS_DEFAULT_MODEL_ID,
  FEATHERLESS_DEFAULT_MODEL_REF,
  FEATHERLESS_DYNAMIC_CONTEXT_WINDOW,
  FEATHERLESS_DYNAMIC_MAX_TOKENS,
  buildFeatherlessCatalogModels,
  isFeatherlessCatalogModelId,
} from "./models.js";
export { applyFeatherlessConfig } from "./onboard.js";
export { buildFeatherlessProvider } from "./provider-catalog.js";
