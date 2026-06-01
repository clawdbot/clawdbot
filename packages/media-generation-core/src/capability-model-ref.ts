import { normalizeOptionalString } from "./string.js";

/** Provider catalog entry shape used when resolving capability-scoped model references. */
export type CapabilityModelProviderCandidate = {
  id: string;
  aliases?: readonly string[];
  defaultModel?: string | null;
  models?: readonly string[];
};

/** Normalized provider/model reference selected for a media capability. */
export type CapabilityModelRef = {
  provider: string;
  model: string;
};

type ProviderIdNormalizer = (value: string) => string | undefined;

function normalizeProviderForMatch(
  value: string | undefined,
  normalizeProviderId: ProviderIdNormalizer | undefined,
): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized && normalizeProviderId ? normalizeProviderId(normalized) : normalized;
}

/** Finds a provider by id or alias using the caller's provider-id normalization rules. */
export function findCapabilityProviderById<T extends CapabilityModelProviderCandidate>(params: {
  providers: readonly T[];
  providerId?: string;
  normalizeProviderId?: ProviderIdNormalizer;
}): T | undefined {
  const selectedProvider = normalizeProviderForMatch(params.providerId, params.normalizeProviderId);
  if (!selectedProvider) {
    return undefined;
  }
  return params.providers.find((provider) => {
    const providerId = normalizeProviderForMatch(provider.id, params.normalizeProviderId);
    return (
      providerId === selectedProvider ||
      (provider.aliases ?? []).some(
        (alias) =>
          normalizeProviderForMatch(alias, params.normalizeProviderId) === selectedProvider,
      )
    );
  });
}

/** Resolves a bare model name to the provider that advertises it for this capability. */
export function resolveCapabilityProviderModelOnlyRef(params: {
  providers: readonly CapabilityModelProviderCandidate[];
  raw?: string;
}): CapabilityModelRef | null {
  const model = normalizeOptionalString(params.raw);
  if (!model) {
    return null;
  }
  const provider = params.providers.find((candidate) => {
    const models = [candidate.defaultModel, ...(candidate.models ?? [])];
    return models.some((entry) => normalizeOptionalString(entry) === model);
  });
  return provider ? { provider: provider.id, model } : null;
}

/** Resolves provider/model refs first, then falls back to model-only catalog matching. */
export function resolveCapabilityModelRefForProviders(params: {
  providers: readonly CapabilityModelProviderCandidate[];
  raw?: string;
  parseModelRef: (raw: string | undefined) => CapabilityModelRef | null;
  normalizeProviderId?: ProviderIdNormalizer;
}): CapabilityModelRef | null {
  const raw = normalizeOptionalString(params.raw);
  if (!raw) {
    return null;
  }
  const parsed = params.parseModelRef(raw);
  if (
    parsed &&
    findCapabilityProviderById({
      providers: params.providers,
      providerId: parsed.provider,
      normalizeProviderId: params.normalizeProviderId,
    })
  ) {
    return parsed;
  }
  return resolveCapabilityProviderModelOnlyRef({ providers: params.providers, raw }) ?? parsed;
}
