/**
 * Brave Search test API barrel. Tests import normalized helpers through this
 * path instead of deep runtime modules.
 */
import {
  mapBraveLlmContextResults,
  normalizeBraveCountry,
  normalizeBraveLanguageParams,
  resolveBraveMode,
} from "./src/brave-web-search-provider.shared.js";

/** Test-only Brave normalization helpers. */
export const testing = {
  normalizeBraveCountry,
  normalizeBraveLanguageParams,
  resolveBraveMode,
  mapBraveLlmContextResults,
} as const;
export { testing as __testing };
