/**
 * Z.AI Search test API barrel. Tests import normalized helpers through this
 * path instead of deep runtime modules.
 */
import { resolveRecencyFilter, resolveLocation } from "./src/zai-web-search-provider.runtime.js";

/** Test-only Z.AI search normalization helpers. */
export const testing = {
  resolveRecencyFilter,
  resolveLocation,
} as const;
