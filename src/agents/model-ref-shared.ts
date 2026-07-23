/**
 * Shared provider/model reference normalization for static catalogs,
 * allowlists, and display paths. Manifest policies are optional so tests can
 * isolate built-in normalization behavior.
 */
import {
  findNormalizedProviderKey as findNormalizedProviderKeyCore,
  normalizeProviderId as normalizeProviderIdCore,
  normalizeProviderIdForAuth as normalizeProviderIdForAuthCore,
} from "@openclaw/model-catalog-core/provider-id";
import {
  collectManifestModelIdNormalizationPolicies,
  normalizeBuiltInProviderModelId,
  normalizeConfiguredProviderCatalogModelRef,
  normalizeConfiguredProviderCatalogModelId as normalizeConfiguredProviderCatalogModelIdShared,
  normalizeStaticProviderModelIdWithPolicies,
  stripSelfProviderModelPrefix,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeProviderModelIdWithManifest } from "../plugins/manifest-model-id-normalization.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { modelKey } from "../shared/model-key.js";
import { normalizeProviderModelIdWithRuntime } from "./provider-model-normalization.runtime.js";
export { modelKey } from "../shared/model-key.js";

export type ModelRef = {
  provider: string;
  model: string;
};

export type ModelManifestNormalizationContext = {
  manifestPlugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
};

export type ProviderModelIdNormalizationOptions = {
  allowManifestNormalization?: boolean;
  manifestPlugins?: readonly ManifestModelIdNormalizationRecord[];
};

type ManifestModelIdNormalizationProvider = {
  aliases?: Record<string, string>;
  stripPrefixes?: string[];
  prefixWhenBare?: string;
  prefixWhenBareAfterAliasStartsWith?: {
    modelPrefix: string;
    prefix: string;
  }[];
};

type ManifestModelIdNormalizationRecord = {
  modelIdNormalization?: {
    providers?: Record<string, ManifestModelIdNormalizationProvider>;
  };
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
  if (options.manifestPlugins) {
    return normalizeStaticProviderModelIdWithPolicies(
      normalizedProvider,
      model,
      collectManifestModelIdNormalizationPolicies(options.manifestPlugins),
    );
  }
  const manifestModelId =
    normalizeProviderModelIdWithManifest({
      provider: normalizedProvider,
      context: {
        provider: normalizedProvider,
        modelId: model,
      },
    }) ?? model;
  return normalizeBuiltInProviderModelId(normalizedProvider, manifestModelId);
}

/** Normalize a configured catalog model ID for comparisons against provider catalogs. */
export function normalizeConfiguredProviderCatalogModelId(
  provider: string,
  model: string,
  options: ProviderModelIdNormalizationOptions = {},
): string {
  if (options.allowManifestNormalization === false) {
    return normalizeConfiguredProviderCatalogModelIdShared(provider, model, new Map());
  }
  if (options.manifestPlugins) {
    return normalizeConfiguredProviderCatalogModelIdShared(
      provider,
      model,
      collectManifestModelIdNormalizationPolicies(options.manifestPlugins),
    );
  }
  return normalizeConfiguredProviderCatalogModelRef(
    normalizeStaticProviderModelId(provider, model, options),
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
      ...(options?.manifestPlugins ? { plugins: options.manifestPlugins } : {}),
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
