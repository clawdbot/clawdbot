/**
 * Planning helpers for transcript compaction. The module estimates sanitized
 * token usage, chooses chunking strategy, and preserves active tool-use pairs
 * while splitting history for summaries.
 */
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
export type HistoryPrunePlan = {
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

/** Estimates one message using the same sanitization path as multi-message planning. */
function estimateCompactionMessageTokens(message: AgentMessage): number {
  return estimateMessagesTokens([message]);
}

function estimateCompactionPlanningTokens(message: AgentMessage): number {
  const omittedChars = readCompactionPlanningOmittedChars(message);
  if (omittedChars === 0) {
    return estimateTokens(message);
  }
  return estimateTokens(message) + Math.ceil(omittedChars / 4);
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

  // Sanitize the full array once and reuse per-message token counts; avoids the
  // per-message [msg] wrap-and-clone that previously ran on every iteration.
  const perMessageTokens = estimatePerMessageTokens(messages);
  const totalTokens = perMessageTokens.reduce((sum, tokens) => sum + tokens, 0);
  const targetTokens = totalTokens / normalizedParts;
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let currentTokens = 0;

  let pendingToolCallIds = new Set<string>();
  let pendingChunkStartIndex: number | null = null;
  // Token count for each message currently buffered in `current`, kept in lockstep so a
  // boundary split can re-sum without re-estimating.
  let currentTokenCounts: number[] = [];

  const splitCurrentAtPendingBoundary = (): boolean => {
    if (
      pendingChunkStartIndex === null ||
      pendingChunkStartIndex <= 0 ||
      chunks.length >= normalizedParts - 1
    ) {
      return false;
    }
    // Keep an assistant tool_use and its following tool_result responses in the same chunk.
    chunks.push(current.slice(0, pendingChunkStartIndex));
    current = current.slice(pendingChunkStartIndex);
    currentTokenCounts = currentTokenCounts.slice(pendingChunkStartIndex);
    currentTokens = currentTokenCounts.reduce((sum, tokens) => sum + tokens, 0);
    pendingChunkStartIndex = 0;
    return true;
  };

  for (const [index, message] of messages.entries()) {
    const messageTokens = perMessageTokens.at(index);
    if (messageTokens === undefined) {
      throw new Error("Compaction token estimates are out of sync with messages");
    }

    if (
      pendingToolCallIds.size === 0 &&
      chunks.length < normalizedParts - 1 &&
      current.length > 0 &&
      currentTokens + messageTokens > targetTokens
    ) {
      chunks.push(current);
      current = [];
      currentTokenCounts = [];
      currentTokens = 0;
      pendingChunkStartIndex = null;
    }

    current.push(message);
    currentTokenCounts.push(messageTokens);
    currentTokens += messageTokens;

    if (message.role === "assistant") {
      const toolCalls = extractToolCallsFromAssistant(message);
      const stopReason = (message as { stopReason?: unknown }).stopReason;
      const keepsPending =
        stopReason !== "aborted" && stopReason !== "error" && toolCalls.length > 0;
      pendingToolCallIds = new Set();
      if (keepsPending) {
        for (const toolCall of toolCalls) {
          pendingToolCallIds.add(toolCall.id);
        }
      }
      pendingChunkStartIndex = keepsPending ? current.length - 1 : null;
    } else if (message.role === "toolResult" && pendingToolCallIds.size > 0) {
      const resultId = extractToolResultId(message);
      if (!resultId) {
        pendingToolCallIds = new Set();
        pendingChunkStartIndex = null;
      } else {
        pendingToolCallIds.delete(resultId);
      }
      if (
        pendingToolCallIds.size === 0 &&
        chunks.length < normalizedParts - 1 &&
        currentTokens > targetTokens
      ) {
        splitCurrentAtPendingBoundary();
        pendingChunkStartIndex = null;
      }
    }
  }

  if (pendingToolCallIds.size > 0 && currentTokens > targetTokens) {
    splitCurrentAtPendingBoundary();
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/** Chunks messages by a max-token budget while applying the shared estimator safety margin. */
function chunkMessagesByMaxTokens(messages: AgentMessage[], maxTokens: number): AgentMessage[][] {
  if (messages.length === 0) {
    return [];
  }

  // Apply safety margin to compensate for estimateTokens() underestimation
  // (chars/4 heuristic misses multi-byte chars, special tokens, code tokens, etc.)
  const effectiveMax = Math.max(1, Math.floor(maxTokens / SAFETY_MARGIN));

  // Sanitize the full array once and reuse per-message token counts; avoids the
  // per-message [msg] wrap-and-clone that previously ran on every iteration.
  const perMessageTokens = estimatePerMessageTokens(messages);
  const chunks: AgentMessage[][] = [];
  let currentChunk: AgentMessage[] = [];
  let currentTokens = 0;

  for (const [index, message] of messages.entries()) {
    const messageTokens = perMessageTokens.at(index);
    if (messageTokens === undefined) {
      throw new Error("Compaction token estimates are out of sync with messages");
    }
    if (currentChunk.length > 0 && currentTokens + messageTokens > effectiveMax) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(message);
    currentTokens += messageTokens;

    if (messageTokens > effectiveMax) {
      // Split oversized messages to avoid unbounded chunk growth.
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Compute adaptive chunk ratio based on average message size.
 * When messages are large, we use smaller chunks to avoid exceeding model limits.
 */
export function computeAdaptiveChunkRatio(messages: AgentMessage[], contextWindow: number): number {
  if (messages.length === 0) {
    return BASE_CHUNK_RATIO;
  }

  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;

  // Apply safety margin to account for estimation inaccuracy
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindow;

  // If average message is > 10% of context, reduce chunk ratio
  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }

  return BASE_CHUNK_RATIO;
}

/**
 * Check if a single message is too large to summarize.
 * If single message > 50% of context, it can't be summarized safely.
 */
export function isOversizedForSummary(msg: AgentMessage, contextWindow: number): boolean {
  const tokens = estimateCompactionMessageTokens(msg) * SAFETY_MARGIN;
  return tokens > contextWindow * 0.5;
}

/** Builds sanitized chunks for summarization prompts. */
export function buildSummaryChunks(params: {
  messages: AgentMessage[];
  maxChunkTokens: number;
}): AgentMessage[][] {
  // SECURITY: never feed toolResult.details or runtime-context transcript entries into summarization prompts.
  const safeMessages = sanitizeCompactionMessages(params.messages);
  return chunkMessagesByMaxTokens(safeMessages, params.maxChunkTokens);
}

/** Separates messages too large to summarize and emits compact placeholder notes for them. */
export function buildOversizedFallbackPlan(params: {
  messages: AgentMessage[];
  contextWindow: number;
}): OversizedFallbackPlan {
  const smallMessages: AgentMessage[] = [];
  const oversizedNotes: string[] = [];

  // Sanitize the full array once and reuse per-message token counts; avoids the
  // per-message [msg] wrap-and-clone (twice per oversized message) of the prior loop.
  const perMessageTokens = estimatePerMessageTokens(params.messages);
  const oversizedThreshold = params.contextWindow * 0.5;

  for (const [index, msg] of params.messages.entries()) {
    const tokens = perMessageTokens.at(index);
    if (tokens === undefined) {
      throw new Error("Compaction token estimates are out of sync with messages");
    }
    if (tokens * SAFETY_MARGIN > oversizedThreshold) {
      const role = (msg as { role?: string }).role ?? "message";
      oversizedNotes.push(
        `[Large ${role} (~${Math.round(tokens / 1000)}K tokens) omitted from summary]`,
      );
    } else {
      smallMessages.push(msg);
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
  maxHistoryShare?: number;
  parts?: number;
  mode?: "share" | "handoff";
}): {
  messages: AgentMessage[];
  droppedMessagesList: AgentMessage[];
  droppedChunks: number;
  droppedMessages: number;
  droppedTokens: number;
  keptTokens: number;
  budgetTokens: number;
} {
  const isHandoff = params.mode === "handoff";
  const defaultShare = isHandoff ? 0.2 : 0.5; // Stricter budget for handoff snapshots
  const maxHistoryShare = params.maxHistoryShare ?? defaultShare;
  const budgetTokens = Math.max(1, Math.floor(params.maxContextTokens * maxHistoryShare));
  // Validate the retained history before any budget-driven chunk drop. Some
  // timeout paths leave an assistant tool_use in history without its matching
  // result even when the history already fits the target budget.
  let keptMessages = repairToolUseResultPairing(params.messages, {
    erroredAssistantResultPolicy: "drop",
  }).messages;
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
    const [dropped, ...rest] = chunks;
    if (!dropped) {
      break;
    }
    const flatRest = rest.flat();

    // After dropping a chunk, repair tool_use/tool_result pairing to handle
    // orphaned tool_results (whose tool_use was in the dropped chunk).
    // repairToolUseResultPairing drops orphaned tool_results, preventing
    // "unexpected tool_use_id" errors from Anthropic's API.
    const repairReport = repairToolUseResultPairing(flatRest, {
      erroredAssistantResultPolicy: "drop",
    });
    const repairedKept = repairReport.messages;

    // Track orphaned tool_results as dropped (they were in kept but their tool_use was dropped)
    const orphanedCount = repairReport.droppedOrphanCount;

    droppedChunks += 1;
    droppedMessages += dropped.length + orphanedCount;
    droppedTokens += estimateMessagesTokens(dropped);
    // Note: We don't have the actual orphaned messages to add to droppedMessagesList
    // since repairToolUseResultPairing doesn't return them. This is acceptable since
    // the dropped messages are used for summarization, and orphaned tool_results
    // without their tool_use context aren't useful for summarization anyway.
    allDroppedMessages.push(...dropped);
    keptMessages = repairedKept;
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

  if (newContentTokens <= maxHistoryTokens) {
    return {
      summarizableTokens,
      newContentTokens,
      maxHistoryTokens,
    };
  }

  return {
    summarizableTokens,
    newContentTokens,
    maxHistoryTokens,
    pruned: pruneHistoryForContextShare({
      messages: params.messagesToSummarize,
      maxContextTokens: params.contextWindowTokens,
      maxHistoryShare: params.maxHistoryShare,
      parts: params.parts,
    }),
  };
}
