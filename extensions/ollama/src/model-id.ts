import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";

export const OLLAMA_PROVIDER_ID = "ollama";

function uniqueModelPrefixCandidates(providerId?: string): string[] {
  const candidates = [providerId, normalizeProviderId(providerId ?? ""), OLLAMA_PROVIDER_ID]
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => Boolean(candidate));
  return [...new Set(candidates)];
}

export function normalizeOllamaWireModelId(modelId: string, providerId?: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return trimmed;
  }
  for (const candidate of uniqueModelPrefixCandidates(providerId)) {
    const prefix = `${candidate}/`;
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return trimmed;
}
