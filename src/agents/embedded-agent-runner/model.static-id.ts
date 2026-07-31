import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  createStaticProviderModelIdNormalizer,
  normalizeStaticProviderModelId,
  type ProviderModelIdNormalizationOptions,
} from "../model-ref-shared.js";

type StaticModelIdMatchParams = {
  candidateId: string;
  provider: string;
  modelId: string;
  rowProvider?: string;
};

export type StaticModelIdMatcher = (params: StaticModelIdMatchParams) => boolean;

function matchesStaticModelId(
  params: StaticModelIdMatchParams,
  normalizeModelId: (provider: string, model: string) => string,
): boolean {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (params.rowProvider && normalizeProviderId(params.rowProvider) !== normalizedProvider) {
    return false;
  }
  return (
    normalizeModelId(normalizedProvider, params.candidateId).trim().toLowerCase() ===
    normalizeModelId(normalizedProvider, params.modelId).trim().toLowerCase()
  );
}

export function staticModelIdMatches(params: StaticModelIdMatchParams): boolean {
  return matchesStaticModelId(params, normalizeStaticProviderModelId);
}

/** Builds a matcher pinned to one prepared manifest-policy generation. */
export function createStaticModelIdMatcher(
  options: ProviderModelIdNormalizationOptions = {},
): StaticModelIdMatcher {
  const normalizeModelId = createStaticProviderModelIdNormalizer(options);
  return (params) => matchesStaticModelId(params, normalizeModelId);
}
