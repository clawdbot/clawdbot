/**
 * Planning helpers for transcript compaction. The module estimates sanitized
 * token usage, chooses chunking strategy, and preserves active tool-use pairs
 * while splitting history for summaries.
 */
import { estimateTokens } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import { createToolCallOccurrenceQueue } from "../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import {
  projectCompactionPlanningMessages,
  readCompactionPlanningOmittedChars,
} from "./compaction-planning-projection.js";
import { stripRuntimeContextCustomMessages } from "./internal-runtime-context.js";
import type { AgentMessage } from "./runtime/index.js";
import { repairToolUseResultPairing, stripToolResultDetails } from "./session-transcript-repair.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";

/** Default share of context window targeted for compaction chunks. */
export const BASE_CHUNK_RATIO = 0.4;
/** Lower bound for adaptive compaction chunk sizing. */
export const MIN_CHUNK_RATIO = 0.15;
/** Buffer for estimateTokens() inaccuracy. */
export const SAFETY_MARGIN = 1.2;
const DEFAULT_PARTS = 2;
/** Matches the estimator's chars-per-token ratio so both sides stay comparable. */
const CHARS_PER_TOKEN = 4;
/** Measured cost of the role label and separator serializeConversation() adds. */
/**
 * Exact serialization framing per emitted section, mirroring serializeConversation():
 * `[User]: ` is 8 chars, `[Tool result]: ` is 15, `[Assistant]: ` is 13 and
 * `[Assistant tool calls]: ` is 24. Every section is joined by a 2-char separator,
 * and one assistant message emits *both* assistant sections when the turn carries
 * text and tool calls together.
 */
const SERIALIZED_FRAMING_CHARS = {
  assistant: 13 + 2,
  assistantToolCalls: 24 + 2,
  toolResult: 15 + 2,
  user: 8 + 2,
} as const;

/**
 * Overhead reserved for summary prompt, system prompt, prior summary, wrapper
 * tags, and high-reasoning summary generation.
 */
export const SUMMARIZATION_OVERHEAD_TOKENS = 4096;

/** Decision for whether a summarization stage should run as one chunk or multiple chunks. */
export type StageSplitPlan =
  | {
      mode: "single";
      // True only when the whole history was verified to fit one request. Legacy
      // single-stage shortcuts (too few messages, parts<=1) leave this false and
      // must keep their bounded chunk budget.
      fitsWholeRequest?: boolean;
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

function forEachCompactionMessageGroup(
  messages: AgentMessage[],
  perMessageTokens: number[],
  visit: (start: number, end: number, tokens: number) => void,
): void {
  let start = 0;
  let currentTokens = 0;
  let pendingToolCalls = createToolCallOccurrenceQueue<true>();

  for (const [index, message] of messages.entries()) {
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
      visit(start, index + 1, currentTokens);
      start = index + 1;
      currentTokens = 0;
    }
  }

  if (start < messages.length) {
    visit(start, messages.length, currentTokens);
  }
}

/** Chunks atomic tool-call groups without splitting a provider-visible call/result pair. */
function chunkCompactionMessageGroups(
  messages: AgentMessage[],
  maxTokens: number,
  perMessageTokens: number[],
  maxChunks = Number.POSITIVE_INFINITY,
): AgentMessage[][] {
  const chunks: AgentMessage[][] = [];
  let chunkStart = 0;
  let currentTokens = 0;

  forEachCompactionMessageGroup(messages, perMessageTokens, (start, _end, tokens) => {
    if (start > chunkStart && chunks.length < maxChunks - 1 && currentTokens + tokens > maxTokens) {
      chunks.push(messages.slice(chunkStart, start));
      chunkStart = start;
      currentTokens = 0;
    }

    currentTokens += tokens;
  });

  if (chunkStart < messages.length) {
    chunks.push(messages.slice(chunkStart));
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

  const avgRatio =
    ((estimateMessagesTokens(messages) / messages.length) * SAFETY_MARGIN) / contextWindow;

  // If average message is > 10% of context, reduce chunk ratio
  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }

  return BASE_CHUNK_RATIO;
}

/**
 * Serialization overhead the estimator never sees: convertToLlm() prefixes every
 * message with a role label and separates it with a blank line. It scales with
 * message *count*, not content size, so on short conversations it dominates:
 * 5,000 user/assistant pairs of "ok" carry 125,000 chars of framing against
 * 20,000 chars of content.
 *
 * This is deliberately additive rather than a serialized measurement of the
 * planning projection. Long histories reach the planner already shortened, with
 * the discarded content restored through omittedChars accounting. Serializing
 * that projection would measure the truncated text, and no Math.max() can
 * recombine a restored content cost with a truncated overhead cost.
 */
function estimateSerializationOverheadTokens(messages: AgentMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    const role = message.role;
    if (role === "assistant") {
      // One assistant turn can emit two sections, so charge whichever it will emit.
      const blocks = message.content;
      const parts = Array.isArray(blocks) ? blocks : [];
      const hasToolCalls = parts.some((block) => block.type === "toolCall");
      const hasText =
        parts.length === 0 || !hasToolCalls ? true : parts.some((block) => block.type === "text");
      if (hasText) {
        chars += SERIALIZED_FRAMING_CHARS.assistant;
      }
      if (hasToolCalls) {
        chars += SERIALIZED_FRAMING_CHARS.assistantToolCalls;
      }
    } else if (role === "toolResult") {
      chars += SERIALIZED_FRAMING_CHARS.toolResult;
    } else {
      chars += SERIALIZED_FRAMING_CHARS.user;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function fitsSingleSummarizationRequest(params: {
  inputTokens: number;
  contextWindow: number;
  summaryOutputTokens?: number;
}): boolean {
  return (
    params.inputTokens * SAFETY_MARGIN +
      SUMMARIZATION_OVERHEAD_TOKENS +
      (params.summaryOutputTokens ?? 0) <=
    params.contextWindow
  );
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

  forEachCompactionMessageGroup(params.messages, perMessageTokens, (start, end) => {
    let omitToolBatch = false;
    for (let index = start; index < end; index++) {
      const message = params.messages[index]!;
      const tokens = perMessageTokens[index]!;
      if (tokens * SAFETY_MARGIN > oversizedThreshold) {
        oversizedNotes.push(
          `[Large ${message.role} (~${Math.round(tokens / 1000)}K tokens) omitted from summary]`,
        );
        omitToolBatch ||= message.role === "assistant" || message.role === "toolResult";
      }
    }
    // Displaced real user turns survive even when their surrounding tool batch cannot.
    for (let index = start; index < end; index++) {
      if (perMessageTokens[index]! * SAFETY_MARGIN > oversizedThreshold) {
        continue;
      }
      const message = params.messages[index]!;
      if (!omitToolBatch || (message.role !== "assistant" && message.role !== "toolResult")) {
        smallMessages.push(message);
      }
    }
  });

  return { smallMessages, oversizedNotes };
}

/** Plans whether to split a summarization stage based on message count and token budget. */
export function buildStageSplitPlan(params: {
  messages: AgentMessage[];
  maxChunkTokens: number;
  parts?: number;
  minMessagesForSplit?: number;
  contextWindow?: number;
  summaryOutputTokens?: number;
}): StageSplitPlan {
  const minMessagesForSplit = Math.max(2, params.minMessagesForSplit ?? 4);
  const parts = normalizeCompactionParts(params.parts ?? DEFAULT_PARTS, params.messages.length);
  const perMessageTokens = estimatePerMessageTokens(params.messages);
  const totalTokens = perMessageTokens.reduce((sum, tokens) => sum + tokens, 0);
  if (
    parts <= 1 ||
    params.messages.length < minMessagesForSplit ||
    totalTokens <= params.maxChunkTokens
  ) {
    return { mode: "single", fitsWholeRequest: false };
  }

  if (
    params.contextWindow !== undefined &&
    fitsSingleSummarizationRequest({
      inputTokens: totalTokens + estimateSerializationOverheadTokens(params.messages),
      contextWindow: params.contextWindow,
      summaryOutputTokens: params.summaryOutputTokens,
    })
  ) {
    return { mode: "single", fitsWholeRequest: true };
  }
  const chunks = chunkCompactionMessageGroups(
    params.messages,
    totalTokens / parts,
    perMessageTokens,
    parts,
  );
  return chunks.length > 1
    ? { mode: "split", chunks }
    : { mode: "single", fitsWholeRequest: false };
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

  const parts = normalizeCompactionParts(params.parts ?? DEFAULT_PARTS, keptMessages.length);
  const originalMessageIndexes = new Map(
    params.messages.map((message, index) => [message, index] as const),
  );

  while (keptMessages.length > 0) {
    const splitPlan = buildStageSplitPlan({
      messages: keptMessages,
      maxChunkTokens: budgetTokens,
      minMessagesForSplit: 2,
      parts,
    });
    if (splitPlan.mode === "single") {
      break;
    }
    const dropped = splitPlan.chunks[0]!;
    // Dropping a call owner also drops orphaned results; providers reject replay without the pair.
    const retained = splitPlan.chunks.slice(1).flat();
    const repairReport = repairToolUseResultPairing(retained);
    const repairedDropped = repairReport.discarded;

    droppedChunks += 1;
    allDroppedMessages.push(...dropped, ...repairedDropped);
    keptMessages = repairReport.messages;
  }

  allDroppedMessages.sort(
    (left, right) =>
      (originalMessageIndexes.get(left) ?? params.messages.length) -
      (originalMessageIndexes.get(right) ?? params.messages.length),
  );

  return {
    messages: keptMessages,
    droppedMessagesList: allDroppedMessages,
    droppedChunks,
    droppedMessages: allDroppedMessages.length,
    droppedTokens: estimateMessagesTokens(allDroppedMessages),
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
