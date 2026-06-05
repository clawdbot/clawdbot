/**
 * Normalizes provider/model references and configured model ids.
 */
import {
  findNormalizedProviderKey as findNormalizedProviderKeyCore,
  findNormalizedProviderValue as findNormalizedProviderValueCore,
  normalizeProviderId as normalizeProviderIdCore,
  normalizeProviderIdForAuth as normalizeProviderIdForAuthCore,
} from "@openclaw/model-catalog-core/provider-id";
import { stripSelfProviderModelPrefix } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { modelKey as sharedModelKey, normalizeStaticProviderModelId } from "./model-ref-shared.js";
import { normalizeProviderModelIdWithRuntime } from "./provider-model-normalization.runtime.js";

// Shared provider/model normalization facade for agent model selection. It
// combines catalog-core provider IDs, static aliases, and optional plugin hooks.
export type ModelRef = {
  provider: string;
  model: string;
};

export type ModelManifestNormalizationContext = {
  manifestPlugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
};

/** Build the canonical provider/model key for model selection. */
export function modelKey(provider: string, model: string) {
  return sharedModelKey(provider, model);
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

/** Normalize a provider ID using the shared catalog rules. */
export function normalizeProviderId(provider: string): string {
  return normalizeProviderIdCore(provider);
}

/** Normalize a provider ID for auth lookup. */
export function normalizeProviderIdForAuth(provider: string): string {
  return normalizeProviderIdForAuthCore(provider);
}

/** Find a provider value by normalized provider ID. */
export function findNormalizedProviderValue<T>(
  entries: Record<string, T> | undefined,
  provider: string,
): T | undefined {
  return findNormalizedProviderValueCore(entries, provider);
}

/** Find the original provider key matching a normalized provider ID. */
export function findNormalizedProviderKey(
  entries: Record<string, unknown> | undefined,
  provider: string,
): string | undefined {
  return findNormalizedProviderKeyCore(entries, provider);
}

function normalizeProviderModelId(
  provider: string,
  model: string,
  options?: ModelManifestNormalizationContext & {
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  },
): string {
  const providerModel = stripSelfProviderModelPrefix(provider, model);
  const staticModelId = normalizeStaticProviderModelId(provider, providerModel, {
    allowManifestNormalization: options?.allowManifestNormalization,
    manifestPlugins: options?.manifestPlugins,
  });
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

type ModelRefNormalizeOptions = ModelManifestNormalizationContext & {
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
};

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

type ParseModelRefOptions = ModelRefNormalizeOptions;
const OPENROUTER_AUTO_COMPAT_ALIAS = "openrouter:auto";

/** Parse `provider/model` or bare model text using a default provider. */
export function parseModelRef(
  raw: string,
  defaultProvider: string,
  options?: ParseModelRefOptions,
): ModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (normalizeLowercaseStringOrEmpty(trimmed) === OPENROUTER_AUTO_COMPAT_ALIAS) {
    return normalizeModelRef("openrouter", "auto", options);
  }
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    return normalizeModelRef(defaultProvider, trimmed, options);
  }
  const providerRaw = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  if (!providerRaw || !model) {
    return null;
  }
  return normalizeModelRef(providerRaw, model, options);
}
