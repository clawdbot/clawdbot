import { resolveThinkingDefaultForModel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { legacyModelKey, modelKey, normalizeProviderId } from "./model-selection-normalize.js";
import { normalizeModelSelection } from "./model-selection-resolve.js";

type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";

export function resolveThinkingDefault(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  catalog?: ModelCatalogEntry[];
}): ThinkLevel {
  const normalizedProvider = normalizeProviderId(params.provider);
  const normalizedModel = normalizeLowercaseStringOrEmpty(params.model).replace(/\./g, "-");
  const catalogCandidate = Array.isArray(params.catalog)
    ? params.catalog.find(
        (entry) => entry.provider === params.provider && entry.id === params.model,
      )
    : undefined;
  const configuredModels = params.cfg.agents?.defaults?.models;
  const canonicalKey = modelKey(params.provider, params.model);
  const legacyKey = legacyModelKey(params.provider, params.model);
  const normalizedCanonicalKey = normalizeLowercaseStringOrEmpty(canonicalKey);
  const normalizedLegacyKey = normalizeOptionalLowercaseString(legacyKey);
  const primarySelection = normalizeModelSelection(params.cfg.agents?.defaults?.model);
  const normalizedPrimarySelection = normalizeOptionalLowercaseString(primarySelection);
  const explicitModelConfigured =
    (configuredModels ? canonicalKey in configuredModels : false) ||
    Boolean(legacyKey && configuredModels && legacyKey in configuredModels) ||
    normalizedPrimarySelection === normalizedCanonicalKey ||
    Boolean(normalizedLegacyKey && normalizedPrimarySelection === normalizedLegacyKey) ||
    normalizedPrimarySelection === normalizeLowercaseStringOrEmpty(params.model);
  const perModelThinking =
    configuredModels?.[canonicalKey]?.params?.thinking ??
    (legacyKey ? configuredModels?.[legacyKey]?.params?.thinking : undefined);
  if (
    perModelThinking === "off" ||
    perModelThinking === "minimal" ||
    perModelThinking === "low" ||
    perModelThinking === "medium" ||
    perModelThinking === "high" ||
    perModelThinking === "xhigh" ||
    perModelThinking === "adaptive" ||
    perModelThinking === "max"
  ) {
    return perModelThinking;
  }
  const configured = params.cfg.agents?.defaults?.thinkingDefault;
  if (configured) {
    return configured;
  }
  if (
    normalizedProvider === "anthropic" &&
    (normalizedModel.startsWith("claude-opus-4-7") || normalizedModel.startsWith("claude-opus-4.7"))
  ) {
    return "off";
  }
  if (
    normalizedProvider === "anthropic" &&
    explicitModelConfigured &&
    typeof catalogCandidate?.name === "string" &&
    /4\.6\b/.test(catalogCandidate.name) &&
    (normalizedModel.startsWith("claude-opus-4-6") ||
      normalizedModel.startsWith("claude-sonnet-4-6"))
  ) {
    return "adaptive";
  }
  return resolveThinkingDefaultForModel({
    provider: params.provider,
    model: params.model,
    catalog: params.catalog,
  });
}
