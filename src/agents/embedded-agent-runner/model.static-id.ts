import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeStaticProviderModelId } from "../model-ref-shared.js";

export function staticModelIdMatches(params: {
  candidateId: string;
  provider: string;
  modelId: string;
  rowProvider?: string;
}): boolean {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (params.rowProvider && normalizeProviderId(params.rowProvider) !== normalizedProvider) {
    return false;
  }
  return (
    normalizeStaticProviderModelId(normalizedProvider, params.candidateId).trim().toLowerCase() ===
    normalizeStaticProviderModelId(normalizedProvider, params.modelId).trim().toLowerCase()
  );
}
