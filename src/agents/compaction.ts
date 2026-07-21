/**
 * Summarization and fallback helpers for transcript compaction.
 */
import type { AgentCompactionIdentifierPolicy } from "../config/types.agent-defaults.js";
import { isAbortError } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { retryAsync } from "../infra/retry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildOversizedFallbackPlanWithWorker,
  buildStageSplitPlanWithWorker,
  buildSummaryChunksWithWorker,
} from "./compaction-planning-worker.js";
import {
  BASE_CHUNK_RATIO,
  computeAdaptiveChunkRatio,
  estimateMessagesTokens,
  isOversizedForSummary,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  SUMMARIZATION_OVERHEAD_TOKENS,
} from "./compaction-planning.js";
import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";
import { isTimeoutError } from "./failover-error.js";
import type { AgentMessage, StreamFn, ThinkingLevel } from "./runtime/index.js";
import type { ExtensionContext } from "./sessions/index.js";
import { generateSummary as agentGenerateSummary } from "./sessions/index.js";

export {
  BASE_CHUNK_RATIO,
  computeAdaptiveChunkRatio,
  estimateMessagesTokens,
  isOversizedForSummary,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  SUMMARIZATION_OVERHEAD_TOKENS,
};

const log = createSubsystemLogger("compaction");

type PartialSummaryError = Error & { partialSummary?: string };

type CompactionSummaryResult =
  | { kind: "summary"; text: string }
  | { kind: "generic-fallback"; text: string };

const DEFAULT_SUMMARY_FALLBACK = "No prior history.";
const MAX_CONSECUTIVE_GENERIC_FALLBACKS = 2;
const CIRCUIT_OPEN_ERROR =
  "Compaction staged summarization stopped after repeated generic fallbacks";
const MERGE_SUMMARIES_INSTRUCTIONS = [
  "Merge these partial summaries into a single cohesive summary.",
  "",
  "MUST PRESERVE:",
  "- Active tasks and their current status (in-progress, blocked, pending)",
  "- Batch operation progress (e.g., '5/17 items completed')",
  "- The last thing the user requested and what was being done about it",
  "- Decisions made and their rationale",
  "- TODOs, open questions, and constraints",
  "- Any commitments or follow-ups promised",
  "",
  "PRIORITIZE recent context over older history. The agent needs to know",
  "what it was doing, not just what was discussed.",
].join("\n");
const IDENTIFIER_PRESERVATION_INSTRUCTIONS =
  "Preserve all opaque identifiers exactly as written (no shortening or reconstruction), " +
  "including UUIDs, hashes, IDs, hostnames, IPs, ports, URLs, and file names.";

/** Optional instruction policy for preserving identifiers during compaction. */
export type CompactionSummarizationInstructions = {
  identifierPolicy?: AgentCompactionIdentifierPolicy | "custom";
  identifierInstructions?: string;
};

type GenerateSummaryCompat = {
  (
    currentMessages: AgentMessage[],
    model: NonNullable<ExtensionContext["model"]>,
    reserveTokens: number,
    apiKey: string,
    signal?: AbortSignal,
    customInstructions?: string,
    previousSummary?: string,
  ): Promise<string>;
  (
    currentMessages: AgentMessage[],
    model: NonNullable<ExtensionContext["model"]>,
    reserveTokens: number,
    apiKey: string,
    headers: Record<string, string> | undefined,
    signal?: AbortSignal,
    customInstructions?: string,
    previousSummary?: string,
    thinkingLevel?: ThinkingLevel,
    streamFn?: StreamFn,
  ): Promise<string>;
};

const generateSummaryCompat = agentGenerateSummary as unknown as GenerateSummaryCompat;

function resolveIdentifierPreservationInstructions(
  instructions?: CompactionSummarizationInstructions,
): string | undefined {
  const policy = instructions?.identifierPolicy ?? "strict";
  if (policy === "off") {
    return undefined;
  }
  if (policy === "custom") {
    const custom = instructions?.identifierInstructions?.trim();
    return custom && custom.length > 0 ? custom : IDENTIFIER_PRESERVATION_INSTRUCTIONS;
  }
  return IDENTIFIER_PRESERVATION_INSTRUCTIONS;
}

/** Combines identifier-preservation and caller-provided compaction instructions. */
function buildCompactionSummarizationInstructions(
  customInstructions?: string,
  instructions?: CompactionSummarizationInstructions,
): string | undefined {
  const custom = customInstructions?.trim();
  const identifierPreservation = resolveIdentifierPreservationInstructions(instructions);
  if (!identifierPreservation && !custom) {
    return undefined;
  }
  if (!custom) {
    return identifierPreservation;
  }
  if (!identifierPreservation) {
    return `Additional focus:\n${custom}`;
  }
  return `${identifierPreservation}\n\nAdditional focus:\n${custom}`;
}

async function summarizeChunks(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  customInstructions?: string;
  summarizationInstructions?: CompactionSummarizationInstructions;
  previousSummary?: string;
  streamFn?: StreamFn;
}): Promise<string> {
  if (params.messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  const chunks = await buildSummaryChunksWithWorker({
    messages: params.messages,
    maxChunkTokens: params.maxChunkTokens,
    signal: params.signal,
  });
  let summary = params.previousSummary;
  const effectiveInstructions = buildCompactionSummarizationInstructions(
    params.customInstructions,
    params.summarizationInstructions,
  );
  let hasGeneratedChunk = false;
  for (const chunk of chunks) {
    try {
      summary = await retryAsync(
        () =>
          generateSummary(
            chunk,
            params.model,
            params.reserveTokens,
            params.apiKey,
            params.headers,
            params.signal,
            effectiveInstructions,
            summary,
            params.streamFn,
          ),
        {
          attempts: 3,
          minDelayMs: 500,
          maxDelayMs: 5000,
          jitter: 0.2,
          label: "compaction/generateSummary",
          shouldRetry: (err) => {
            // Stop retrying when the caller explicitly cancelled.
            if (params.signal.aborted) {
              return false;
            }
            // Preserve existing non-retry policy for real network/transport
            // timeouts (e.g. "fetch failed", ETIMEDOUT) that are not AbortErrors.
            if (!isAbortError(err) && isTimeoutError(err)) {
              return false;
            }
            // Provider-side AbortErrors with signal not yet aborted are
            // transient disconnects — retrying is correct.
            return true;
          },
        },
      );
      hasGeneratedChunk = true;
    } catch (err) {
      // Propagate only when the caller explicitly cancelled. Provider-side
      // AbortErrors (signal not aborted) fall through to partial/fallback paths.
      if (params.signal.aborted) {
        throw err;
      }
      // Real non-abort transport timeouts still propagate immediately.
      if (!isAbortError(err) && isTimeoutError(err)) {
        throw err;
      }
      // No chunk has succeeded yet — rethrow so summarizeWithFallback
      // can run its existing "Context contained N messages" fallback.
      if (!hasGeneratedChunk) {
        throw err;
      }
      // At least one chunk succeeded — throw with the partial summary
      // attached so summarizeWithFallback can try the oversized-message
      // retry first and only fall back to the partial summary if that
      // also fails.
      const completedChunks = chunks.indexOf(chunk);
      log.warn("chunk summarization failed after retries; partial summary available", {
        err,
        completedChunks,
        totalChunks: chunks.length,
      });
      const partial = new Error("partial summarization failure");
      (partial as PartialSummaryError).partialSummary =
        `${summary!}\n\n[Partial summary: chunks 1-${completedChunks} of ${chunks.length} were summarized. Chunks ${completedChunks + 1}-${chunks.length} could not be processed.]`;
      throw partial;
    }
  }

  return summary ?? DEFAULT_SUMMARY_FALLBACK;
}

function generateSummary(
  currentMessages: AgentMessage[],
  model: NonNullable<ExtensionContext["model"]>,
  reserveTokens: number,
  apiKey: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
  streamFn?: StreamFn,
): Promise<string> {
  if (agentGenerateSummary.length >= 8) {
    return generateSummaryCompat(
      currentMessages,
      model,
      reserveTokens,
      apiKey,
      headers,
      signal,
      customInstructions,
      previousSummary,
      // thinkingLevel is unused for compaction summaries; pass undefined to
      // reach the streamFn slot so the summarizer uses the boundary-aware
      // stream (which resolves the real provider base URL) instead of the
      // core HTTP client that reads an empty model.baseUrl.
      undefined,
      streamFn,
    );
  }
  return generateSummaryCompat(
    currentMessages,
    model,
    reserveTokens,
    apiKey,
    signal,
    customInstructions,
    previousSummary,
  );
}

/**
 * Summarize with progressive fallback for handling oversized messages.
 * If full summarization fails, tries partial summarization excluding oversized messages.
 */
async function summarizeWithFallbackResult(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  summarizationInstructions?: CompactionSummarizationInstructions;
  previousSummary?: string;
  streamFn?: StreamFn;
}): Promise<CompactionSummaryResult> {
  const { messages, contextWindow } = params;

  if (messages.length === 0) {
    return {
      kind: "summary",
      text: params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK,
    };
  }

  // Try full summarization first
  let partialSummaryFallback: string | undefined;
  try {
    return { kind: "summary", text: await summarizeChunks(params) };
  } catch (fullError) {
    if (params.signal.aborted) {
      throw fullError;
    }
    log.warn(`Full summarization failed: ${formatErrorMessage(fullError)}`);
    partialSummaryFallback = (fullError as PartialSummaryError).partialSummary;
  }

  // Fallback 1: Summarize only small messages, note oversized ones.
  const { smallMessages, oversizedNotes } = await buildOversizedFallbackPlanWithWorker({
    messages,
    contextWindow,
    signal: params.signal,
  });

  // When nothing was oversized, `smallMessages` is the same transcript as the full attempt.
  // Re-summarizing it would duplicate the same failing API work (and duplicate warn logs).
  if (smallMessages.length > 0 && smallMessages.length !== messages.length) {
    try {
      const partialSummary = await summarizeChunks({
        ...params,
        messages: smallMessages,
      });
      const notes = oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join("\n")}` : "";
      return { kind: "summary", text: partialSummary + notes };
    } catch (partialError) {
      if (params.signal.aborted) {
        throw partialError;
      }
      log.warn(`Partial summarization also failed: ${formatErrorMessage(partialError)}`);
      // Prefer the oversized retry's partial summary over the full attempt's,
      // since it covers the non-oversized transcript. Append oversized notes
      // so the model knows large content was filtered.
      const retryPartial = (partialError as PartialSummaryError).partialSummary;
      if (retryPartial) {
        const notes = oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join("\n")}` : "";
        partialSummaryFallback = retryPartial + notes;
      }
    }
  }

  // Final fallback: use best available partial summary, otherwise generic note
  if (partialSummaryFallback) {
    return { kind: "summary", text: partialSummaryFallback };
  }
  return {
    kind: "generic-fallback",
    text:
      `Context contained ${messages.length} messages (${oversizedNotes.length} oversized). ` +
      `Summary unavailable due to size limits.`,
  };
}

async function summarizeWithFallback(
  params: Parameters<typeof summarizeWithFallbackResult>[0],
): Promise<string> {
  return (await summarizeWithFallbackResult(params)).text;
}

/** Extracts a compact timestamp range from a chunk of messages for merge metadata. */
function extractChunkTimeRange(chunk: AgentMessage[]): string {
  let earliest: number | undefined;
  let latest: number | undefined;
  for (const message of chunk) {
    const timestamp = message.timestamp;
    if (
      typeof timestamp !== "number" ||
      timestamp <= 0 ||
      !Number.isFinite(new Date(timestamp).getTime())
    ) {
      continue;
    }
    earliest = earliest === undefined ? timestamp : Math.min(earliest, timestamp);
    latest = latest === undefined ? timestamp : Math.max(latest, timestamp);
  }
  if (earliest === undefined || latest === undefined) {
    return "";
  }
  const format = (timestamp: number) =>
    new Date(timestamp).toISOString().replace("T", " ").slice(0, 16);
  const range = earliest === latest ? format(earliest) : `${format(earliest)} — ${format(latest)}`;
  return ` [${range} UTC]`;
}

/** Summarizes history in multiple stages when a single pass would be too large. */
export async function summarizeInStages(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  summarizationInstructions?: CompactionSummarizationInstructions;
  previousSummary?: string;
  parts?: number;
  minMessagesForSplit?: number;
  streamFn?: StreamFn;
}): Promise<CompactionSummaryResult> {
  const { messages } = params;
  if (messages.length === 0) {
    return {
      kind: "summary",
      text: params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK,
    };
  }

  const plan = await buildStageSplitPlanWithWorker({
    messages,
    maxChunkTokens: params.maxChunkTokens,
    parts: params.parts,
    minMessagesForSplit: params.minMessagesForSplit,
    signal: params.signal,
  });

  if (plan.mode === "single") {
    return summarizeWithFallbackResult(params);
  }

  const partialSummaries: string[] = [];
  let consecutiveGenericFallbacks = 0;
  // Caller-owned leading context lives in the oldest split. Only losing that
  // split requires restoration; later fallback placeholders remain in the merge.
  let oldestChunkDegraded = false;
  for (const [index, chunk] of plan.chunks.entries()) {
    const result = await summarizeWithFallbackResult({
      ...params,
      messages: chunk,
      previousSummary: undefined,
    });
    consecutiveGenericFallbacks =
      result.kind === "generic-fallback" ? consecutiveGenericFallbacks + 1 : 0;
    if (index === 0) {
      oldestChunkDegraded = result.kind === "generic-fallback";
    }

    // Keep one placeholder to mark the missing split, but stop before repeated
    // placeholders trigger more split requests or a doomed merge request.
    if (consecutiveGenericFallbacks >= MAX_CONSECUTIVE_GENERIC_FALLBACKS) {
      log.warn("compaction staged summarization stopped after repeated generic fallbacks", {
        attemptedSplits: index + 1,
        consecutiveGenericFallbacks,
        totalSplits: plan.chunks.length,
      });
      // The remaining chunks were never attempted. Abort the whole compaction
      // so the caller keeps the source transcript instead of committing a gap.
      throw new Error(CIRCUIT_OPEN_ERROR);
    }
    partialSummaries.push(result.text);
  }

  if (partialSummaries.length === 1) {
    const summary = partialSummaries.at(0);
    if (summary === undefined) {
      throw new Error("Compaction summary plan produced no summary");
    }
    return {
      kind: oldestChunkDegraded ? "generic-fallback" : "summary",
      text: summary,
    };
  }

  // Capture once so timestamps are strictly monotonic across
  // all synthetic messages regardless of how long the map iteration takes.
  const now = Date.now();
  const summaryMessages: AgentMessage[] = partialSummaries.map((summary, index) => {
    // serializeConversation preserves content but not timestamps, so chronology
    // must be explicit in the text consumed by the merge model.
    const chunk = plan.chunks.at(index);
    if (!chunk) {
      throw new Error(`Compaction summary plan is missing chunk ${index}`);
    }
    const timeRange = extractChunkTimeRange(chunk);
    const label =
      index === 0
        ? `[Chunk 1 — oldest messages${timeRange}]`
        : index === partialSummaries.length - 1
          ? `[Chunk ${partialSummaries.length} — most recent messages${timeRange}]`
          : `[Chunk ${index + 1}/${partialSummaries.length}${timeRange}]`;
    return {
      role: "user",
      content: `${label}\n${summary}`,
      // Ascending timestamps preserve chronological order for any code
      // path that reads the AgentMessage timestamp field directly.
      timestamp: now - (partialSummaries.length - 1 - index),
    };
  });

  const custom = params.customInstructions?.trim();
  const mergeInstructions = custom
    ? `${MERGE_SUMMARIES_INSTRUCTIONS}\n\n${custom}`
    : MERGE_SUMMARIES_INSTRUCTIONS;

  const mergedResult = await summarizeWithFallbackResult({
    ...params,
    messages: summaryMessages,
    customInstructions: mergeInstructions,
  });
  return oldestChunkDegraded && mergedResult.kind === "summary"
    ? { kind: "generic-fallback", text: mergedResult.text }
    : mergedResult;
}

/** Resolves a positive context-window token count from model metadata. */
export function resolveContextWindowTokens(model?: ExtensionContext["model"]): number {
  const effective =
    (model as { contextTokens?: number } | undefined)?.contextTokens ?? model?.contextWindow;
  return Math.max(1, Math.floor(effective ?? DEFAULT_CONTEXT_TOKENS));
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.compactionTestApi")] = {
    buildCompactionSummarizationInstructions,
    summarizeWithFallback,
  };
}
