// Openzoo API module exposes the plugin public contract.
export {
  hasOpenzooAuthorizationHeader,
  isOpenzooKeylessApiKey,
  resolveOpenzooProviderAuthMode,
  shouldUseOpenzooSyntheticAuth,
} from "./provider-auth.js";
export { buildOpenzooProvider, buildOpenzooProviderWithDiscovery } from "./provider-catalog.js";
export {
  buildOpenzooModelDefinition,
  discoverOpenzooModels,
  normalizeOpenzooBaseUrl,
  OPENZOO_BASE_URL_ENV_VAR,
  OPENZOO_DEFAULT_BASE_URL,
  OPENZOO_DEFAULT_CONTEXT_WINDOW,
  OPENZOO_DEFAULT_COST,
  OPENZOO_DEFAULT_MAX_TOKENS,
  OPENZOO_DEFAULT_MODEL_ID,
  OPENZOO_DEFAULT_MODEL_NAME,
  OPENZOO_DEFAULT_MODEL_REF,
  OPENZOO_DEFAULT_PORT,
  OPENZOO_LOCAL_API_KEY_PLACEHOLDER,
  OPENZOO_MODEL_CATALOG,
  OPENZOO_PORT_ENV_VAR,
  OPENZOO_PROVIDER_ID,
  OPENZOO_PROVIDER_LABEL,
  parseOpenzooReasoning,
  projectOpenzooModels,
  resolveOpenzooBaseUrl,
  resolveOpenzooInfoUrl,
  resolveOpenzooModelsUrl,
} from "./provider-models.js";
