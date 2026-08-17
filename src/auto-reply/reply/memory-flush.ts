// Builds memory flush prompts when conversation context exceeds model budget.
import { resolveAnthropicServerCompactionPlan } from "@openclaw/ai/internal/anthropic";
import { resolveOpenAIResponsesServerCompactionPlan } from "@openclaw/ai/internal/openai-responses-payload-policy";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveModelExtraParamSources } from "../../agents/model-extra-params.js";
import { normalizeStaticProviderModelId } from "../../agents/model-ref-shared.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { parseNonNegativeByteSize } from "../../config/byte-size.js";
import {
  resolveMergedModelProviderConfig,
  resolveMergedModelProviderModels,
} from "../../config/model-provider-config.js";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function resolveMemoryFlushContextWindowTokens(params: {
  modelId?: string;
  cfg?: OpenClawConfig;
  provider?: string;
}): number {
  return (
    resolveContextTokensForModel({
      cfg: params.cfg,
      provider: params.provider,
      model: params.modelId,
      allowAsyncLoad: false,
    }) ?? DEFAULT_CONTEXT_TOKENS
  );
}

export function resolveMaxActiveTranscriptBytes(cfg?: OpenClawConfig): number | undefined {
  const parsed = parseNonNegativeByteSize(
    cfg?.agents?.defaults?.compaction?.maxActiveTranscriptBytes,
  );
  return typeof parsed === "number" && parsed > 0 ? parsed : undefined;
}

function resolvePositiveTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function resolveResponsesServerCompactionThreshold(params: {
  cfg?: OpenClawConfig;
  provider?: string;
  modelId?: string;
}): number | undefined {
  const provider = params.provider?.trim();
  const modelId = params.modelId?.trim();
  if (!provider || !modelId) {
    return undefined;
  }
  const normalizedProvider = normalizeProviderId(provider);
  const normalizeModelId = (value: string) =>
    normalizeStaticProviderModelId(normalizedProvider, value).trim().toLowerCase();
  const providerConfig = resolveMergedModelProviderConfig(params.cfg, provider);
  const configuredModel = resolveMergedModelProviderModels({
    models: providerConfig?.models,
    normalizeModelId,
  }).get(normalizeModelId(modelId));
  const { defaultParams, modelParams } = resolveModelExtraParamSources({
    config: params.cfg,
    provider,
    modelId,
  });
  const extraParams = { ...defaultParams, ...modelParams };
  if (normalizedProvider === "anthropic") {
    return resolveAnthropicServerCompactionPlan(
      {
        provider,
        api: configuredModel?.api ?? providerConfig?.api ?? "anthropic-messages",
        baseUrl: configuredModel?.baseUrl ?? providerConfig?.baseUrl,
        contextWindow:
          configuredModel?.contextWindow ??
          resolveMemoryFlushContextWindowTokens({ cfg: params.cfg, provider, modelId }),
      },
      extraParams,
    ).threshold;
  }
  const defaultOpenAIBaseUrl =
    normalizedProvider === "openai" ? "https://api.openai.com/v1" : undefined;
  const activeContextTokens = resolveMemoryFlushContextWindowTokens({
    cfg: params.cfg,
    provider,
    modelId,
  });
  return resolveOpenAIResponsesServerCompactionPlan(
    {
      provider,
      api:
        configuredModel?.api ??
        providerConfig?.api ??
        (normalizedProvider === "openai" ? "openai-responses" : undefined),
      baseUrl: configuredModel?.baseUrl ?? providerConfig?.baseUrl ?? defaultOpenAIBaseUrl,
      compat: configuredModel?.compat,
      contextTokens: configuredModel?.contextTokens ?? activeContextTokens,
      contextWindow: configuredModel?.contextWindow ?? activeContextTokens,
    },
    extraParams,
  ).threshold;
}

function resolveMemoryFlushGateState<
  TEntry extends Pick<SessionEntry, "totalTokens" | "totalTokensFresh" | "totalTokensVersion">,
>(params: {
  entry?: TEntry;
  tokenCount?: number;
  contextWindowTokens: number;
  reserveTokensFloor: number;
  softThresholdTokens: number;
  minimumThresholdTokens?: number;
}): { entry: TEntry; totalTokens: number; threshold: number } | null {
  if (!params.entry) {
    return null;
  }

  const totalTokens =
    resolvePositiveTokenCount(params.tokenCount) ?? resolveFreshSessionTotalTokens(params.entry);
  if (!totalTokens || totalTokens <= 0) {
    return null;
  }

  const contextWindow = Math.max(1, Math.floor(params.contextWindowTokens));
  const reserveTokens = Math.max(0, Math.floor(params.reserveTokensFloor));
  const softThreshold = Math.max(0, Math.floor(params.softThresholdTokens));
  const threshold = Math.max(
    0,
    contextWindow - reserveTokens - softThreshold,
    Math.floor(params.minimumThresholdTokens ?? 0),
  );
  if (threshold <= 0) {
    return null;
  }

  return { entry: params.entry, totalTokens, threshold };
}

export function shouldRunMemoryFlush(params: {
  entry?: Pick<
    SessionEntry,
    "totalTokens" | "totalTokensFresh" | "totalTokensVersion" | "compactionCount" | "memoryFlush"
  >;
  /**
   * Optional token count override for flush gating. When provided, this value is
   * treated as a fresh context snapshot and used instead of the cached
   * SessionEntry.totalTokens (which may be stale/unknown).
   */
  tokenCount?: number;
  contextWindowTokens: number;
  reserveTokensFloor: number;
  softThresholdTokens: number;
}): boolean {
  const state = resolveMemoryFlushGateState(params);
  if (!state || state.totalTokens < state.threshold) {
    return false;
  }

  if (hasAlreadyFlushedForCurrentCompaction(state.entry)) {
    return false;
  }

  return true;
}

export function shouldRunPreflightCompaction(params: {
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh" | "totalTokensVersion">;
  /**
   * Optional projected token count override for pre-run compaction gating.
   * When provided, this value is treated as a fresh estimate and used instead
   * of any cached SessionEntry total.
   */
  tokenCount?: number;
  contextWindowTokens: number;
  reserveTokensFloor: number;
  softThresholdTokens: number;
  minimumThresholdTokens?: number;
}): boolean {
  const state = resolveMemoryFlushGateState(params);
  return Boolean(state && state.totalTokens >= state.threshold);
}

/**
 * Returns true when a memory flush has already been performed for the current
 * compaction cycle. This prevents repeated flush runs within the same cycle —
 * important for both the token-based and transcript-size–based trigger paths.
 */
export function hasAlreadyFlushedForCurrentCompaction(
  entry: Pick<SessionEntry, "compactionCount" | "memoryFlush">,
): boolean {
  const compactionCount = entry.compactionCount ?? 0;
  const lastFlushAt = entry.memoryFlush?.compactionCount;
  return typeof lastFlushAt === "number" && lastFlushAt === compactionCount;
}
