/**
 * Planning helpers for transcript compaction. The module estimates sanitized
 * token usage, chooses chunking strategy, and preserves active tool-use pairs
 * while splitting history for summaries.
 */
import { createToolCallOccurrenceQueue } from "../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import {
  projectCompactionPlanningMessages,
  readCompactionPlanningOmittedChars,
} from "./compaction-planning-projection.js";
import { stripRuntimeContextCustomMessages } from "./internal-runtime-context.js";
import type { AgentMessage } from "./runtime/index.js";
import { repairToolUseResultPairing, stripToolResultDetails } from "./session-transcript-repair.js";
import { estimateTokens } from "./sessions/index.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";

/** Default share of context window targeted for compaction chunks. */
export const BASE_CHUNK_RATIO = 0.4;
/** Lower bound for adaptive compaction chunk sizing. */
export const MIN_CHUNK_RATIO = 0.15;
/** Buffer for estimateTokens() inaccuracy. */
export const SAFETY_MARGIN = 1.2;
const DEFAULT_PARTS = 2;

/**
 * Overhead reserved for summary prompt, system prompt, prior summary, wrapper
 * tags, and high-reasoning summary generation.
 */
export const SUMMARIZATION_OVERHEAD_TOKENS = 4096;

/** Decision for whether a summarization stage should run as one chunk or multiple chunks. */
export type StageSplitPlan =
  | {
      mode: "single";
    }
  | {
      mode: "split";
      chunks: AgentMessage[][];
    };

/** Messages safe to summarize plus notes for messages too large to fit in a summary request. */
export type OversizedFallbackPlan = {
  smallMessages: AgentMessage[];
  oversizedNotes: string[];
};

/** Token accounting and optional prune result for preserving context-window headroom. */
type HistoryPrunePlan = {
  summarizableTokens: number;
  newContentTokens: number;
  maxHistoryTokens: number;
  pruned?: ReturnType<typeof pruneHistoryForContextShare>;
};

/** Estimates compaction tokens after removing fields that must not reach summarization. */
export function estimateMessagesTokens(messages: AgentMessage[]): number {
  // SECURITY: toolResult.details and runtime-context transcript entries must never enter LLM-facing compaction.
  const safe = sanitizeCompactionMessages(messages);
  return safe.reduce((sum, message) => sum + estimateCompactionPlanningTokens(message), 0);
}

/**
 * Per-original-message token estimates, aligned 1:1 to the input array. Sanitizes
 * the full array once instead of wrapping and re-cloning each message in its own
 * 1-element array. Runtime-context entries are not model-visible, so they estimate
 * to 0 here just as sanitizeCompactionMessages([msg]) would drop them.
 */
function estimatePerMessageTokens(messages: AgentMessage[]): number[] {
  // SECURITY: toolResult.details must never enter LLM-facing compaction; strip once for the whole array.
  const detailStripped = stripToolResultDetails(messages);
  // stripRuntimeContextCustomMessages filters by reference, so kept entries keep their identity.
  const modelVisible = new Set(stripRuntimeContextCustomMessages(detailStripped));
  return detailStripped.map((message) =>
    modelVisible.has(message) ? estimateCompactionPlanningTokens(message) : 0,
  );
}

/** Removes runtime-only context and tool-result details before token estimates or summaries. */
export function sanitizeCompactionMessages(messages: AgentMessage[]): AgentMessage[] {
  return stripToolResultDetails(stripRuntimeContextCustomMessages(messages));
}

function estimateCompactionPlanningTokens(message: AgentMessage): number {
  return estimateTokens(message) + Math.ceil(readCompactionPlanningOmittedChars(message) / 4);
}

/** Builds a bounded planning projection that preserves token pressure accounting. */
export function projectCompactionMessagesForPlanning(messages: AgentMessage[]): AgentMessage[] {
  const safe = sanitizeCompactionMessages(messages);
  return projectCompactionPlanningMessages(safe);
}

/** Clamps requested split parts to a usable count for the available messages. */
function normalizeCompactionParts(parts: number, messageCount: number): number {
  if (!Number.isFinite(parts) || parts <= 1) {
    return 1;
  }
  return Math.min(Math.max(1, Math.floor(parts)), Math.max(1, messageCount));
}

type CompactionMessageGroup = {
  messages: AgentMessage[];
  tokens: number;
};

function groupCompactionMessages(
  messages: AgentMessage[],
  perMessageTokens: number[],
): CompactionMessageGroup[] {
  const groups: CompactionMessageGroup[] = [];
  let current: AgentMessage[] = [];
  let currentTokens = 0;
  let pendingToolCalls = createToolCallOccurrenceQueue<true>();

  for (const [index, message] of messages.entries()) {
    current.push(message);
    currentTokens += perMessageTokens[index]!;

    if (message.role === "assistant") {
      const stopReason = (message as { stopReason?: unknown }).stopReason;
      const toolCalls =
        stopReason === "aborted" || stopReason === "error"
          ? []
          : extractToolCallsFromAssistant(message);
      pendingToolCalls = createToolCallOccurrenceQueue();
      for (const toolCall of toolCalls) {
        pendingToolCalls.add(toolCall.id, true);
      }
    } else if (message.role === "toolResult" && pendingToolCalls.size > 0) {
      const resultId = extractToolResultId(message);
      if (resultId) {
        pendingToolCalls.claim(resultId);
      } else {
        pendingToolCalls.clear();
      }
    }

    // A displaced user turn still belongs to an unfinished call/result batch;
    // splitting it would make one of the resulting provider transcripts invalid.
    if (pendingToolCalls.size === 0) {
      groups.push({ messages: current, tokens: currentTokens });
      current = [];
      currentTokens = 0;
    }
  }

  if (current.length > 0) {
    groups.push({ messages: current, tokens: currentTokens });
  }
  return groups;
}

/** Chunks atomic tool-call groups without splitting a provider-visible call/result pair. */
function chunkCompactionMessageGroups(
  messages: AgentMessage[],
  maxTokens: number,
  perMessageTokens: number[],
  maxChunks = Number.POSITIVE_INFINITY,
): AgentMessage[][] {
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let currentTokens = 0;

  for (const group of groupCompactionMessages(messages, perMessageTokens)) {
    if (
      current.length > 0 &&
      chunks.length < maxChunks - 1 &&
      currentTokens + group.tokens > maxTokens
    ) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(...group.messages);
    currentTokens += group.tokens;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/** Splits messages into roughly equal token-share chunks without separating active tool pairs. */
function splitMessagesByTokenShare(
  messages: AgentMessage[],
  parts = DEFAULT_PARTS,
): AgentMessage[][] {
  if (messages.length === 0) {
    return [];
  }
  const normalizedParts = normalizeCompactionParts(parts, messages.length);
  if (normalizedParts <= 1) {
    return [messages];
  }
  const perMessageTokens = estimatePerMessageTokens(messages);
  const totalTokens = perMessageTokens.reduce((sum, tokens) => sum + tokens, 0);
  return chunkCompactionMessageGroups(
    messages,
    totalTokens / normalizedParts,
    perMessageTokens,
    normalizedParts,
  );
}

/**
 * Compute adaptive chunk ratio based on average message size.
 * When messages are large, we use smaller chunks to avoid exceeding model limits.
 */
export function computeAdaptiveChunkRatio(messages: AgentMessage[], contextWindow: number): number {
  if (messages.length === 0) {
    return BASE_CHUNK_RATIO;
  }

  const avgRatio =
    ((estimateMessagesTokens(messages) / messages.length) * SAFETY_MARGIN) / contextWindow;

  // If average message is > 10% of context, reduce chunk ratio
  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }

  return BASE_CHUNK_RATIO;
}

/** Returns whether one message exceeds the safe summarization context share. */
export function isOversizedForSummary(msg: AgentMessage, contextWindow: number): boolean {
  const tokens = estimateMessagesTokens([msg]) * SAFETY_MARGIN;
  return tokens > contextWindow * 0.5;
}

/** Builds sanitized chunks for summarization prompts. */
export function buildSummaryChunks(params: {
  messages: AgentMessage[];
  maxChunkTokens: number;
}): AgentMessage[][] {
  // SECURITY: never feed toolResult.details or runtime-context transcript entries into summarization prompts.
  const safeMessages = sanitizeCompactionMessages(params.messages);
  // The estimator can undercount Unicode/code tokens; indivisible tool batches may exceed this cap.
  const effectiveMax = Math.max(1, Math.floor(params.maxChunkTokens / SAFETY_MARGIN));
  return chunkCompactionMessageGroups(
    safeMessages,
    effectiveMax,
    estimatePerMessageTokens(safeMessages),
  );
}

/** Separates messages too large to summarize and emits compact placeholder notes for them. */
export function buildOversizedFallbackPlan(params: {
  messages: AgentMessage[];
  contextWindow: number;
}): OversizedFallbackPlan {
  const smallMessages: AgentMessage[] = [];
  const oversizedNotes: string[] = [];

  // Reuse one sanitized token estimate per message across atomic fallback groups.
  const perMessageTokens = estimatePerMessageTokens(params.messages);
  const oversizedThreshold = params.contextWindow * 0.5;
  let messageIndex = 0;

  for (const group of groupCompactionMessages(params.messages, perMessageTokens)) {
    const retainedMessages: AgentMessage[] = [];
    let omitToolBatch = false;
    for (const message of group.messages) {
      const tokens = perMessageTokens[messageIndex++]!;
      if (tokens * SAFETY_MARGIN > oversizedThreshold) {
        oversizedNotes.push(
          `[Large ${message.role} (~${Math.round(tokens / 1000)}K tokens) omitted from summary]`,
        );
        omitToolBatch ||= message.role === "assistant" || message.role === "toolResult";
      } else {
        retainedMessages.push(message);
      }
    }
    // Displaced real user turns survive even when their surrounding tool batch cannot.
    for (const message of retainedMessages) {
      if (!omitToolBatch || (message.role !== "assistant" && message.role !== "toolResult")) {
        smallMessages.push(message);
      }
    }
  }

  return { smallMessages, oversizedNotes };
}

/** Plans whether to split a summarization stage based on message count and token budget. */
export function buildStageSplitPlan(params: {
  messages: AgentMessage[];
  maxChunkTokens: number;
  parts?: number;
  minMessagesForSplit?: number;
}): StageSplitPlan {
  const minMessagesForSplit = Math.max(2, params.minMessagesForSplit ?? 4);
  const parts = normalizeCompactionParts(params.parts ?? DEFAULT_PARTS, params.messages.length);
  const totalTokens = estimateMessagesTokens(params.messages);

  if (
    parts <= 1 ||
    params.messages.length < minMessagesForSplit ||
    totalTokens <= params.maxChunkTokens
  ) {
    return { mode: "single" };
  }

  const chunks = splitMessagesByTokenShare(params.messages, parts).filter(
    (chunk) => chunk.length > 0,
  );
  return chunks.length > 1 ? { mode: "split", chunks } : { mode: "single" };
}

/** Drops oldest token-share chunks until history fits the requested context share. */
function pruneHistoryForContextShare(params: {
  messages: AgentMessage[];
  maxContextTokens: number;
  maxHistoryShare: number;
  parts?: number;
}): {
  messages: AgentMessage[];
  droppedMessagesList: AgentMessage[];
  droppedChunks: number;
  droppedMessages: number;
  droppedTokens: number;
  keptTokens: number;
  budgetTokens: number;
} {
  const budgetTokens = Math.max(1, Math.floor(params.maxContextTokens * params.maxHistoryShare));
  let keptMessages = params.messages;
  const allDroppedMessages: AgentMessage[] = [];
  let droppedChunks = 0;
  let droppedMessages = 0;
  let droppedTokens = 0;

  const parts = normalizeCompactionParts(params.parts ?? DEFAULT_PARTS, keptMessages.length);

  while (keptMessages.length > 0 && estimateMessagesTokens(keptMessages) > budgetTokens) {
    const chunks = splitMessagesByTokenShare(keptMessages, parts);
    if (chunks.length <= 1) {
      break;
    }
    const dropped = chunks[0]!;
    // Dropping a call owner also drops orphaned results; providers reject replay without the pair.
    const repairReport = repairToolUseResultPairing(chunks.slice(1).flat());

    droppedChunks += 1;
    droppedMessages += dropped.length + repairReport.droppedOrphanCount;
    droppedTokens += estimateMessagesTokens(dropped);
    allDroppedMessages.push(...dropped);
    keptMessages = repairReport.messages;
  }

  return {
    messages: keptMessages,
    droppedMessagesList: allDroppedMessages,
    droppedChunks,
    droppedMessages,
    droppedTokens,
    keptTokens: estimateMessagesTokens(keptMessages),
    budgetTokens,
  };
}

/** Computes whether new content exceeds the history budget and plans pruning when needed. */
export function buildHistoryPrunePlan(params: {
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  tokensBefore: number;
  contextWindowTokens: number;
  maxHistoryShare: number;
  parts?: number;
}): HistoryPrunePlan {
  const summarizableTokens =
    estimateMessagesTokens(params.messagesToSummarize) +
    estimateMessagesTokens(params.turnPrefixMessages);
  const newContentTokens = Math.max(0, Math.floor(params.tokensBefore - summarizableTokens));
  // Apply SAFETY_MARGIN so token underestimates don't trigger unnecessary pruning.
  const maxHistoryTokens = Math.floor(
    params.contextWindowTokens * params.maxHistoryShare * SAFETY_MARGIN,
  );

  const plan = { summarizableTokens, newContentTokens, maxHistoryTokens };
  return newContentTokens <= maxHistoryTokens
    ? plan
    : {
        ...plan,
        pruned: pruneHistoryForContextShare({
          messages: params.messagesToSummarize,
          maxContextTokens: params.contextWindowTokens,
          maxHistoryShare: params.maxHistoryShare,
          parts: params.parts,
        }),
      };
}
