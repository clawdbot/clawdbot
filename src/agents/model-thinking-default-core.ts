import { resolveClaudeOpus5ModelIdentity } from "@openclaw/llm-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import {
  resolveSupportedThinkingLevel,
  resolveThinkingDefaultForModel,
  resolveThinkingProfile,
} from "../auto-reply/thinking.js";
import {
  resolveThinkingDefaultForModelCore,
  type ThinkLevel,
} from "../auto-reply/thinking.shared.js";
import { resolveAgentModelConfigEntry } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderThinkingPolicySource } from "../plugins/provider-thinking.types.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { normalizeProviderId } from "./model-ref-shared.js";
import { normalizeModelSelection } from "./model-selection-resolve.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";

type ThinkingDefaultParams = {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  catalog?: ModelCatalogEntry[];
  agentRuntime?: string | null;
};

export function resolveConfiguredThinkingDefaultCore(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): ThinkLevel | undefined {
  const { entry } = resolveAgentModelConfigEntry({
    models: params.cfg.agents?.defaults?.models,
    provider: params.provider,
    model: params.model,
  });
  const perModelThinking = entry?.params?.thinking;
  if (
    perModelThinking === false ||
    perModelThinking === "disabled" ||
    perModelThinking === "none"
  ) {
    return "off";
  }
  if (
    perModelThinking === "off" ||
    perModelThinking === "minimal" ||
    perModelThinking === "low" ||
    perModelThinking === "medium" ||
    perModelThinking === "high" ||
    perModelThinking === "xhigh" ||
    perModelThinking === "adaptive" ||
    perModelThinking === "max" ||
    perModelThinking === "ultra"
  ) {
    return perModelThinking;
  }
  return params.cfg.agents?.defaults?.thinkingDefault;
}

export function resolveThinkingDefaultCore(
  params: ThinkingDefaultParams & {
    providerPolicySource?: ProviderThinkingPolicySource;
  },
): ThinkLevel {
  const normalizedProvider = normalizeProviderId(params.provider);
  const normalizedModel = normalizeLowercaseStringOrEmpty(params.model).replace(/\./g, "-");
  const catalog = Array.isArray(params.catalog)
    ? params.catalog
    : buildConfiguredModelCatalog({ cfg: params.cfg });
  const catalogCandidate = catalog.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  const { key, equivalentKey, entry } = resolveAgentModelConfigEntry({
    models: params.cfg.agents?.defaults?.models,
    provider: params.provider,
    model: params.model,
  });
  const normalizedCanonicalKey = normalizeLowercaseStringOrEmpty(key);
  const normalizedEquivalentKey = normalizeOptionalLowercaseString(equivalentKey);
  const primarySelection = normalizeModelSelection(params.cfg.agents?.defaults?.model);
  const normalizedPrimarySelection = normalizeOptionalLowercaseString(primarySelection);
  const explicitModelConfigured =
    Boolean(entry) ||
    normalizedPrimarySelection === normalizedCanonicalKey ||
    Boolean(normalizedEquivalentKey && normalizedPrimarySelection === normalizedEquivalentKey) ||
    normalizedPrimarySelection === normalizeLowercaseStringOrEmpty(params.model);
  const configured = resolveConfiguredThinkingDefaultCore(params);
  if (configured) {
    return configured;
  }
  const isClaudeProvider =
    normalizedProvider === "anthropic" ||
    normalizedProvider === "anthropic-vertex" ||
    normalizedProvider === "claude-cli";
  if (isClaudeProvider && resolveClaudeOpus5ModelIdentity({ id: normalizedModel })) {
    return "high";
  }
  if (
    isClaudeProvider &&
    (normalizedModel.startsWith("claude-opus-4-8") || normalizedModel.startsWith("claude-opus-4.8"))
  ) {
    return "off";
  }
  if (
    isClaudeProvider &&
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
  const fallbackParams = {
    provider: params.provider,
    model: params.model,
    catalog,
    agentRuntime: params.agentRuntime,
  };
  if (!params.providerPolicySource) {
    return resolveThinkingDefaultForModel(fallbackParams);
  }
  const profile = resolveThinkingProfile({
    ...fallbackParams,
    providerPolicySource: params.providerPolicySource,
  });
  if (profile.defaultLevel) {
    return profile.defaultLevel;
  }
  const fallback = resolveThinkingDefaultForModelCore(fallbackParams);
  if (fallback === "off") {
    return "off";
  }
  return resolveSupportedThinkingLevel({
    ...fallbackParams,
    level: "medium",
    providerPolicySource: params.providerPolicySource,
  });
}
