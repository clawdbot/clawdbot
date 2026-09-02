// LongCat API module exposes the plugin public contract.
export {
  LONGCAT_BASE_URL,
  LONGCAT_DEFAULT_MODEL_ID,
  LONGCAT_DEFAULT_MODEL_REF,
  LONGCAT_MODEL_CATALOG,
} from "./models.js";
export { applyLongCatConfig } from "./onboard.js";
export { buildLongCatProvider } from "./provider-catalog.js";
export { createLongCatThinkingWrapper } from "./stream.js";
