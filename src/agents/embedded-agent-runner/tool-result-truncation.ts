/**
 * Truncates oversized tool-result content in messages and transcripts.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { parseSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDedupeCache } from "../../infra/dedupe.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { TextContent } from "../../llm/types.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  acquireSessionWriteLock,
  type SessionWriteLockAcquireTimeoutConfig,
  resolveSessionWriteLockOptions,
} from "../session-write-lock.js";
import { SessionManager } from "../sessions/index.js";
import { formatFullOutputFooter } from "../sessions/tools/tool-contracts.js";
import {
  calculateMaxToolResultCharsWithCap,
  resolveAutoLiveToolResultMaxChars,
  resolveLiveToolResultMaxChars,
} from "../tool-result-limits.js";
import { formatContextLimitTruncationNotice } from "./context-truncation-notice.js";
import { log } from "./logger.js";
import type { ToolResultPromptProjectionState } from "./session-prompt-state.js";
import {
  createTranscriptFileStateFromPersistedEntries,
  persistTranscriptStateMutation,
  readTranscriptFileState,
  TranscriptFileState,
} from "./transcript-file-state.js";
import {
  rewriteTranscriptEntriesInSessionManager,
  rewriteTranscriptEntriesInRuntimeTranscript,
  rewriteTranscriptEntriesInState,
} from "./transcript-rewrite.js";
import {
  resolveRuntimeTranscriptReadTarget,
  type RuntimeTranscriptScope,
} from "./transcript-runtime-state.js";

export {
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  resolveLiveToolResultMaxChars,
} from "../tool-result-limits.js";
const PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER = 4;
const AGGREGATE_TOOL_RESULT_CONTEXT_SHARE = 0.5;

/**
 * Minimum characters to keep when truncating.
 * We always keep at least the first portion so the model understands
 * what was in the content.
 */
const MIN_KEEP_CHARS = 2_000;
const RECOVERY_MIN_KEEP_CHARS = 0;
const TOOL_RESULT_WARNING_DEDUPE_LIMIT = 1_024;
// Both warning paths live for the process lifetime. Keep their dedupe state
// independently bounded so one hot path cannot evict the other's sessions.
export const toolResultWarningDedupe = {
  promptPressure: createDedupeCache({ ttlMs: 0, maxSize: TOOL_RESULT_WARNING_DEDUPE_LIMIT }),
  sessionRecovery: createDedupeCache({ ttlMs: 0, maxSize: TOOL_RESULT_WARNING_DEDUPE_LIMIT }),
};

type ToolResultTruncationOptions = {
  suffix?: string | ((truncatedChars: number) => string);
  minKeepChars?: number;
};

const DEFAULT_SUFFIX = (truncatedChars: number) =>
  formatContextLimitTruncationNotice(truncatedChars);
const COMPACT_RECOVERY_SUFFIX = (truncatedChars: number) =>
  `[... ${Math.max(1, Math.floor(truncatedChars))} chars truncated; narrow args]`;
const AGGREGATE_ELISION_MARKER =
  "[tool result elided: aggregate tool-result budget exceeded; rerun the command if the output is needed]";

function logToolResultSessionTruncation(params: {
  rewrittenEntries: number;
  contextWindowTokens: number;
  maxChars: number;
  aggregateBudgetChars: number;
  oversizedReplacementCount: number;
  aggregateReplacementCount: number;
  sessionKey?: string;
  sessionId?: string;
}): void {
  const sessionLogKey = params.sessionKey ?? params.sessionId ?? "unknown";
  const message =
    `[tool-result-truncation] Truncated ${params.rewrittenEntries} tool result(s) in session ` +
    `(contextWindow=${params.contextWindowTokens} maxChars=${params.maxChars} ` +
    `aggregateBudgetChars=${params.aggregateBudgetChars} ` +
    `oversized=${params.oversizedReplacementCount} aggregate=${params.aggregateReplacementCount}) ` +
    `sessionKey=${sessionLogKey}`;
  if (params.aggregateReplacementCount <= 0) {
    log.info(message);
    return;
  }
  if (toolResultWarningDedupe.sessionRecovery.check(sessionLogKey)) {
    log.info(message);
    return;
  }
  log.warn(
    `${message}; aggregate tool-result pressure detected; consider /compact or /new if pressure persists`,
  );
}

async function readRuntimeTranscriptFileState(
  scope: RuntimeTranscriptScope,
): Promise<TranscriptFileState> {
  const target = await resolveRuntimeTranscriptReadTarget(scope);
  const sqliteMarker = parseSqliteSessionFileMarker(target.sessionFile);
  if (!sqliteMarker) {
    throw new Error("runtime transcript target is not SQLite-backed");
  }
  const events = await loadTranscriptEvents({
    agentId: sqliteMarker.agentId,
    sessionId: sqliteMarker.sessionId,
    sessionKey: target.sessionKey,
    storePath: sqliteMarker.storePath,
  });
  return createTranscriptFileStateFromPersistedEntries(events);
}

function resolveSuffixFactory(
  suffix: ToolResultTruncationOptions["suffix"],
): (truncatedChars: number) => string {
  if (typeof suffix === "function") {
    return suffix;
  }
  if (typeof suffix === "string") {
    return () => suffix;
  }
  return DEFAULT_SUFFIX;
}

function resolveEffectiveMinKeepChars(params: {
  maxChars: number;
  minKeepChars: number;
  suffixFactory: (truncatedChars: number) => string;
}): number {
  const suffixFloor = params.suffixFactory(1).length;
  return Math.max(0, Math.min(params.minKeepChars, Math.max(0, params.maxChars - suffixFloor)));
}

function appendBoundedTruncationSuffix(params: {
  keptText: string;
  originalTextLength: number;
  maxChars: number;
  suffixFactory: (truncatedChars: number) => string;
}): string {
  const build = (keptText: string) =>
    keptText + params.suffixFactory(Math.max(1, params.originalTextLength - keptText.length));

  let keptText = params.keptText;
  while (true) {
    const finalText = build(keptText);
    if (finalText.length <= params.maxChars) {
      return finalText;
    }
    if (keptText.length === 0) {
      return truncateUtf16Safe(finalText, params.maxChars);
    }
    const overflow = finalText.length - params.maxChars;
    const nextKeptText = sliceUtf16Safe(keptText, 0, Math.max(0, keptText.length - overflow));
    keptText =
      nextKeptText.length < keptText.length ? nextKeptText : sliceUtf16Safe(keptText, 0, -1);
  }
}

/**
 * Marker inserted between head and tail when using head+tail truncation.
 */
const MIDDLE_OMISSION_MARKER =
  "\n\n⚠️ [... middle content omitted — showing head and tail ...]\n\n";

/**
 * Detect whether text likely contains error/diagnostic content near the end,
 * which should be preserved during truncation.
 */
function hasImportantTail(text: string): boolean {
  // Check last ~2000 chars for error-like patterns without splitting a surrogate pair.
  const tail = normalizeLowercaseStringOrEmpty(sliceUtf16Safe(text, -2000));
  return (
    /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)\b/.test(tail) ||
    // JSON closing — if the output is JSON, the tail has closing structure
    /\}\s*$/.test(tail.trim()) ||
    // Summary/result lines often appear at the end
    /\b(total|summary|result|complete|finished|done)\b/.test(tail)
  );
}

/**
 * Truncate a single text string to fit within maxChars.
 *
 * Uses a head+tail strategy when the tail contains important content
 * (errors, results, JSON structure), otherwise preserves the beginning.
 * This ensures error messages and summaries at the end of tool output
 * aren't lost during truncation.
 */
function truncateToolResultText(
  text: string,
  maxChars: number,
  options: ToolResultTruncationOptions = {},
): string {
  const suffixFactory = resolveSuffixFactory(options.suffix);
  const minKeepChars = resolveEffectiveMinKeepChars({
    maxChars,
    minKeepChars: options.minKeepChars ?? MIN_KEEP_CHARS,
    suffixFactory,
  });
  if (text.length <= maxChars) {
    return text;
  }
  const defaultSuffix = suffixFactory(Math.max(1, text.length - maxChars));
  const budget = Math.max(minKeepChars, maxChars - defaultSuffix.length);

  // If tail looks important, split budget between head and tail
  if (hasImportantTail(text) && budget > minKeepChars * 2) {
    const tailBudget = Math.min(Math.floor(budget * 0.3), 4_000);
    const headBudget = budget - tailBudget - MIDDLE_OMISSION_MARKER.length;

    if (headBudget > minKeepChars) {
      // Find clean cut points at newline boundaries
      let headCut = headBudget;
      const headNewline = text.lastIndexOf("\n", headBudget);
      if (headNewline > headBudget * 0.8) {
        headCut = headNewline;
      }

      let tailStart = text.length - tailBudget;
      const tailNewline = text.indexOf("\n", tailStart);
      if (tailNewline !== -1 && tailNewline < tailStart + tailBudget * 0.2) {
        tailStart = tailNewline + 1;
      }

      const keptText =
        sliceUtf16Safe(text, 0, headCut) + MIDDLE_OMISSION_MARKER + sliceUtf16Safe(text, tailStart);
      return appendBoundedTruncationSuffix({
        keptText,
        originalTextLength: text.length,
        maxChars,
        suffixFactory,
      });
    }
  }

  // Default: keep the beginning
  let cutPoint = budget;
  const lastNewline = text.lastIndexOf("\n", budget);
  if (lastNewline > budget * 0.8) {
    cutPoint = lastNewline;
  }
  const keptText = sliceUtf16Safe(text, 0, cutPoint);
  return appendBoundedTruncationSuffix({
    keptText,
    originalTextLength: text.length,
    maxChars,
    suffixFactory,
  });
}

/**
 * Calculate the maximum allowed characters for a single tool result
 * based on the model's context window tokens.
 *
 * Uses a rough 4 chars ≈ 1 token heuristic (conservative for English text;
 * actual ratio varies by tokenizer).
 */
function calculateMaxToolResultChars(contextWindowTokens: number): number {
  return calculateMaxToolResultCharsWithCap(
    contextWindowTokens,
    resolveAutoLiveToolResultMaxChars(contextWindowTokens),
  );
}

export function resolveLiveToolResultAggregateMaxChars(params: {
  contextWindowTokens: number;
  perResultMaxChars?: number;
}): number {
  const perResultMaxChars = Math.max(
    1,
    Math.floor(
      params.perResultMaxChars ??
        resolveLiveToolResultMaxChars({
          contextWindowTokens: params.contextWindowTokens,
        }),
    ),
  );
  const contextWindowTokens = Number.isFinite(params.contextWindowTokens)
    ? Math.max(1, Math.floor(params.contextWindowTokens))
    : 1;
  // Aggregate truncation shares the 0.5 history-pressure invariant used by
  // safeguard compaction and the mid-turn single-result guard. If this drifts,
  // truncation can hide pressure that compaction routing should see.
  const contextShareChars = Math.floor(
    contextWindowTokens * 4 * AGGREGATE_TOOL_RESULT_CONTEXT_SHARE,
  );
  return Math.max(
    perResultMaxChars * PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER,
    contextShareChars,
  );
}

/**
 * Get the total character count of text content blocks in a tool result message.
 */
function getToolResultTextLength(msg: AgentMessage): number {
  if (!msg || (msg as { role?: string }).role !== "toolResult") {
    return 0;
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return 0;
  }
  let totalLength = 0;
  for (const block of content) {
    if (isToolResultTextBlock(block)) {
      const text = block.text;
      if (typeof text === "string") {
        totalLength += text.length;
      }
    }
  }
  return totalLength;
}

/**
 * Truncate a tool result message's text content blocks to fit within maxChars.
 * Returns a new message (does not mutate the original).
 */
export function truncateToolResultMessage(
  msg: AgentMessage,
  maxChars: number,
  options: ToolResultTruncationOptions = {},
): AgentMessage {
  const suffixFactory = resolveSuffixFactory(options.suffix);
  const minKeepChars = resolveEffectiveMinKeepChars({
    maxChars,
    minKeepChars: options.minKeepChars ?? MIN_KEEP_CHARS,
    suffixFactory,
  });
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return msg;
  }

  // Calculate total text size
  const totalTextChars = getToolResultTextLength(msg);
  if (totalTextChars <= maxChars) {
    return msg;
  }

  // Distribute the budget proportionally among text blocks
  const newContent = content.map((block: unknown) => {
    if (!isToolResultTextBlock(block)) {
      return block; // Keep non-text blocks (images) as-is
    }
    const textBlock = block;
    if (typeof textBlock.text !== "string") {
      return block;
    }
    // Proportional budget for this block
    const blockShare = textBlock.text.length / totalTextChars;
    const defaultSuffix = suffixFactory(
      Math.max(1, textBlock.text.length - Math.floor(maxChars * blockShare)),
    );
    const proportionalBudget = Math.floor(maxChars * blockShare);
    const blockBudget = Math.max(
      1,
      Math.min(maxChars, Math.max(minKeepChars + defaultSuffix.length, proportionalBudget)),
    );
    const truncatedText = truncateToolResultText(textBlock.text, blockBudget, {
      suffix: suffixFactory,
      minKeepChars,
    });
    const nextBlock = Object.assign({}, textBlock, { text: truncatedText });
    if (typeof textBlock.content === "string") {
      nextBlock.content = truncatedText;
    }
    return nextBlock;
  });

  return { ...msg, content: newContent } as AgentMessage;
}

function isToolResultTextBlock(
  block: unknown,
): block is TextContent & { content?: unknown; type: "text" | "toolResult" } {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return (
    (type === "text" || type === "toolResult") &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

type ToolResultSpillDetails = {
  path: string;
  truncated: boolean;
  chars?: number;
};

function getToolResultSpillDetails(message: AgentMessage): ToolResultSpillDetails | undefined {
  const details = (message as { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const nested = (details as { spill?: unknown }).spill;
  const nestedSpill =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : undefined;
  // web_fetch owns the nested contract. Exec tools still own the flat spill fields.
  const path = nestedSpill?.path ?? (details as { fullOutputPath?: unknown }).fullOutputPath;
  if (typeof path !== "string" || path.length === 0) {
    return undefined;
  }
  const truncated =
    nestedSpill?.truncated === true ||
    (details as { spillTruncated?: unknown }).spillTruncated === true;
  const chars = nestedSpill?.chars ?? (details as { spilledChars?: unknown }).spilledChars;
  return {
    path,
    truncated,
    ...(typeof chars === "number" && Number.isFinite(chars)
      ? { chars: Math.max(0, Math.floor(chars)) }
      : {}),
  };
}

function toolResultTextContainsFullOutputFooter(
  message: AgentMessage,
  fullOutputPath: string,
): boolean {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  const footer = formatFullOutputFooter(fullOutputPath);
  const escapedFooter = JSON.stringify(footer).slice(1, -1);
  return content.some((block: unknown) => {
    if (!isToolResultTextBlock(block)) {
      return false;
    }
    return block.text.includes(footer) || block.text.includes(escapedFooter);
  });
}

type AggregateElisionMarkers = {
  full: string;
  compact: string;
  truncationSuffix: (truncatedChars: number) => string;
};

function resolveAggregateElisionMarkers(
  message: AgentMessage,
): AggregateElisionMarkers | undefined {
  const spill = getToolResultSpillDetails(message);
  if (!spill) {
    return undefined;
  }
  // Details alone are not model-visible. Only preserve paths that already
  // appeared in the original footer, so elision discloses nothing new.
  if (!toolResultTextContainsFullOutputFooter(message, spill.path)) {
    return undefined;
  }
  // Aggregate elision is a rare recovery path, not a request hot path; one
  // existence check avoids pointing the model at already-deleted spill files.
  if (!existsSync(spill.path)) {
    return undefined;
  }
  // The path was already disclosed in the original tool footer; preserving it
  // here adds no new disclosure and only keeps recovery possible.
  if (spill.truncated) {
    const count = spill.chars === undefined ? "capped content" : `first ${spill.chars} chars`;
    return {
      full: `[tool result elided: partial output preserved at ${spill.path} (${count}); read it if the output is needed]`,
      compact: `[partial: ${spill.path}]`,
      truncationSuffix: (truncatedChars) =>
        `[... ${Math.max(1, Math.floor(truncatedChars))} chars truncated; partial output at ${spill.path}]`,
    };
  }
  return {
    full: `[tool result elided: full output preserved at ${spill.path}; read it if the output is needed]`,
    compact: `[read ${spill.path}]`,
    truncationSuffix: (truncatedChars) =>
      `[... ${Math.max(1, Math.floor(truncatedChars))} chars truncated; full output at ${spill.path}]`,
  };
}

function formatAggregateElisionText(
  remainingTextBudget: number,
  spillMarkers: AggregateElisionMarkers | undefined,
): string {
  if (remainingTextBudget <= 0) {
    return "";
  }
  if (spillMarkers?.full && spillMarkers.full.length <= remainingTextBudget) {
    return spillMarkers.full;
  }
  if (spillMarkers?.compact && spillMarkers.compact.length <= remainingTextBudget) {
    return spillMarkers.compact;
  }
  return AGGREGATE_ELISION_MARKER.slice(0, remainingTextBudget);
}

/**
 * Truncate oversized tool results in an array of messages (in-memory).
 * Returns a new array with truncated messages.
 *
 * This is used as a pre-emptive guard before sending messages to the LLM,
 * without modifying the session file.
 */
export function truncateOversizedToolResultsInMessages(
  messages: AgentMessage[],
  contextWindowTokens: number,
  maxCharsOverride?: number,
  aggregateMaxCharsOverride?: number,
  projectionState?: ToolResultPromptProjectionState,
): {
  messages: AgentMessage[];
  truncatedCount: number;
  aggregateTruncatedCount: number;
  aggregatePressureEngaged: boolean;
  aggregateBudgetChars: number;
} {
  const maxChars = Math.max(
    1,
    maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens),
  );
  const aggregateBudgetChars = calculateRecoveryAggregateToolResultChars(
    contextWindowTokens,
    maxChars,
    aggregateMaxCharsOverride,
  );
  const projectionKeys = projectionState
    ? getToolResultProjectionKeys(messages, projectionState)
    : [];
  const hasFrozenProjectionBaseline = (projectionState?.frozen.size ?? 0) > 0;
  const branch = messages.map((message, index) => {
    const projectionKey = projectionKeys[index];
    const projectedMessage = projectionKey
      ? projectionState?.replacements.get(projectionKey)
      : undefined;
    if (projectionKey && projectionState && !projectionState.sourceTextByKey.has(projectionKey)) {
      projectionState.sourceTextByKey.set(projectionKey, getToolResultTextBlocks(message));
    }
    const mergedMessage = projectedMessage
      ? mergeProjectedToolResultMessage(
          message,
          projectedMessage,
          projectionState?.sourceTextByKey.get(projectionKey ?? ""),
        )
      : message;
    return {
      id: `message-${index}`,
      type: "message",
      message: mergedMessage,
      aggregateEligible:
        !projectionKey ||
        !projectionState?.frozen.has(projectionKey) ||
        (projectedMessage !== undefined && mergedMessage === message),
      // Steering and follow-up messages can follow fresh tool results before dispatch.
      // Reduce frozen history first so message position cannot make fresh output disappear.
      deferAggregateRecovery:
        projectionKey !== undefined &&
        projectionState !== undefined &&
        hasFrozenProjectionBaseline &&
        !projectionState.frozen.has(projectionKey),
    };
  });
  const plan = buildToolResultReplacementPlan({
    branch,
    maxChars,
    aggregateBudgetChars,
    minKeepChars: RECOVERY_MIN_KEEP_CHARS,
    protectTrailingToolResults: Boolean(projectionState),
  });
  if (projectionState) {
    for (const [index] of messages.entries()) {
      const projectionKey = projectionKeys[index];
      if (projectionKey) {
        projectionState.frozen.add(projectionKey);
      }
    }
  }
  if (plan.replacements.length === 0) {
    const projectedMessages = branch.map((entry) => entry.message);
    const hasProjectedChanges = projectedMessages.some(
      (message, index) => message !== messages[index],
    );
    return {
      messages: hasProjectedChanges ? projectedMessages : messages,
      truncatedCount: 0,
      aggregateTruncatedCount: 0,
      aggregatePressureEngaged: plan.aggregatePressureExceeded,
      aggregateBudgetChars,
    };
  }

  const replacementIds = new Set(plan.replacements.map((replacement) => replacement.entryId));
  const replacedBranch = applyToolResultReplacementsToBranch(branch, plan.replacements);
  if (projectionState) {
    for (const [index, originalMessage] of messages.entries()) {
      const projectedMessage = replacedBranch[index]?.message;
      const projectionKey = projectionKeys[index];
      if (projectionKey) {
        projectionState.frozen.add(projectionKey);
        if (projectedMessage && projectedMessage !== originalMessage) {
          projectionState.replacements.set(projectionKey, projectedMessage);
        }
      }
    }
  }
  return {
    messages: replacedBranch.map((entry) => entry.message as AgentMessage),
    truncatedCount: replacementIds.size,
    aggregateTruncatedCount: plan.aggregateReplacementCount,
    aggregatePressureEngaged: plan.aggregatePressureExceeded,
    aggregateBudgetChars,
  };
}

function calculateRecoveryAggregateToolResultChars(
  contextWindowTokens: number,
  maxCharsOverride?: number,
  aggregateMaxCharsOverride?: number,
): number {
  return Math.max(
    1,
    aggregateMaxCharsOverride ??
      resolveLiveToolResultAggregateMaxChars({
        contextWindowTokens,
        perResultMaxChars: maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens),
      }),
  );
}

type ToolResultReductionPotential = {
  maxChars: number;
  aggregateBudgetChars: number;
  toolResultCount: number;
  totalToolResultChars: number;
  oversizedCount: number;
  oversizedReducibleChars: number;
  aggregateReducibleChars: number;
  maxReducibleChars: number;
};

type ToolResultBranchEntry = {
  id: string;
  type: string;
  message?: AgentMessage;
  aggregateEligible?: boolean;
  deferAggregateRecovery?: boolean;
};

type ToolResultReplacement = {
  entryId: string;
  message: AgentMessage;
};

function getToolResultProjectionBaseKey(message: AgentMessage): string | undefined {
  if (message.role !== "toolResult") {
    return undefined;
  }
  const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  const timestampKey = typeof timestamp === "number" ? `:${timestamp}` : "";
  if (typeof toolCallId === "string" && toolCallId.length > 0) {
    return `tool:${toolCallId}${timestampKey}`;
  }
  return typeof timestamp === "number" ? `timestamp:${timestamp}` : undefined;
}

function getToolResultProjectionKeys(
  messages: AgentMessage[],
  projectionState: ToolResultPromptProjectionState,
): Array<string | undefined> {
  const baseKeys = messages.map((message) => getToolResultProjectionBaseKey(message));
  const baseKeyCounts = new Map<string, number>();
  for (const baseKey of baseKeys) {
    if (baseKey) {
      baseKeyCounts.set(baseKey, (baseKeyCounts.get(baseKey) ?? 0) + 1);
    }
  }
  for (const [baseKey, count] of baseKeyCounts) {
    if (count > 1) {
      projectionState.ambiguousBaseKeys.add(baseKey);
    }
  }
  const occurrences = new Map<string, number>();
  return baseKeys.map((baseKey, index) => {
    if (baseKey && !projectionState.ambiguousBaseKeys.has(baseKey)) {
      return baseKey;
    }
    const message = messages[index];
    if (!message || message.role !== "toolResult") {
      return undefined;
    }
    // Ambiguous/missing tool ids still need a stable frozen identity; otherwise
    // each request rewrites their prompt-cache tail projection (#99495).
    const messageId = (message as { id?: unknown }).id;
    const sourceIdentity =
      typeof messageId === "string" && messageId.length > 0
        ? `id:${messageId}`
        : `text:${createHash("sha256")
            .update(JSON.stringify(getToolResultTextBlocks(message)))
            .digest("base64url")}`;
    const fallbackBase = `fallback:${baseKey ?? "tool"}:${sourceIdentity}`;
    const occurrence = occurrences.get(fallbackBase) ?? 0;
    occurrences.set(fallbackBase, occurrence + 1);
    return `${fallbackBase}:${occurrence}`;
  });
}

function mergeProjectedToolResultMessage(
  message: AgentMessage,
  projectedMessage: AgentMessage,
  sourceText: string[] | undefined,
): AgentMessage {
  if (message.role !== "toolResult" || projectedMessage.role !== "toolResult") {
    return projectedMessage;
  }
  const currentContent = (message as { content?: unknown }).content;
  const projectedContent = (projectedMessage as { content?: unknown }).content;
  if (!Array.isArray(currentContent) || !Array.isArray(projectedContent)) {
    return projectedMessage;
  }
  const projectedText = projectedContent.filter(
    (block): block is { type: "text"; text: string } =>
      Boolean(block) &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
  );
  const currentText = getToolResultTextBlocks(message);
  if (sourceText && currentText.some((text, index) => text !== sourceText[index])) {
    return message;
  }
  const currentTextCount = currentContent.filter(
    (block) =>
      Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text",
  ).length;
  if (currentTextCount !== projectedText.length) {
    return message;
  }
  let textIndex = 0;
  const mergedContent = currentContent.map((block) => {
    if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "text") {
      return block;
    }
    const projectedBlock = projectedText[textIndex++];
    return projectedBlock ? Object.assign({}, block, { text: projectedBlock.text }) : block;
  });
  return { ...message, content: mergedContent } as AgentMessage;
}

function getToolResultTextBlocks(message: AgentMessage): string[] {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) =>
    block && typeof block === "object" && (block as { type?: unknown }).type === "text"
      ? [
          typeof (block as { text?: unknown }).text === "string"
            ? (block as { text: string }).text
            : "",
        ]
      : [],
  );
}

function buildAggregateToolResultReplacements(params: {
  branch: ToolResultBranchEntry[];
  spillSourceBranch?: ToolResultBranchEntry[];
  aggregateBudgetChars: number;
  minKeepChars?: number;
  protectTrailingToolResults?: boolean;
}): { replacements: ToolResultReplacement[]; pressureExceeded: boolean } {
  const minKeepChars = params.minKeepChars ?? MIN_KEEP_CHARS;
  const protectedEntryIds = params.protectTrailingToolResults
    ? getTrailingToolResultEntryIds(params.branch)
    : new Set<string>();
  const candidates = params.branch
    .map((entry, index) => ({ entry, index }))
    .filter(
      (
        item,
      ): item is {
        entry: {
          id: string;
          type: string;
          message: AgentMessage;
          aggregateEligible?: boolean;
          deferAggregateRecovery?: boolean;
        };
        index: number;
      } =>
        item.entry.type === "message" &&
        Boolean(item.entry.message) &&
        (item.entry.message as { role?: string }).role === "toolResult",
    )
    .map((item) => ({
      index: item.index,
      entryId: item.entry.id,
      message: item.entry.message,
      spillSourceMessage: params.spillSourceBranch?.[item.index]?.message ?? item.entry.message,
      textLength: getToolResultTextLength(item.entry.message),
      aggregateEligible: item.entry.aggregateEligible !== false,
      deferredByFreshProjection: item.entry.deferAggregateRecovery === true,
      protectedByTrailingBatch: protectedEntryIds.has(item.entry.id),
    }))
    .filter((item) => item.textLength > 0);

  if (candidates.length < 2) {
    return { replacements: [], pressureExceeded: false };
  }

  const suffixFactory =
    minKeepChars === RECOVERY_MIN_KEEP_CHARS &&
    params.aggregateBudgetChars < candidates.length * DEFAULT_SUFFIX(1).length
      ? COMPACT_RECOVERY_SUFFIX
      : DEFAULT_SUFFIX;
  const minTruncatedTextChars = minKeepChars + suffixFactory(1).length;

  const totalChars = candidates.reduce((sum, item) => sum + item.textLength, 0);
  if (totalChars <= params.aggregateBudgetChars) {
    return { replacements: [], pressureExceeded: false };
  }

  let remainingReduction = totalChars - params.aggregateBudgetChars;
  const replacements: Array<{ entryId: string; message: AgentMessage }> = [];
  const aggregateRecoveryCandidates = candidates
    .filter((item) => !item.deferredByFreshProjection && !item.protectedByTrailingBatch)
    .toSorted((a, b) => {
      if (a.index !== b.index) {
        return a.index - b.index;
      }
      return b.textLength - a.textLength;
    });
  const recoveryCandidates = [
    ...aggregateRecoveryCandidates.filter((item) => item.aggregateEligible),
    // Start from frozen projections before touching deferred fresh results. Reusing their
    // projected text keeps this shrink-only and preserves prompt-cache stability.
    ...aggregateRecoveryCandidates.filter((item) => !item.aggregateEligible),
    ...candidates.filter(
      (item) => item.deferredByFreshProjection && !item.protectedByTrailingBatch,
    ),
  ];

  // Spend aggregate reduction on older entries first so fresh tool output stays intact.
  for (const candidate of recoveryCandidates) {
    if (remainingReduction <= 0) {
      break;
    }
    const reducibleChars = Math.max(0, candidate.textLength - minTruncatedTextChars);
    if (reducibleChars <= 0) {
      continue;
    }

    const requestedReduction = Math.min(reducibleChars, remainingReduction);
    const targetChars = Math.max(minTruncatedTextChars, candidate.textLength - requestedReduction);
    const spillMarkers = resolveAggregateElisionMarkers(candidate.spillSourceMessage);
    const candidateSuffixFactory = spillMarkers?.truncationSuffix ?? suffixFactory;
    const candidateTargetChars = Math.max(targetChars, candidateSuffixFactory(1).length);
    const truncatedMessage = truncateToolResultMessage(candidate.message, candidateTargetChars, {
      minKeepChars,
      suffix: candidateSuffixFactory,
    });
    const newLength = getToolResultTextLength(truncatedMessage);
    const actualReduction = Math.max(0, candidate.textLength - newLength);
    if (actualReduction <= 0) {
      continue;
    }

    replacements.push({ entryId: candidate.entryId, message: truncatedMessage });
    remainingReduction -= actualReduction;
  }

  if (remainingReduction > 0) {
    for (const candidate of recoveryCandidates) {
      if (remainingReduction <= 0) {
        break;
      }
      const existingReplacement = replacements.find(
        (replacement) => replacement.entryId === candidate.entryId,
      );
      const baseMessage = existingReplacement?.message ?? candidate.message;
      const baseTextLength = getToolResultTextLength(baseMessage);
      const targetTextChars = Math.max(0, baseTextLength - remainingReduction);
      const spillMarkers = resolveAggregateElisionMarkers(candidate.spillSourceMessage);
      const emptyMessage = clearToolResultText(candidate.message, targetTextChars, spillMarkers);
      const actualReduction = Math.max(0, baseTextLength - getToolResultTextLength(emptyMessage));
      if (actualReduction <= 0 && !spillMarkers) {
        continue;
      }
      const replacement = { entryId: candidate.entryId, message: emptyMessage };
      const existingIndex = replacements.findIndex(
        (existing) => existing.entryId === candidate.entryId,
      );
      if (existingIndex >= 0) {
        replacements[existingIndex] = replacement;
      } else {
        replacements.push(replacement);
      }
      remainingReduction -= actualReduction;
    }
  }

  return { replacements, pressureExceeded: true };
}

function getTrailingToolResultEntryIds(branch: ToolResultBranchEntry[]): Set<string> {
  const ids = new Set<string>();
  let sawMessage = false;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message" || !entry.message) {
      if (!sawMessage) {
        continue;
      }
      break;
    }
    sawMessage = true;
    if ((entry.message as { role?: string }).role !== "toolResult") {
      break;
    }
    ids.add(entry.id);
  }
  return ids;
}

function clearToolResultText(
  message: AgentMessage,
  maxTextChars = Number.POSITIVE_INFINITY,
  resolvedSpillMarkers?: AggregateElisionMarkers,
): AgentMessage {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return message;
  }
  let remainingTextBudget = Math.max(0, Math.floor(maxTextChars));
  const spillMarkers = resolvedSpillMarkers ?? resolveAggregateElisionMarkers(message);
  if (spillMarkers) {
    // The pointer is what makes elision recoverable. ~130 chars per entry is
    // negligible against the 64k+ aggregate floor, and accounting uses actual lengths.
    remainingTextBudget = Math.max(remainingTextBudget, spillMarkers.compact.length);
  }
  return {
    ...message,
    content: content.map((block) => {
      if (!isToolResultTextBlock(block)) {
        return block;
      }
      const replacementText = formatAggregateElisionText(remainingTextBudget, spillMarkers);
      remainingTextBudget = Math.max(0, remainingTextBudget - replacementText.length);
      return Object.assign({}, block, {
        text: replacementText,
        ...(typeof block.content === "string" ? { content: replacementText } : {}),
      });
    }),
  } as AgentMessage;
}

function buildOversizedToolResultReplacements(params: {
  branch: ToolResultBranchEntry[];
  maxChars: number;
  minKeepChars?: number;
  protectedEntryIds?: Set<string>;
}): ToolResultReplacement[] {
  const minKeepChars = params.minKeepChars ?? MIN_KEEP_CHARS;
  const replacements: ToolResultReplacement[] = [];

  for (const entry of params.branch) {
    if (entry.type !== "message" || !entry.message) {
      continue;
    }
    const msg = entry.message;
    if ((msg as { role?: string }).role !== "toolResult") {
      continue;
    }
    if (getToolResultTextLength(msg) <= params.maxChars) {
      continue;
    }
    const replacementMinKeepChars = params.protectedEntryIds?.has(entry.id)
      ? Math.max(minKeepChars, MIN_KEEP_CHARS)
      : minKeepChars;
    const spillMarkers = resolveAggregateElisionMarkers(msg);
    const suffixFactory = spillMarkers?.truncationSuffix;
    const maxChars = Math.max(params.maxChars, suffixFactory?.(1).length ?? 0);
    replacements.push({
      entryId: entry.id,
      message: truncateToolResultMessage(msg, maxChars, {
        minKeepChars: replacementMinKeepChars,
        ...(suffixFactory ? { suffix: suffixFactory } : {}),
      }),
    });
  }

  return replacements;
}

function calculateReplacementReduction(
  branch: ToolResultBranchEntry[],
  replacements: ToolResultReplacement[],
): number {
  if (replacements.length === 0) {
    return 0;
  }
  const branchById = new Map(branch.map((entry) => [entry.id, entry]));
  let reduction = 0;

  for (const replacement of replacements) {
    const entry = branchById.get(replacement.entryId);
    if (!entry?.message) {
      continue;
    }
    reduction += Math.max(
      0,
      getToolResultTextLength(entry.message) - getToolResultTextLength(replacement.message),
    );
  }

  return reduction;
}

function applyToolResultReplacementsToBranch(
  branch: ToolResultBranchEntry[],
  replacements: ToolResultReplacement[],
): ToolResultBranchEntry[] {
  if (replacements.length === 0) {
    return branch;
  }
  const replacementsById = new Map(
    replacements.map((replacement) => [replacement.entryId, replacement]),
  );
  return branch.map((entry) => {
    const replacement = replacementsById.get(entry.id);
    if (!replacement || entry.type !== "message") {
      return entry;
    }
    return {
      ...entry,
      message: replacement.message,
    };
  });
}

function buildToolResultReplacementPlan(params: {
  branch: ToolResultBranchEntry[];
  maxChars: number;
  aggregateBudgetChars: number;
  minKeepChars?: number;
  protectTrailingToolResults?: boolean;
}): {
  replacements: ToolResultReplacement[];
  oversizedReplacementCount: number;
  aggregateReplacementCount: number;
  aggregatePressureExceeded: boolean;
  oversizedReducibleChars: number;
  aggregateReducibleChars: number;
} {
  const minKeepChars = params.minKeepChars ?? MIN_KEEP_CHARS;
  const protectedEntryIds = params.protectTrailingToolResults
    ? getTrailingToolResultEntryIds(params.branch)
    : undefined;
  const oversizedReplacements = buildOversizedToolResultReplacements({
    branch: params.branch,
    maxChars: params.maxChars,
    minKeepChars,
    protectedEntryIds,
  });
  const oversizedReducibleChars = calculateReplacementReduction(
    params.branch,
    oversizedReplacements,
  );
  const oversizedTrimmedBranch = applyToolResultReplacementsToBranch(
    params.branch,
    oversizedReplacements,
  );
  const aggregatePlan = buildAggregateToolResultReplacements({
    branch: oversizedTrimmedBranch,
    spillSourceBranch: params.branch,
    aggregateBudgetChars: params.aggregateBudgetChars,
    minKeepChars,
    protectTrailingToolResults: params.protectTrailingToolResults,
  });
  const aggregateReplacements = aggregatePlan.replacements;
  const aggregateReducibleChars = calculateReplacementReduction(
    oversizedTrimmedBranch,
    aggregateReplacements,
  );

  return {
    replacements: [...oversizedReplacements, ...aggregateReplacements],
    oversizedReplacementCount: oversizedReplacements.length,
    aggregateReplacementCount: aggregateReplacements.length,
    aggregatePressureExceeded: aggregatePlan.pressureExceeded,
    oversizedReducibleChars,
    aggregateReducibleChars,
  };
}

function buildRecoveryToolResultReplacementPlan(params: {
  branch: ToolResultBranchEntry[];
  contextWindowTokens: number;
  maxCharsOverride?: number;
  aggregateMaxCharsOverride?: number;
  protectTrailingToolResults?: boolean;
}): {
  maxChars: number;
  aggregateBudgetChars: number;
  plan: ReturnType<typeof buildToolResultReplacementPlan>;
} {
  const maxChars = Math.max(
    1,
    params.maxCharsOverride ?? calculateMaxToolResultChars(params.contextWindowTokens),
  );
  const aggregateBudgetChars = calculateRecoveryAggregateToolResultChars(
    params.contextWindowTokens,
    maxChars,
    params.aggregateMaxCharsOverride,
  );
  return {
    maxChars,
    aggregateBudgetChars,
    plan: buildToolResultReplacementPlan({
      branch: params.branch,
      maxChars,
      aggregateBudgetChars,
      minKeepChars: RECOVERY_MIN_KEEP_CHARS,
      protectTrailingToolResults: params.protectTrailingToolResults,
    }),
  };
}

export function estimateToolResultReductionPotential(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
  maxCharsOverride?: number;
  aggregateMaxCharsOverride?: number;
}): ToolResultReductionPotential {
  const { messages, contextWindowTokens } = params;
  const maxChars = Math.max(
    1,
    params.maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens),
  );
  const aggregateBudgetChars = calculateRecoveryAggregateToolResultChars(
    contextWindowTokens,
    maxChars,
    params.aggregateMaxCharsOverride,
  );
  const branch = messages.map((message, index) => ({
    id: `message-${index}`,
    type: "message",
    message,
  }));

  let toolResultCount = 0;
  let totalToolResultChars = 0;
  for (const msg of messages) {
    if ((msg as { role?: string }).role !== "toolResult") {
      continue;
    }
    const textLength = getToolResultTextLength(msg);
    if (textLength <= 0) {
      continue;
    }
    toolResultCount += 1;
    totalToolResultChars += textLength;
  }
  const plan = buildToolResultReplacementPlan({
    branch,
    maxChars,
    aggregateBudgetChars,
    minKeepChars: RECOVERY_MIN_KEEP_CHARS,
  });
  const maxReducibleChars = plan.oversizedReducibleChars + plan.aggregateReducibleChars;

  return {
    maxChars,
    aggregateBudgetChars,
    toolResultCount,
    totalToolResultChars,
    oversizedCount: plan.oversizedReplacementCount,
    oversizedReducibleChars: plan.oversizedReducibleChars,
    aggregateReducibleChars: plan.aggregateReducibleChars,
    maxReducibleChars,
  };
}

function truncateOversizedToolResultsInExistingSessionManager(params: {
  sessionManager: SessionManager;
  contextWindowTokens: number;
  maxCharsOverride?: number;
  aggregateMaxCharsOverride?: number;
  protectTrailingToolResults?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): { truncated: boolean; truncatedCount: number; reason?: string } {
  const { sessionManager, contextWindowTokens } = params;
  const branch = sessionManager.getBranch() as ToolResultBranchEntry[];

  if (branch.length === 0) {
    return { truncated: false, truncatedCount: 0, reason: "empty session" };
  }

  const { maxChars, aggregateBudgetChars, plan } = buildRecoveryToolResultReplacementPlan({
    branch,
    contextWindowTokens,
    maxCharsOverride: params.maxCharsOverride,
    aggregateMaxCharsOverride: params.aggregateMaxCharsOverride,
    protectTrailingToolResults: params.protectTrailingToolResults,
  });
  if (plan.replacements.length === 0) {
    return {
      truncated: false,
      truncatedCount: 0,
      reason: "no oversized or aggregate tool results",
    };
  }
  const rewriteResult = rewriteTranscriptEntriesInSessionManager({
    sessionManager,
    replacements: plan.replacements,
  });
  if (rewriteResult.changed && params.sessionFile) {
    emitSessionTranscriptUpdate({
      sessionFile: params.sessionFile,
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionId && params.sessionKey && params.agentId
        ? {
            target: {
              agentId: params.agentId,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
            },
          }
        : {}),
    });
  }

  logToolResultSessionTruncation({
    rewrittenEntries: rewriteResult.rewrittenEntries,
    contextWindowTokens,
    maxChars,
    aggregateBudgetChars,
    oversizedReplacementCount: plan.oversizedReplacementCount,
    aggregateReplacementCount: plan.aggregateReplacementCount,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  });

  return {
    truncated: rewriteResult.changed,
    truncatedCount: rewriteResult.rewrittenEntries,
    reason: rewriteResult.reason,
  };
}

async function truncateOversizedToolResultsInTranscriptState(params: {
  state: TranscriptFileState;
  sessionFile: string;
  contextWindowTokens: number;
  maxCharsOverride?: number;
  aggregateMaxCharsOverride?: number;
  protectTrailingToolResults?: boolean;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<{ truncated: boolean; truncatedCount: number; reason?: string }> {
  const { state, contextWindowTokens } = params;
  const branch = state.getBranch() as ToolResultBranchEntry[];

  if (branch.length === 0) {
    return { truncated: false, truncatedCount: 0, reason: "empty session" };
  }

  const { maxChars, aggregateBudgetChars, plan } = buildRecoveryToolResultReplacementPlan({
    branch,
    contextWindowTokens,
    maxCharsOverride: params.maxCharsOverride,
    aggregateMaxCharsOverride: params.aggregateMaxCharsOverride,
    protectTrailingToolResults: params.protectTrailingToolResults,
  });
  if (plan.replacements.length === 0) {
    return {
      truncated: false,
      truncatedCount: 0,
      reason: "no oversized or aggregate tool results",
    };
  }
  const rewriteResult = rewriteTranscriptEntriesInState({
    state,
    replacements: plan.replacements,
  });
  if (rewriteResult.changed) {
    await persistTranscriptStateMutation({
      sessionFile: params.sessionFile,
      state,
      appendedEntries: rewriteResult.appendedEntries,
    });
    emitSessionTranscriptUpdate({
      sessionFile: params.sessionFile,
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionId && params.sessionKey && params.agentId
        ? {
            target: {
              agentId: params.agentId,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
            },
          }
        : {}),
    });
  }

  logToolResultSessionTruncation({
    rewrittenEntries: rewriteResult.rewrittenEntries,
    contextWindowTokens,
    maxChars,
    aggregateBudgetChars,
    oversizedReplacementCount: plan.oversizedReplacementCount,
    aggregateReplacementCount: plan.aggregateReplacementCount,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  });

  return {
    truncated: rewriteResult.changed,
    truncatedCount: rewriteResult.rewrittenEntries,
    reason: rewriteResult.reason,
  };
}

export function truncateOversizedToolResultsInSessionManager(params: {
  sessionManager: SessionManager;
  contextWindowTokens: number;
  maxCharsOverride?: number;
  aggregateMaxCharsOverride?: number;
  protectTrailingToolResults?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): { truncated: boolean; truncatedCount: number; reason?: string } {
  try {
    return truncateOversizedToolResultsInExistingSessionManager(params);
  } catch (err) {
    const errMsg = formatErrorMessage(err);
    log.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
    return { truncated: false, truncatedCount: 0, reason: errMsg };
  }
}

/**
 * Truncates oversized tool results in the active runtime transcript.
 */
async function truncateOversizedToolResultsInRuntimeTranscript(params: {
  scope: RuntimeTranscriptScope;
  contextWindowTokens: number;
  maxCharsOverride?: number;
  aggregateMaxCharsOverride?: number;
  protectTrailingToolResults?: boolean;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<{ truncated: boolean; truncatedCount: number; reason?: string }> {
  try {
    const state = await readRuntimeTranscriptFileState(params.scope);
    const { contextWindowTokens } = params;
    const branch = state.getBranch() as ToolResultBranchEntry[];

    if (branch.length === 0) {
      return { truncated: false, truncatedCount: 0, reason: "empty session" };
    }

    const { maxChars, aggregateBudgetChars, plan } = buildRecoveryToolResultReplacementPlan({
      branch,
      contextWindowTokens,
      maxCharsOverride: params.maxCharsOverride,
      aggregateMaxCharsOverride: params.aggregateMaxCharsOverride,
      protectTrailingToolResults: params.protectTrailingToolResults,
    });
    if (plan.replacements.length === 0) {
      return {
        truncated: false,
        truncatedCount: 0,
        reason: "no oversized or aggregate tool results",
      };
    }

    const rewriteResult = await rewriteTranscriptEntriesInRuntimeTranscript({
      scope: params.scope,
      request: { replacements: plan.replacements },
      config: params.config,
    });

    logToolResultSessionTruncation({
      rewrittenEntries: rewriteResult.rewrittenEntries,
      contextWindowTokens,
      maxChars,
      aggregateBudgetChars,
      oversizedReplacementCount: plan.oversizedReplacementCount,
      aggregateReplacementCount: plan.aggregateReplacementCount,
      sessionKey: params.scope.sessionKey,
      sessionId: params.scope.sessionId,
    });

    return {
      truncated: rewriteResult.changed,
      truncatedCount: rewriteResult.rewrittenEntries,
      reason: rewriteResult.reason,
    };
  } catch (err) {
    const errMsg = formatErrorMessage(err);
    log.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
    return { truncated: false, truncatedCount: 0, reason: errMsg };
  }
}

/** Truncates oversized tool results in either a SQLite runtime target or explicit file target. */
export async function truncateOversizedToolResultsInActiveTarget(params: {
  scope: RuntimeTranscriptScope;
  contextWindowTokens: number;
  maxCharsOverride?: number;
  aggregateMaxCharsOverride?: number;
  protectTrailingToolResults?: boolean;
  config?: OpenClawConfig;
}): Promise<{ truncated: boolean; truncatedCount: number; reason?: string }> {
  if (parseSqliteSessionFileMarker(params.scope.sessionFile)) {
    return await truncateOversizedToolResultsInRuntimeTranscript(params);
  }
  if (!params.scope.sessionFile) {
    return {
      truncated: false,
      truncatedCount: 0,
      reason: "no session file",
    };
  }
  return await truncateOversizedToolResultsInSession({
    sessionFile: params.scope.sessionFile,
    contextWindowTokens: params.contextWindowTokens,
    maxCharsOverride: params.maxCharsOverride,
    aggregateMaxCharsOverride: params.aggregateMaxCharsOverride,
    protectTrailingToolResults: params.protectTrailingToolResults,
    sessionId: params.scope.sessionId,
    sessionKey: params.scope.sessionKey,
    agentId: params.scope.agentId,
    config: params.config,
  });
}

/**
 * Truncates a named transcript file artifact.
 */
async function truncateOversizedToolResultsInSession(params: {
  sessionFile: string;
  contextWindowTokens: number;
  maxCharsOverride?: number;
  aggregateMaxCharsOverride?: number;
  protectTrailingToolResults?: boolean;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<{ truncated: boolean; truncatedCount: number; reason?: string }> {
  const { sessionFile, contextWindowTokens } = params;
  let sessionLock: Awaited<ReturnType<typeof acquireSessionWriteLock>> | undefined;

  try {
    sessionLock = await acquireSessionWriteLock({
      sessionFile,
      ...resolveSessionWriteLockOptions(params.config),
    });
    const state = await readTranscriptFileState(sessionFile);
    return await truncateOversizedToolResultsInTranscriptState({
      state,
      contextWindowTokens,
      maxCharsOverride: params.maxCharsOverride,
      aggregateMaxCharsOverride: params.aggregateMaxCharsOverride,
      protectTrailingToolResults: params.protectTrailingToolResults,
      sessionFile,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
  } catch (err) {
    const errMsg = formatErrorMessage(err);
    log.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
    return { truncated: false, truncatedCount: 0, reason: errMsg };
  } finally {
    await sessionLock?.release();
  }
}

export function sessionLikelyHasOversizedToolResults(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
  maxCharsOverride?: number;
}): boolean {
  const estimate = estimateToolResultReductionPotential(params);
  return estimate.oversizedCount > 0 || estimate.aggregateReducibleChars > 0;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
