import type { AgentCompactionIdentifierPolicy } from "../config/types.agent-defaults.js";
import { formatErrorMessage } from "../infra/errors.js";
import { retryAsync } from "../infra/retry.js";
import { isAbortError } from "../infra/unhandled-rejections.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildOversizedFallbackPlanWithWorker,
  buildStageSplitPlanWithWorker,
  buildSummaryChunksWithWorker,
} from "./compaction-planning-worker.js";
import {
  BASE_CHUNK_RATIO,
  chunkMessagesByMaxTokens,
  computeAdaptiveChunkRatio,
  estimateMessagesTokens,
  isOversizedForSummary,
  MIN_CHUNK_RATIO,
  pruneHistoryForContextShare,
  SAFETY_MARGIN,
  splitMessagesByTokenShare,
  SUMMARIZATION_OVERHEAD_TOKENS,
} from "./compaction-planning.js";
import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";
import { isTimeoutError } from "./failover-error.js";
import type { AgentMessage } from "./runtime/index.js";
import type { ExtensionContext } from "./sessions/index.js";
import { generateSummary as agentGenerateSummary } from "./sessions/index.js";

export {
  BASE_CHUNK_RATIO,
  chunkMessagesByMaxTokens,
  computeAdaptiveChunkRatio,
  estimateMessagesTokens,
  isOversizedForSummary,
  MIN_CHUNK_RATIO,
  pruneHistoryForContextShare,
  SAFETY_MARGIN,
  splitMessagesByTokenShare,
  SUMMARIZATION_OVERHEAD_TOKENS,
};

const log = createSubsystemLogger("compaction");

type PartialSummaryError = Error & { partialSummary?: string };

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

const HANDOFF_INSTRUCTIONS = [
  "Generate a concise recovery briefing for a new LLM taking over this session.",
  "The previous model hit a quota limit and you are providing the context for a smooth handoff.",
  "",
  "LEADER HIERARCHY REINFORCEMENT:",
  "- Explicitly state that the new model is the LEADER (Orchestrator).",
  "- Identify any active autonomous units (like AutoClaw) as SUBORDINATES.",
  "- Instruct the new model to NOT perform the subordinate's task, but to supervise and provide strategic commands.",
  "",
  "MUST CAPTURE:",
  "- Current high-level goal and project path.",
  "- Status of the latest tool executions (especially AutoClaw/Subagents).",
  "- Critical files currently being modified.",
  "- Pending items and next intended steps.",
].join("\n");

export type CompactionSummarizationInstructions = {
  identifierPolicy?: AgentCompactionIdentifierPolicy;
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

export function buildCompactionSummarizationInstructions(
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
          ),
        {
          attempts: 3,
          minDelayMs: 500,
          maxDelayMs: 5000,
          jitter: 0.2,
          label: "compaction/generateSummary",
          shouldRetry: (err) => !isAbortError(err) && !isTimeoutError(err),
        },
      );
      hasGeneratedChunk = true;
    } catch (err) {
      // Abort and timeout errors always propagate immediately.
      if (isAbortError(err) || isTimeoutError(err)) {
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
export async function summarizeWithFallback(params: {
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
}): Promise<string> {
  const { messages, contextWindow } = params;

  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  // Try full summarization first
  let partialSummaryFallback: string | undefined;
  try {
    return await summarizeChunks(params);
  } catch (fullError) {
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
      return partialSummary + notes;
    } catch (partialError) {
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
    return partialSummaryFallback;
  }
  return (
    `Context contained ${messages.length} messages (${oversizedNotes.length} oversized). ` +
    `Summary unavailable due to size limits.`
  );
}

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
}): Promise<string> {
  const { messages } = params;
  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  const plan = await buildStageSplitPlanWithWorker({
    messages,
    maxChunkTokens: params.maxChunkTokens,
    parts: params.parts,
    minMessagesForSplit: params.minMessagesForSplit,
    signal: params.signal,
  });

  if (plan.mode === "single") {
    return summarizeWithFallback(params);
  }

  const partialSummaries: string[] = [];
  for (const chunk of plan.chunks) {
    partialSummaries.push(
      await summarizeWithFallback({
        ...params,
        messages: chunk,
        previousSummary: undefined,
      }),
    );
  }

  if (partialSummaries.length === 1) {
    return partialSummaries[0];
  }

  const summaryMessages: AgentMessage[] = partialSummaries.map((summary) => ({
    role: "user",
    content: summary,
    timestamp: Date.now(),
  }));

  const custom = params.customInstructions?.trim();
  const mergeInstructions = custom
    ? `${MERGE_SUMMARIES_INSTRUCTIONS}\n\n${custom}`
    : MERGE_SUMMARIES_INSTRUCTIONS;

  return summarizeWithFallback({
    ...params,
    messages: summaryMessages,
    customInstructions: mergeInstructions,
  });
}

/**
 * Generates a concise handoff summary for model transitions, enforcing a 4000 token limit.
 */
export async function summarizeForHandoff(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  summarizationInstructions?: CompactionSummarizationInstructions;
}): Promise<string> {
  const custom = params.customInstructions?.trim();
  const handoffInstructions = custom
    ? `${HANDOFF_INSTRUCTIONS}\n\n${custom}`
    : HANDOFF_INSTRUCTIONS;

  // Use a hard cap of 4000 tokens for the handoff summary as per plan
  const handoffMaxTokens = 4000;

  return summarizeWithFallback({
    ...params,
    reserveTokens: SUMMARIZATION_OVERHEAD_TOKENS,
    maxChunkTokens: Math.min(params.maxChunkTokens, handoffMaxTokens),
    customInstructions: handoffInstructions,
  });
}

export function resolveContextWindowTokens(model?: ExtensionContext["model"]): number {
  const effective =
    (model as { contextTokens?: number } | undefined)?.contextTokens ?? model?.contextWindow;
  return Math.max(1, Math.floor(effective ?? DEFAULT_CONTEXT_TOKENS));
}
