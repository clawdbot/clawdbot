/**
 * Shared provider/model reference normalization for static catalogs,
 * allowlists, and display paths. Manifest policies are optional so tests can
 * isolate built-in normalization behavior.
 */
import type { ProviderModelRef as ModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import {
  findNormalizedProviderKey as findNormalizedProviderKeyCore,
  normalizeProviderId as normalizeProviderIdCore,
  normalizeProviderIdForAuth as normalizeProviderIdForAuthCore,
} from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeBuiltInProviderModelId,
  normalizeConfiguredProviderCatalogModelRef,
  normalizeStaticProviderModelIdWithPolicies,
  stripSelfProviderModelPrefix,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  resolveManifestModelIdNormalizationPolicies,
  type ManifestModelIdNormalizationSource,
} from "../plugins/manifest-model-id-normalization.js";
import { modelKey } from "../shared/model-key.js";
import { normalizeProviderModelIdWithRuntime } from "./provider-model-normalization.runtime.js";
export { modelKey } from "../shared/model-key.js";

export type { ProviderModelRef as ModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";

export type ModelManifestNormalizationContext = {
  manifestPlugins?: ManifestModelIdNormalizationSource;
};

export type ProviderModelIdNormalizationOptions = ModelManifestNormalizationContext & {
  allowManifestNormalization?: boolean;
};

/** Normalize a provider ID using the shared catalog rules. */
export function normalizeProviderId(provider: string): string {
  return normalizeProviderIdCore(provider);
}

/** Normalize a provider ID for auth lookup. */
export function normalizeProviderIdForAuth(provider: string): string {
  return normalizeProviderIdForAuthCore(provider);
}

/** Find the original provider key matching a normalized provider ID. */
export function findNormalizedProviderKey(
  entries: Record<string, unknown> | undefined,
  provider: string,
): string | undefined {
  return findNormalizedProviderKeyCore(entries, provider);
}

/** Normalize a static provider model ID with built-in and optional manifest policy. */
export function normalizeStaticProviderModelId(
  provider: string,
  model: string,
  options: ProviderModelIdNormalizationOptions = {},
): string {
  const normalizedProvider = normalizeProviderId(provider);
  if (options.allowManifestNormalization === false) {
    return normalizeBuiltInProviderModelId(normalizedProvider, model);
  }
  return normalizeStaticProviderModelIdWithPolicies(
    normalizedProvider,
    model,
    resolveManifestModelIdNormalizationPolicies({ plugins: options.manifestPlugins }),
  );
}

/**
 * Captures manifest policies once for repeated static model-id comparisons.
 * Lifecycle-prepared callers must not rediscover plugin metadata inside model loops.
 */
export function createStaticProviderModelIdNormalizer(
  options: ProviderModelIdNormalizationOptions = {},
): (provider: string, model: string) => string {
  if (options.allowManifestNormalization === false) {
    return (provider, model) =>
      normalizeBuiltInProviderModelId(normalizeProviderId(provider), model);
  }
  if (options.manifestPlugins) {
    const policies = resolveManifestModelIdNormalizationPolicies({
      plugins: options.manifestPlugins,
    });
    return (provider, model) =>
      normalizeStaticProviderModelIdWithPolicies(normalizeProviderId(provider), model, policies);
  }
  return (provider, model) => normalizeStaticProviderModelId(provider, model, options);
}

/** Normalize a configured catalog model ID for comparisons against provider catalogs. */
export function normalizeConfiguredProviderCatalogModelId(
  provider: string,
  model: string,
  options: ProviderModelIdNormalizationOptions = {},
): string {
  return normalizeConfiguredProviderCatalogModelRef(
    normalizeStaticProviderModelId(provider, model, options),
  );
}

/** Reuses one manifest-policy view across configured model rows in an operation. */
export function createConfiguredProviderCatalogModelIdNormalizer(
  options: ProviderModelIdNormalizationOptions = {},
): (provider: string, model: string) => string {
  let normalizeStatic: ReturnType<typeof createStaticProviderModelIdNormalizer> | undefined;
  return (provider, model) =>
    normalizeConfiguredProviderCatalogModelRef(
      // Empty operations never prepare policies; default scalar readers retain their current scope.
      (normalizeStatic ??= createStaticProviderModelIdNormalizer(options))(provider, model),
    );
}

type ModelRefNormalizeOptions = ModelManifestNormalizationContext & {
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
};

function normalizeProviderModelId(
  provider: string,
  model: string,
  options?: ModelRefNormalizeOptions,
): string {
  const providerModel = stripSelfProviderModelPrefix(provider, model);
  const staticModelId = normalizeStaticProviderModelId(provider, providerModel, options);
  if (options?.allowPluginNormalization === false) {
    return staticModelId;
  }
  return (
    normalizeProviderModelIdWithRuntime({
      provider,
      context: {
        provider,
        modelId: staticModelId,
      },
    }) ?? staticModelId
  );
}

/** Normalize a provider/model pair into a canonical model reference. */
export function normalizeModelRef(
  provider: string,
  model: string,
  options?: ModelRefNormalizeOptions,
): ModelRef {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedModel = normalizeProviderModelId(normalizedProvider, model.trim(), options);
  return { provider: normalizedProvider, model: normalizedModel };
}

/** Return the legacy raw key when it differs from the canonical key. */
export function legacyModelKey(provider: string, model: string): string | null {
  const providerId = provider.trim();
  const modelId = model.trim();
  if (!providerId || !modelId) {
    return null;
  }
  const rawKey = `${providerId}/${modelId}`;
  const canonicalKey = modelKey(providerId, modelId);
  return rawKey === canonicalKey ? null : rawKey;
}

function parseStaticModelRef(raw: string, defaultProvider: string): ModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  const providerRaw = slash === -1 ? defaultProvider : trimmed.slice(0, slash).trim();
  const modelRaw = slash === -1 ? trimmed : trimmed.slice(slash + 1).trim();
  if (!providerRaw || !modelRaw) {
    return null;
  }
  const provider = normalizeProviderId(providerRaw);
  return {
    provider,
    model: normalizeStaticProviderModelId(provider, modelRaw),
  };
}

/** Resolve an allowlist entry to a canonical provider/model key. */
export function resolveStaticAllowlistModelKey(
  raw: string,
  defaultProvider: string,
): string | null {
  const parsed = parseStaticModelRef(raw, defaultProvider);
  if (!parsed) {
    return null;
  }
  return modelKey(parsed.provider, parsed.model);
}

/** Preserve literal provider/model refs that already include a provider prefix twice. */
export function formatLiteralProviderPrefixedModelRef(provider: string, modelRef: string): string {
  const providerId = normalizeProviderId(provider);
  const trimmedRef = modelRef.trim();
  if (!providerId || !trimmedRef) {
    return trimmedRef;
  }
  const normalizedRef = normalizeLowercaseStringOrEmpty(trimmedRef);
  const literalPrefix = `${providerId}/${providerId}/`;
  if (normalizedRef.startsWith(literalPrefix)) {
    return trimmedRef;
  }
  return normalizedRef.startsWith(`${providerId}/`) ? `${providerId}/${trimmedRef}` : trimmedRef;
}
