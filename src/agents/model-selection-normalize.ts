/**
 * Internal declaration anchor for parser and lookup exports consumed by the
 * public Plugin SDK barrel. Provider/model normalization lives in model-ref-shared.
 */
import { findNormalizedProviderValue as findNormalizedProviderValueCore } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  type ModelManifestNormalizationContext,
  type ModelRef,
  normalizeModelRef,
} from "./model-ref-shared.js";

type ModelRefNormalizeOptions = ModelManifestNormalizationContext & {
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
};

const OPENROUTER_AUTO_COMPAT_ALIAS = "openrouter:auto";

/** Find a provider value by normalized provider ID. */
export function findNormalizedProviderValue<T>(
  entries: Record<string, T> | undefined,
  provider: string,
): T | undefined {
  return findNormalizedProviderValueCore(entries, provider);
}

/** Parse `provider/model` or bare model text using a default provider. */
export function parseModelRef(
  raw: string,
  defaultProvider: string,
  options?: ModelRefNormalizeOptions,
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
