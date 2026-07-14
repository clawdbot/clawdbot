// Public model-catalog facade. Keep exports here curated so callers use the
// normalized planning APIs instead of reaching into provider-index internals.
export { loadOpenClawProviderIndex } from "./provider-index/index.js";
export {
  planManifestModelCatalogRows,
  planManifestModelCatalogSuppressions,
} from "./manifest-planner.js";
export { planProviderIndexModelCatalogRows } from "./provider-index-planner.js";
export type { ManifestModelCatalogSuppressionEntry } from "./manifest-planner.js";
export type { OpenClawProviderIndexProvider } from "./provider-index/index.js";
