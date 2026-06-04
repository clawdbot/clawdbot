// Provider-config public barrel. Keep provider normalization, implicit provider
// discovery, policy hooks, and secret enforcement imports centralized here so
// model config callers do not depend on each implementation file.
export { resolveImplicitProviders } from "./models-config.providers.implicit.js";
export {
  normalizeProviderCatalogModelsForConfig,
  normalizeProviders,
} from "./models-config.providers.normalize.js";
export type { ProviderConfig } from "./models-config.providers.secrets.js";
export { applyNativeStreamingUsageCompat } from "./models-config.providers.policy.js";
export { enforceSourceManagedProviderSecrets } from "./models-config.providers.source-managed.js";
