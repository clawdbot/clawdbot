import { normalizeOptionalString } from "../shared/string-coerce.js";

export type CapabilityModelProviderCandidate = {
  id: string;
  aliases?: readonly string[];
  defaultModel?: string | null;
  models?: readonly string[];
};

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
  if (!normalized) {
    return undefined;
  }
  return normalizeProviderId ? normalizeProviderId(normalized) : normalized;
}

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
    if (providerId === selectedProvider) {
      return true;
    }
    return (provider.aliases ?? []).some(
      (alias) => normalizeProviderForMatch(alias, params.normalizeProviderId) === selectedProvider,
    );
  });
}

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
