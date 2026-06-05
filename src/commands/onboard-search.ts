/**
 * Search setup command barrel.
 *
 * Keeps legacy onboard imports pointed at the shared search setup flow without
 * pulling that flow into unrelated command modules.
 */
export {
  applySearchKey,
  applySearchProviderSelection,
  hasExistingKey,
  hasKeyInEnv,
  listSearchProviderOptions,
  resolveExistingKey,
  resolveSearchProviderOptions,
  runSearchSetupFlow as setupSearch,
} from "../flows/search-setup.js";
export type { SearchProvider, SetupSearchOptions } from "../flows/search-setup.js";
