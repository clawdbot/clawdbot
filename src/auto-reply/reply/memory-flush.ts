import { COMPACTION_CONTEXT_USAGE_RATIO } from "../../agents/agent-compaction-constants.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { legacyModelKey, modelKey } from "../../agents/model-ref-shared.js";
import { parseNonNegativeByteSize } from "../../config/byte-size.js";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export { COMPACTION_CONTEXT_USAGE_RATIO };

export function resolveMemoryFlushContextWindowTokens(params: {
  modelId?: string;
  agentCfgContextTokens?: number;
  cfg?: OpenClawConfig;
  provider?: string;
}): number {
  return (
    resolveContextTokensForModel({
      cfg: params.cfg,
      provider: params.provider,
      model: params.modelId,
      contextTokensOverride: params.agentCfgContextTokens,
      allowAsyncLoad: false,
    }) ?? DEFAULT_CONTEXT_TOKENS
  );
}

export function resolveMaxActiveTranscriptBytes(cfg?: OpenClawConfig): number | undefined {
  const compaction = cfg?.agents?.defaults?.compaction;
  if (compaction?.truncateAfterCompaction !== true) {
    return undefined;
  }
  const parsed = parseNonNegativeByteSize(compaction.maxActiveTranscriptBytes);
  return typeof parsed === "number" && parsed > 0 ? parsed : undefined;
}

function resolvePositiveTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveBooleanParam(sources: Array<Record<string, unknown> | undefined>, key: string) {
  for (const source of sources.toReversed()) {
    const value = source?.[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function resolvePositiveIntegerParam(
  sources: Array<Record<string, unknown> | undefined>,
  key: string,
): number | undefined {
  for (const source of sources.toReversed()) {
    const value = source?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return undefined;
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
  const legacyKey = legacyModelKey(provider, modelId);
  const providerConfig = params.cfg?.models?.providers?.[provider];
  const modelConfig =
    params.cfg?.agents?.defaults?.models?.[modelKey(provider, modelId)] ??
    (legacyKey ? params.cfg?.agents?.defaults?.models?.[legacyKey] : undefined);
  const providerModelConfig = providerConfig?.models?.find((entry) => entry.id === modelId);
  const sources = [
    asRecord(providerConfig?.params),
    asRecord(providerModelConfig?.params),
    asRecord(params.cfg?.agents?.defaults?.params),
    asRecord(modelConfig?.params),
  ];
  const serverCompaction = resolveBooleanParam(sources, "responsesServerCompaction");
  const serverCompactionEnabled =
    provider === "openai" ? serverCompaction !== false : serverCompaction === true;
  if (!serverCompactionEnabled) {
    return undefined;
  }
  return resolvePositiveIntegerParam(sources, "responsesCompactThreshold");
}

/** Preflight/threshold compaction fires once projected usage reaches this share of the window. */

function resolveMemoryFlushGateState<
  TEntry extends Pick<SessionEntry, "totalTokens" | "totalTokensFresh">,
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

/** Token threshold for preflight compaction (~85% of the model context window). */
export function resolvePreflightCompactionThreshold(params: {
  contextWindowTokens: number;
  minimumThresholdTokens?: number;
}): number {
  const contextWindow = Math.max(1, Math.floor(params.contextWindowTokens));
  return Math.max(
    Math.floor(contextWindow * COMPACTION_CONTEXT_USAGE_RATIO),
    Math.floor(params.minimumThresholdTokens ?? 0),
  );
}

export function shouldRunMemoryFlush(params: {
  entry?: Pick<
    SessionEntry,
    "totalTokens" | "totalTokensFresh" | "compactionCount" | "memoryFlushCompactionCount"
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
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh">;
  /**
   * Optional projected token count override for pre-run compaction gating.
   * When provided, this value is treated as a fresh estimate and used instead
   * of any cached SessionEntry total.
   */
  tokenCount?: number;
  contextWindowTokens: number;
  /**
   * @deprecated Unused for preflight compaction. Kept so call sites can share
   * the memory-flush plan fields without a separate shape. Soft threshold only
   * gates memory flush, not compaction.
   */
  reserveTokensFloor?: number;
  /**
   * @deprecated Unused for preflight compaction. Soft threshold only gates
   * memory flush so compaction does not fire earlier than ~85% of the window.
   */
  softThresholdTokens?: number;
  minimumThresholdTokens?: number;
}): boolean {
  if (!params.entry) {
    return false;
  }
  const totalTokens =
    resolvePositiveTokenCount(params.tokenCount) ?? resolveFreshSessionTotalTokens(params.entry);
  if (!totalTokens || totalTokens <= 0) {
    return false;
  }
  const threshold = resolvePreflightCompactionThreshold({
    contextWindowTokens: params.contextWindowTokens,
    minimumThresholdTokens: params.minimumThresholdTokens,
  });
  return threshold > 0 && totalTokens >= threshold;
}

/**
 * Returns true when a memory flush has already been performed for the current
 * compaction cycle. This prevents repeated flush runs within the same cycle —
 * important for both the token-based and transcript-size–based trigger paths.
 */
export function hasAlreadyFlushedForCurrentCompaction(
  entry: Pick<SessionEntry, "compactionCount" | "memoryFlushCompactionCount">,
): boolean {
  const compactionCount = entry.compactionCount ?? 0;
  const lastFlushAt = entry.memoryFlushCompactionCount;
  return typeof lastFlushAt === "number" && lastFlushAt === compactionCount;
}
