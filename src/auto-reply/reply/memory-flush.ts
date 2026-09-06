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
import {
  resolveFreshSessionTotalTokens,
  resolveSessionTotalTokens,
  type SessionEntry,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/**
 * Safety factor applied to stale persisted token totals when they fall back to
 * the compaction gate. When neither a projected token count nor a fresh total
 * is available (e.g. during a provider outage where no recent usage landed),
 * the last persisted total is the only signal the gate has. Scaling it down
 * keeps the gate from going blind while remaining conservative — a stale
 * total tends to under-count a still-growing transcript, so the discount
 * biases toward the real-world ceiling rather than over-trusting a frozen
 * snapshot.
 */
const STALE_TOTAL_TOKENS_SAFETY_FACTOR = 0.8;

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

/** Resolves the blocking threshold using the selected reserve and server floor. */
export function resolveCompactionThreshold(params: {
  contextWindowTokens: number;
  reserveTokensFloor: number;
  minimumThresholdTokens?: number;
}): number {
  const contextWindow = Math.max(1, Math.floor(params.contextWindowTokens));
  const reserveTokens = Math.max(0, Math.floor(params.reserveTokensFloor));
  return Math.max(0, contextWindow - reserveTokens, Math.floor(params.minimumThresholdTokens ?? 0));
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

function resolveMaintenanceGateState<
  TEntry extends Pick<SessionEntry, "totalTokens" | "totalTokensFresh" | "totalTokensVersion">,
>(params: {
  entry?: TEntry;
  tokenCount?: number;
  threshold: number;
}): { entry: TEntry; totalTokens: number; threshold: number } | null {
  if (!params.entry) {
    return null;
  }

  const freshOrProjectedTotalTokens =
    resolvePositiveTokenCount(params.tokenCount) ?? resolveFreshSessionTotalTokens(params.entry);
  // Last-resort fallback: when no projected token count and no fresh total
  // are available (provider outage → usage stale), trust the persisted
  // stale total at a safety factor so the gate keeps its eyes instead of
  // going blind and silently skipping compaction (#138871). We reach this
  // branch only when resolveFreshSessionTotalTokens already returned
  // undefined, but we further require totalTokensFresh === false so that
  // *fresh-but-unversioned* legacy entries (totalTokensFresh === true with
  // no version) are still ignored — they are not stale. The 0.8 discount
  // biases toward the real-world ceiling of a still-growing transcript
  // rather than over-trusting a frozen snapshot; it also mitigates legacy
  // cumulative-CLI totals that historically over-count retries.
  const staleFallbackTotalTokens =
    params.entry.totalTokensFresh === false
      ? Math.floor(
          (resolveSessionTotalTokens(params.entry) ?? 0) * STALE_TOTAL_TOKENS_SAFETY_FACTOR,
        )
      : 0;
  const totalTokens = freshOrProjectedTotalTokens ?? staleFallbackTotalTokens;
  if (!totalTokens || totalTokens <= 0) {
    return null;
  }

  const threshold = params.threshold;
  return threshold > 0 ? { entry: params.entry, totalTokens, threshold } : null;
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
  threshold: number;
}): boolean {
  const state = resolveMaintenanceGateState(params);
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
  threshold: number;
}): boolean {
  const state = resolveMaintenanceGateState(params);
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
