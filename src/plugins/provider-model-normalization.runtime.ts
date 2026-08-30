/** Stable synchronous entry for cold model normalization in packaged core. */
import { resolveProviderHookPlugin } from "./provider-hook-runtime.js";
import {
  normalizeProviderModelIdWithResolvedPlugin,
  type ProviderModelIdNormalizationParams,
} from "./provider-model-normalization.js";

export function normalizeProviderModelIdWithPlugin(
  params: ProviderModelIdNormalizationParams,
): string | undefined {
  return normalizeProviderModelIdWithResolvedPlugin(params, resolveProviderHookPlugin(params));
}
