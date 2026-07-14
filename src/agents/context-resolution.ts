import { resolveClaudeSonnet5ModelIdentity } from "@openclaw/llm-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  lookupCachedContextTokens,
  lookupCachedContextWindow,
  minPositiveContextTokens,
  providerContextTokenCacheKey,
} from "./context-cache.js";
import { normalizeProviderId } from "./model-selection.js";

type ConfigModelEntry = { id?: string; contextWindow?: number; contextTokens?: number };
type ProviderConfigEntry = {
  contextWindow?: number;
  contextTokens?: number;
  models?: ConfigModelEntry[];
};
export type ModelsConfig = {
  providers?: Record<string, ProviderConfigEntry | undefined>;
};

export type ContextTokenResolutionParams = {
  cfg?: OpenClawConfig;
  sourceCfg?: OpenClawConfig | null;
  provider?: string;
  modelProvider?: string;
  model?: string;
  contextTokensOverride?: number;
  fallbackContextTokens?: number;
  modelContextWindow?: number;
  modelContextTokens?: number;
  allowAsyncLoad?: boolean;
  allowUnscopedModelLookup?: boolean;
};

const ANTHROPIC_GA_1M_MODEL_PREFIXES = [
  "claude-opus-4-8",
  "claude-opus-4.8",
  "claude-opus-4-6",
  "claude-opus-4.6",
  "claude-opus-4-7",
  "claude-opus-4.7",
  "claude-sonnet-4-6",
  "claude-sonnet-4.6",
] as const;
export const ANTHROPIC_CONTEXT_1M_TOKENS = 1_048_576;
export const ANTHROPIC_VERTEX_CONTEXT_1M_TOKENS = 1_000_000;
export const ANTHROPIC_FABLE_CONTEXT_TOKENS = 1_000_000;
export const ANTHROPIC_MYTHOS_5_CONTEXT_TOKENS = 1_000_000;
export const ANTHROPIC_SONNET_5_CONTEXT_TOKENS = 1_000_000;

type ConfiguredContextTokens = {
  value: number;
  source: "contextTokens" | "contextWindow";
};

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

function resolveConfiguredProviderContextTokens(
  cfg: OpenClawConfig | null | undefined,
  provider: string,
  model: string,
): ConfiguredContextTokens | undefined {
  const providers = (cfg?.models as ModelsConfig | undefined)?.providers;
  if (!providers) {
    return undefined;
  }

  function readProviderContextTokens(
    providerConfig: ProviderConfigEntry | undefined,
  ): ConfiguredContextTokens | undefined {
    if (typeof providerConfig?.contextTokens === "number" && providerConfig.contextTokens > 0) {
      return { value: providerConfig.contextTokens, source: "contextTokens" };
    }
    if (typeof providerConfig?.contextWindow === "number" && providerConfig.contextWindow > 0) {
      return { value: providerConfig.contextWindow, source: "contextWindow" };
    }
    return undefined;
  }

  function findContextTokens(
    matchProviderId: (id: string) => boolean,
  ): ConfiguredContextTokens | undefined {
    for (const [providerId, providerConfig] of Object.entries(providers!)) {
      if (!matchProviderId(providerId)) {
        continue;
      }
      if (Array.isArray(providerConfig?.models)) {
        for (const entry of providerConfig.models) {
          const entryId = typeof entry?.id === "string" ? entry.id : "";
          const slash = entryId.indexOf("/");
          const prefixedProvider = slash > 0 ? normalizeProviderId(entryId.slice(0, slash)) : "";
          const bareEntryId = slash > 0 ? entryId.slice(slash + 1).trim() : "";
          const modelMatches =
            entryId === model ||
            (prefixedProvider === normalizeProviderId(providerId) && bareEntryId === model);
          if (modelMatches && typeof entry.contextTokens === "number" && entry.contextTokens > 0) {
            return { value: entry.contextTokens, source: "contextTokens" };
          }
          if (modelMatches && typeof entry.contextWindow === "number" && entry.contextWindow > 0) {
            return { value: entry.contextWindow, source: "contextWindow" };
          }
        }
      }
      const providerContextTokens = readProviderContextTokens(providerConfig);
      if (providerContextTokens) {
        return providerContextTokens;
      }
    }
    return undefined;
  }

  // Match exact config keys before normalized aliases so one provider cannot
  // inherit another provider's context cap based on object iteration order.
  const exactResult = findContextTokens(
    (id) => normalizeLowercaseStringOrEmpty(id) === normalizeLowercaseStringOrEmpty(provider),
  );
  if (exactResult !== undefined) {
    return exactResult;
  }
  const normalizedProvider = normalizeProviderId(provider);
  return findContextTokens((id) => normalizeProviderId(id) === normalizedProvider);
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

function resolveConfiguredRuntimeContextTokens(
  cfg: OpenClawConfig | null | undefined,
  provider: string,
  modelProvider: string | undefined,
  model: string,
): ConfiguredContextTokens | undefined {
  const explicitResult = resolveConfiguredProviderContextTokens(cfg, provider, model);
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
  const canonicalResult = resolveConfiguredProviderContextTokens(cfg, canonicalProvider, model);
  if (canonicalResult) {
    return canonicalResult;
  }
  const canonicalModel = resolveProviderQualifiedModel(canonicalProvider, model);
  return canonicalModel
    ? resolveConfiguredProviderContextTokens(cfg, canonicalProvider, canonicalModel)
    : undefined;
}

function resolveModelFamilyId(modelId: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return normalized.includes("/") ? (normalized.split("/").at(-1) ?? normalized) : normalized;
}

export function resolveAnthropicFixedContextWindow(
  provider: string,
  model: string,
): number | undefined {
  const modelId = resolveModelFamilyId(model);
  const isAnthropicProvider =
    provider === "anthropic" || provider === "anthropic-vertex" || provider === "claude-cli";
  if (!isAnthropicProvider) {
    return undefined;
  }
  if (
    (provider === "anthropic" || provider === "anthropic-vertex") &&
    /^claude-fable-5(?=$|[^a-z0-9])/.test(modelId)
  ) {
    return ANTHROPIC_FABLE_CONTEXT_TOKENS;
  }
  if (
    (provider === "anthropic" || provider === "anthropic-vertex") &&
    /^claude-mythos-5(?=$|[^a-z0-9])/.test(modelId)
  ) {
    return ANTHROPIC_MYTHOS_5_CONTEXT_TOKENS;
  }
  if (resolveClaudeSonnet5ModelIdentity({ id: modelId })) {
    return ANTHROPIC_SONNET_5_CONTEXT_TOKENS;
  }
  if (!ANTHROPIC_GA_1M_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix))) {
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
  const override =
    typeof params.contextTokensOverride === "number" && params.contextTokensOverride > 0
      ? params.contextTokensOverride
      : undefined;
  const capOverride = (contextTokens: number) =>
    override !== undefined ? Math.min(override, contextTokens) : contextTokens;
  const explicitProvider = params.provider?.trim();

  if (ref && explicitProvider) {
    const configuredWindow = resolveConfiguredRuntimeContextTokens(
      params.cfg,
      explicitProvider,
      params.modelProvider,
      ref.model,
    );
    const sourceConfig = params.sourceCfg === undefined ? params.cfg : params.sourceCfg;
    const sourceConfiguredWindow = resolveConfiguredRuntimeContextTokens(
      sourceConfig,
      explicitProvider,
      params.modelProvider,
      ref.model,
    );
    const fixedContextWindow = resolveAnthropicFixedContextWindow(ref.provider, ref.model);
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
    const runtimeCap = minPositiveContextTokens(
      providerResult,
      modelContextTokens,
      fixedContextWindow === undefined ? providerWindow : undefined,
      fixedContextWindow === undefined ? modelContextWindow : undefined,
    );
    if (configuredWindow) {
      if (configuredWindow.source === "contextTokens") {
        const effectiveCap =
          fixedContextWindow === undefined
            ? configuredWindow.value
            : Math.min(configuredWindow.value, fixedContextWindow);
        return capOverride(effectiveCap);
      }
      const authoredContextWindow =
        sourceConfiguredWindow?.source === "contextWindow"
          ? sourceConfiguredWindow.value
          : undefined;
      // Runtime config fills omitted contextWindow values with 200k. Only an
      // authored window may lower a fixed provider contract; contextTokens is
      // always an explicit effective-cap override above.
      if (fixedContextWindow !== undefined && authoredContextWindow === undefined) {
        const effectiveCap =
          runtimeCap === undefined ? fixedContextWindow : Math.min(runtimeCap, fixedContextWindow);
        return capOverride(effectiveCap);
      }
      if (fixedContextWindow !== undefined) {
        const effectiveCap = minPositiveContextTokens(
          authoredContextWindow,
          fixedContextWindow,
          runtimeCap,
        );
        return effectiveCap === undefined ? undefined : capOverride(effectiveCap);
      }
      if (runtimeCap !== undefined) {
        return capOverride(Math.min(configuredWindow.value, runtimeCap));
      }
      return capOverride(configuredWindow.value);
    }
    if (runtimeCap !== undefined) {
      const effectiveCap =
        fixedContextWindow === undefined ? runtimeCap : Math.min(runtimeCap, fixedContextWindow);
      return capOverride(effectiveCap);
    }
    if (fixedContextWindow !== undefined) {
      return capOverride(fixedContextWindow);
    }
  }

  if (params.allowUnscopedModelLookup === false) {
    return override ?? params.fallbackContextTokens;
  }

  // Model-only calls use the raw discovery key. With an explicit provider,
  // slash-containing raw keys lack ownership provenance and cannot lower an override.
  const bareResult = lookupContextTokens(params.model);
  const bareWindow = lookupContextWindow(params.model);
  const bareCap = minPositiveContextTokens(bareResult, bareWindow);
  if (bareCap !== undefined) {
    const ambiguousSlashId = Boolean(explicitProvider && ref?.model.includes("/"));
    return ambiguousSlashId && override !== undefined ? override : capOverride(bareCap);
  }

  return override ?? params.fallbackContextTokens;
}
