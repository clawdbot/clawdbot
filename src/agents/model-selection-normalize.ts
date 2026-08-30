/**
 * Internal declaration anchor for parser and lookup exports consumed by the
 * public Plugin SDK barrel. Provider/model normalization lives in model-ref-shared.
 */
import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
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

/** Parse authored parts before provider policy can rewrite a literal model path. */
export function parseModelRefParts(raw: string, defaultProvider: string): ModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (normalizeLowercaseStringOrEmpty(trimmed) === OPENROUTER_AUTO_COMPAT_ALIAS) {
    return { provider: "openrouter", model: "auto" };
  }
  return trimmed.includes("/")
    ? parseProviderModelRef(trimmed)
    : { provider: defaultProvider, model: trimmed };
}

/** Parse `provider/model` or bare model text using a default provider. */
export function parseModelRef(
  raw: string,
  defaultProvider: string,
  options?: ModelRefNormalizeOptions,
): ModelRef | null {
  const ref = parseModelRefParts(raw, defaultProvider);
  return ref ? normalizeModelRef(ref.provider, ref.model, options) : null;
}
