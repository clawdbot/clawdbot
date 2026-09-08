import { normalizeModelCompat } from "./provider-model-compat.js";
import {
  buildFamilyForwardCompatModel,
  buildFirstTemplateModel,
} from "./provider-model-construction.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";

export { matchesExactOrPrefix } from "./provider-model-id-match.js";

// Cold catalog completion consumes these results without runner normalization.
// Keep its constructed-model contract separate from policy-free metadata construction.
export function cloneFirstTemplateModel(
  params: Parameters<typeof buildFirstTemplateModel>[0],
): ProviderRuntimeModel | undefined {
  return buildFirstTemplateModel(params, normalizeModelCompat);
}

export function resolveFamilyForwardCompatModel(
  params: Parameters<typeof buildFamilyForwardCompatModel>[0],
): ProviderRuntimeModel | undefined {
  return buildFamilyForwardCompatModel(params, normalizeModelCompat);
}
