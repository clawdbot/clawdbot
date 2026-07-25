/** Public Baseten provider plugin API exports. */
export {
  BASETEN_BASE_URL,
  BASETEN_DEFAULT_MODEL_ID,
  BASETEN_DEFAULT_MODEL_REF,
  BASETEN_MODEL_CATALOG,
  buildBasetenModelCompat,
  buildBasetenModelDefinition,
  buildStaticBasetenModels,
  discoverBasetenModels,
  projectBasetenLiveModels,
  resolveBasetenDynamicModel,
  usesBasetenChatTemplateThinking,
} from "./models.js";
export { applyBasetenConfig } from "./onboard.js";
export { buildBasetenProvider, buildStaticBasetenProvider } from "./provider-catalog.js";
