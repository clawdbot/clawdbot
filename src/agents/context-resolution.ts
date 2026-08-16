import {
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  supportsClaude1MContext,
} from "@openclaw/llm-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  lookupCachedContextTokens,
  lookupCachedContextWindow,
  minPositiveContextTokens,
  providerContextTokenCacheKey,
} from "./context-cache.js";
import { resolveModelExtraParamSources } from "./model-extra-params.js";
import { normalizeProviderId } from "./model-selection.js";

type ConfigModelEntry = { id?: string; contextWindow?: number; contextTokens?: number };
type ProviderConfigEntry = {
  models?: ConfigModelEntry[];
};
export type ModelsConfig = {
  providers?: Record<string, ProviderConfigEntry | undefined>;
};

export type ContextTokenResolutionParams = {
  cfg?: OpenClawConfig;
  provider?: string;
  modelProvider?: string;
  model?: string;
  fallbackContextTokens?: number;
  modelContextWindow?: number;
  modelContextTokens?: number;
  allowAsyncLoad?: boolean;
  allowUnscopedModelLookup?: boolean;
};

export const ANTHROPIC_CONTEXT_1M_TOKENS = 1_000_000;
export const ANTHROPIC_VERTEX_CONTEXT_1M_TOKENS = 1_000_000;
export const ANTHROPIC_FABLE_CONTEXT_TOKENS = 1_000_000;
export const ANTHROPIC_MYTHOS_5_CONTEXT_TOKENS = 1_000_000;
export const ANTHROPIC_OPUS_5_CONTEXT_TOKENS = 1_000_000;
export const ANTHROPIC_SONNET_5_CONTEXT_TOKENS = 1_000_000;

function resolveProviderModelRef(params: {
  provider?: string;
  model?: string;
}): { provider: string; model: string } | undefined {
  const modelRaw = params.model?.trim();
  if (!modelRaw) {
    return undefined;
  }
  const providerRaw = params.provider?.trim();
  if (providerRaw) {
    const provider = normalizeProviderId(providerRaw);
    return provider ? { provider, model: modelRaw } : undefined;
  }
  const slash = modelRaw.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const provider = normalizeProviderId(modelRaw.slice(0, slash));
  const model = modelRaw.slice(slash + 1).trim();
  return provider && model ? { provider, model } : undefined;
}

function resolveConfiguredProviderModel(
  cfg: OpenClawConfig | null | undefined,
  provider: string,
  model: string,
): ConfigModelEntry | undefined {
  const providers = (cfg?.models as ModelsConfig | undefined)?.providers;
  const requestedProvider = provider.trim();
  const normalizedProvider = normalizeProviderId(provider);
  const providerEntries = Object.entries(providers ?? {});
  const providerConfig =
    providerEntries.find(([providerId]) => providerId.trim() === requestedProvider)?.[1] ??
    providerEntries.find(
      ([providerId]) => normalizeProviderId(providerId) === normalizedProvider,
    )?.[1];
  return providerConfig?.models?.find((entry) => {
    const entryId = entry.id?.trim();
    if (!entryId) {
      return false;
    }
    if (entryId === model) {
      return true;
    }
    const slash = entryId.indexOf("/");
    return (
      slash > 0 &&
      normalizeProviderId(entryId.slice(0, slash)) === normalizedProvider &&
      entryId.slice(slash + 1).trim() === model
    );
  });
}

function resolveProviderQualifiedModel(provider: string, model: string): string | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const prefixedProvider = normalizeProviderId(model.slice(0, slash));
  const bareModel = model.slice(slash + 1).trim();
  return prefixedProvider === normalizeProviderId(provider) && bareModel ? bareModel : undefined;
}

function resolveConfiguredRuntimeModel(
  cfg: OpenClawConfig | null | undefined,
  provider: string,
  modelProvider: string | undefined,
  model: string,
): ConfigModelEntry | undefined {
  const explicitResult = resolveConfiguredProviderModel(cfg, provider, model);
  if (explicitResult) {
    return explicitResult;
  }
  const canonicalProvider = modelProvider?.trim();
  if (
    !canonicalProvider ||
    normalizeProviderId(canonicalProvider) === normalizeProviderId(provider)
  ) {
    return undefined;
  }
  const canonicalResult = resolveConfiguredProviderModel(cfg, canonicalProvider, model);
  if (canonicalResult) {
    return canonicalResult;
  }
  const canonicalModel = resolveProviderQualifiedModel(canonicalProvider, model);
  return canonicalModel
    ? resolveConfiguredProviderModel(cfg, canonicalProvider, canonicalModel)
    : undefined;
}

function resolveModelFamilyId(modelId: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return normalized.includes("/") ? (normalized.split("/").at(-1) ?? normalized) : normalized;
}

export function resolveAnthropicFixedContextWindow(
  provider: string,
  model: string,
  options?: { claudeCli1M?: boolean },
): number | undefined {
  const modelId = resolveModelFamilyId(model);
  const isAnthropicProvider =
    provider === "anthropic" || provider === "anthropic-vertex" || provider === "claude-cli";
  if (!isAnthropicProvider) {
    return undefined;
  }
  if (/^claude-fable-5(?=$|[^a-z0-9])/.test(modelId)) {
    return ANTHROPIC_FABLE_CONTEXT_TOKENS;
  }
  // Mythos 5 is direct-API only; Claude CLI must keep its discovered or fallback window.
  if (
    (provider === "anthropic" || provider === "anthropic-vertex") &&
    /^claude-mythos-5(?=$|[^a-z0-9])/.test(modelId)
  ) {
    return ANTHROPIC_MYTHOS_5_CONTEXT_TOKENS;
  }
  // Opus 5 is natively 1M on every runtime, including Claude CLI. Keep this
  // ahead of the legacy CLI opt-in gate used by older 1M variants below.
  if (resolveClaudeOpus5ModelIdentity({ id: modelId })) {
    return ANTHROPIC_OPUS_5_CONTEXT_TOKENS;
  }
  if (resolveClaudeSonnet5ModelIdentity({ id: modelId })) {
    return ANTHROPIC_SONNET_5_CONTEXT_TOKENS;
  }
  if (!supportsClaude1MContext({ id: modelId })) {
    return undefined;
  }
  if (provider === "claude-cli" && !modelId.endsWith("[1m]") && options?.claudeCli1M !== true) {
    return undefined;
  }
  return provider === "anthropic-vertex"
    ? ANTHROPIC_VERTEX_CONTEXT_1M_TOKENS
    : ANTHROPIC_CONTEXT_1M_TOKENS;
}

export function resolveContextTokensForModelFromCache(
  params: ContextTokenResolutionParams,
  lookupContextTokens: (modelId?: string) => number | undefined = lookupCachedContextTokens,
  lookupContextWindow: (modelId?: string) => number | undefined = lookupCachedContextWindow,
): number | undefined {
  const ref = resolveProviderModelRef(params);
  const explicitProvider = params.provider?.trim();

  if (ref && explicitProvider) {
    const configuredModel = resolveConfiguredRuntimeModel(
      params.cfg,
      explicitProvider,
      params.modelProvider,
      ref.model,
    );
    const extraParamSources = resolveModelExtraParamSources({
      config: params.cfg,
      provider: ref.provider,
      modelId: ref.model,
    });
    const effectiveContext1M =
      extraParamSources.modelParams && Object.hasOwn(extraParamSources.modelParams, "context1m")
        ? extraParamSources.modelParams.context1m
        : extraParamSources.defaultParams?.context1m;
    const fixedContextWindow = resolveAnthropicFixedContextWindow(ref.provider, ref.model, {
      claudeCli1M: effectiveContext1M === true,
    });
    const configuredContextTokens =
      typeof configuredModel?.contextTokens === "number" && configuredModel.contextTokens > 0
        ? configuredModel.contextTokens
        : undefined;
    if (configuredContextTokens !== undefined) {
      return fixedContextWindow === undefined
        ? configuredContextTokens
        : Math.min(configuredContextTokens, fixedContextWindow);
    }
    if (fixedContextWindow !== undefined) {
      return fixedContextWindow;
    }
    const providerResult = lookupContextTokens(
      providerContextTokenCacheKey(normalizeProviderId(ref.provider), ref.model),
    );
    const providerWindow = lookupContextWindow(
      providerContextTokenCacheKey(normalizeProviderId(ref.provider), ref.model),
    );
    const modelContextTokens =
      typeof params.modelContextTokens === "number" && params.modelContextTokens > 0
        ? params.modelContextTokens
        : undefined;
    const modelContextWindow =
      typeof params.modelContextWindow === "number" && params.modelContextWindow > 0
        ? params.modelContextWindow
        : undefined;
    const discoveredCap = minPositiveContextTokens(
      providerResult,
      modelContextTokens,
      providerWindow,
      modelContextWindow,
    );
    const configuredContextWindow =
      typeof configuredModel?.contextWindow === "number" && configuredModel.contextWindow > 0
        ? configuredModel.contextWindow
        : undefined;
    if (discoveredCap !== undefined) {
      return configuredContextWindow === undefined
        ? discoveredCap
        : Math.min(discoveredCap, configuredContextWindow);
    }
    if (configuredContextWindow !== undefined) {
      return configuredContextWindow;
    }
  }

  if (params.allowUnscopedModelLookup === false) {
    return params.fallbackContextTokens;
  }

  // Model-only calls use the raw discovery key.
  const bareResult = lookupContextTokens(params.model);
  const bareWindow = lookupContextWindow(params.model);
  const bareCap = minPositiveContextTokens(bareResult, bareWindow);
  if (bareCap !== undefined) {
    return bareCap;
  }

  return params.fallbackContextTokens;
}
