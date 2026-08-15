import { CompactionError } from "../../packages/agent-core/src/harness/types.js";
/**
 * Summarization and fallback helpers for transcript compaction.
 */
import type { AgentCompactionIdentifierPolicy } from "../config/types.agent-defaults.js";
import { isAbortError } from "../infra/abort-signal.js";
import { sleepWithAbort } from "../infra/backoff.js";
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
import { generateSummary } from "./sessions/index.js";

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

type CompactionSummaryParams = {
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
  thinkingLevel?: ThinkingLevel;
  streamFn?: StreamFn;
};

function resolveIdentifierPreservationInstructions(
  instructions?: CompactionSummarizationInstructions,
): string | undefined {
  if (instructions?.identifierPolicy === "off") {
    return undefined;
  }
  return instructions?.identifierPolicy === "custom"
    ? instructions.identifierInstructions?.trim() || IDENTIFIER_PRESERVATION_INSTRUCTIONS
    : IDENTIFIER_PRESERVATION_INSTRUCTIONS;
}

/** Combines identifier-preservation and caller-provided compaction instructions. */
function buildCompactionSummarizationInstructions(
  customInstructions?: string,
  instructions?: CompactionSummarizationInstructions,
): string | undefined {
  const custom = customInstructions?.trim();
  const identifierPreservation = resolveIdentifierPreservationInstructions(instructions);
  if (!custom) {
    return identifierPreservation;
  }
  return identifierPreservation
    ? `${identifierPreservation}\n\nAdditional focus:\n${custom}`
    : `Additional focus:\n${custom}`;
}

async function summarizeChunks(params: CompactionSummaryParams): Promise<string> {
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
  for (const [completedChunks, chunk] of chunks.entries()) {
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
            params.thinkingLevel,
            params.streamFn,
          ),
        {
          attempts: 3,
          minDelayMs: 500,
          maxDelayMs: 5000,
          jitter: 0.2,
          label: "compaction/generateSummary",
          // Backoff must honor caller cancellation; otherwise an abort during
          // the sleep would stall compaction until the full delay elapses.
          sleep: (ms) => sleepWithAbort(ms, params.signal),
          // Caller aborts and transport timeouts are terminal; provider-side
          // AbortErrors without caller cancellation remain retryable.
          shouldRetry: (err) =>
            !params.signal.aborted && (isAbortError(err) || !isTimeoutError(err)),
        },
      );
    } catch (err) {
      // Caller aborts, transport timeouts, and failures before any completed
      // chunk cannot produce a recoverable partial summary.
      if (
        params.signal.aborted ||
        (!isAbortError(err) && isTimeoutError(err)) ||
        completedChunks === 0 ||
        summary === undefined
      ) {
        throw err;
      }
      // At least one chunk succeeded — throw with the partial summary
      // attached so summarizeWithFallback can try the oversized-message
      // retry first and only fall back to the partial summary if that
      // also fails.
      log.warn("chunk summarization failed after retries; partial summary available", {
        err,
        completedChunks,
        totalChunks: chunks.length,
      });
      const partial = new Error("partial summarization failure");
      (partial as PartialSummaryError).partialSummary =
        `${summary}\n\n[Partial summary: chunks 1-${completedChunks} of ${chunks.length} were summarized. Chunks ${completedChunks + 1}-${chunks.length} could not be processed.]`;
      throw partial;
    }
  }

  return summary ?? DEFAULT_SUMMARY_FALLBACK;
}

/**
 * Summarize with progressive fallback for handling oversized messages.
 * If full summarization fails, tries partial summarization excluding oversized messages.
 */
async function summarizeWithFallback(params: CompactionSummaryParams): Promise<string> {
  const { messages, contextWindow } = params;

  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  // Try full summarization first
  let partialSummaryFallback: string | undefined;
  let lastError: unknown;
  try {
    return await summarizeChunks(params);
  } catch (err) {
    lastError = err;
    if (params.signal.aborted) {
      throw lastError;
    }
    log.warn(`Full summarization failed: ${formatErrorMessage(lastError)}`);
    partialSummaryFallback = (lastError as PartialSummaryError).partialSummary;
  }

  // Fallback 1: Summarize only small messages, note oversized ones.
  const { smallMessages, oversizedNotes } = await buildOversizedFallbackPlanWithWorker({
    messages,
    contextWindow,
    signal: params.signal,
  });
  const oversizedSuffix = oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join("\n")}` : "";

  // When nothing was oversized, `smallMessages` is the same transcript as the full attempt.
  // Re-summarizing it would duplicate the same failing API work (and duplicate warn logs).
  if (smallMessages.length > 0 && smallMessages.length !== messages.length) {
    try {
      const partialSummary = await summarizeChunks({
        ...params,
        messages: smallMessages,
      });
      return partialSummary + oversizedSuffix;
    } catch (partialError) {
      lastError = partialError;
      if (params.signal.aborted) {
        throw lastError;
      }
      log.warn(`Partial summarization also failed: ${formatErrorMessage(lastError)}`);
      // Prefer the oversized retry's partial summary over the full attempt's,
      // since it covers the non-oversized transcript. Append oversized notes
      // so the model knows large content was filtered.
      const retryPartial = (lastError as PartialSummaryError).partialSummary;
      if (retryPartial) {
        partialSummaryFallback = retryPartial + oversizedSuffix;
      }
    }
  }

  // Final fallback: use best available partial summary, otherwise throw error
  if (partialSummaryFallback) {
    return partialSummaryFallback;
  }

  // All summarization attempts failed — throw error so caller knows compaction
  // did not succeed. This prevents silent infinite retry loops where "Compaction
  // complete" is reported but no tokens are reclaimed.
  throw new CompactionError(
    "summarization_failed",
    `All summarization attempts failed for ${messages.length} messages. ` +
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    lastError instanceof Error ? lastError : undefined,
  );
}

/** Extracts a compact timestamp range from a chunk of messages for merge metadata. */
function extractChunkTimeRange(chunk: AgentMessage[]): string {
  let earliest = Number.POSITIVE_INFINITY;
  let latest = 0;
  for (const message of chunk) {
    const timestamp = message.timestamp;
    if (
      typeof timestamp !== "number" ||
      timestamp <= 0 ||
      !Number.isFinite(new Date(timestamp).getTime())
    ) {
      continue;
    }
    earliest = Math.min(earliest, timestamp);
    latest = Math.max(latest, timestamp);
  }
  if (!Number.isFinite(earliest)) {
    return "";
  }
  const format = (timestamp: number) =>
    new Date(timestamp).toISOString().replace("T", " ").slice(0, 16);
  const range = earliest === latest ? format(earliest) : `${format(earliest)} — ${format(latest)}`;
  return ` [${range} UTC]`;
}

/** Summarizes history in multiple stages when a single pass would be too large. */
export async function summarizeInStages(
  params: CompactionSummaryParams & {
    parts?: number;
    minMessagesForSplit?: number;
  },
): Promise<CompactionSummaryResult> {
  const { messages } = params;
  if (messages.length === 0) {
    return { kind: "summary", text: await summarizeWithFallback(params) };
  }

  const plan = await buildStageSplitPlanWithWorker({
    messages,
    maxChunkTokens: params.maxChunkTokens,
    parts: params.parts,
    minMessagesForSplit: params.minMessagesForSplit,
    signal: params.signal,
  });

  if (plan.mode === "single") {
    return { kind: "summary", text: await summarizeWithFallback(params) };
  }

  const partialSummaries: string[] = [];
  for (const [index, chunk] of plan.chunks.entries()) {
    try {
      const summary = await summarizeWithFallback({
        ...params,
        messages: chunk,
        previousSummary: undefined,
      });
      partialSummaries.push(summary);
    } catch (err) {
      // A chunk summarization failed — fail the whole stages compaction.
      // This prevents silent infinite retry loops where compaction reports
      // success but no tokens are reclaimed.
      if (err instanceof CompactionError) {
        throw err;
      }
      // Wrap non-CompactionError failures for consistent error handling
      throw new CompactionError(
        "summarization_failed",
        `Chunk ${index + 1} summarization failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined,
      );
    }
  }

  if (partialSummaries.length === 1) {
    const summary = partialSummaries.at(0);
    if (summary === undefined) {
      throw new Error("Compaction summary plan produced no summary");
    }
    return { kind: "summary", text: summary };
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

  return {
    kind: "summary",
    text: await summarizeWithFallback({
      ...params,
      messages: summaryMessages,
      customInstructions: mergeInstructions,
    }),
  };
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
