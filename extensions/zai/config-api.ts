// Narrow config barrel for core/test consumers.
// Keep this separate from provider registration/runtime imports.

export { applyZaiConfig, applyZaiProviderConfig, ZAI_DEFAULT_MODEL_REF } from "./onboard.js";
export {
  ZAI_CN_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_GLOBAL_BASE_URL,
  ZAI_DEFAULT_COST,
  ZAI_DEFAULT_MODEL_ID,
  ZAI_GLOBAL_BASE_URL,
} from "./model-definitions.js";
