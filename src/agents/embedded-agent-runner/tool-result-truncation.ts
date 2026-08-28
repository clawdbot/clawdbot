import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { parseDurationMs } from "../../cli/parse-duration.js";
import type { AgentContextPruningConfig } from "../../config/types.agent-defaults.js";
import { createDedupeCache } from "../../infra/dedupe.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { TextContent } from "../../llm/types.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../glob-pattern.js";
import type { AgentMessage } from "../runtime/index.js";
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
import { dropThinkingBlocks } from "./thinking.js";
import {
  estimateToolResultTextChars,
  sliceToolResultTextTailToBudget,
  sliceToolResultTextToBudget,
} from "./tool-result-text-budget.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";
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
const CACHE_TTL_IMAGE_CHARS = 8_000;
const CACHE_TTL_IMAGE_MARKER = "[image removed during context pruning]";
const CACHE_TTL_DEFAULT_PLACEHOLDER = "[Old tool result content cleared]";

type CacheTtlPruningSettings = {
  ttlMs: number;
  hardClear: boolean;
  placeholder: string;
  isToolPrunable: (toolName: string) => boolean;
};
type CacheTtlToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

export function resolveCacheTtlPruningSettings(
  config: AgentContextPruningConfig | undefined,
): CacheTtlPruningSettings | undefined {
  if (config?.mode !== "cache-ttl") {
    return undefined;
  }
  let ttlMs = 5 * 60_000;
  try {
    ttlMs = config.ttl ? parseDurationMs(config.ttl, { defaultUnit: "m" }) : ttlMs;
  } catch {
    // Invalid durations retain the shipped five-minute default.
  }
  const normalize = normalizeLowercaseStringOrEmpty;
  const deny = compileGlobPatterns({ raw: config.tools?.deny, normalize });
  const allow = compileGlobPatterns({ raw: config.tools?.allow, normalize });
  return {
    ttlMs,
    hardClear: config.hardClear?.enabled ?? true,
    placeholder: config.hardClear?.placeholder?.trim() || CACHE_TTL_DEFAULT_PLACEHOLDER,
    isToolPrunable: (toolName) => {
      const normalized = normalize(toolName);
      return (
        !matchesAnyGlobPattern(normalized, deny) &&
        (allow.length === 0 || matchesAnyGlobPattern(normalized, allow))
      );
    },
  };
}

function cacheTtlText(block: unknown, serializeMalformed = true): string | undefined {
  if (!isRecord(block) || block.type !== "text") {
    return undefined;
  }
  if (typeof block.text === "string") {
    return block.text;
  }
  if (!serializeMalformed) {
    return undefined;
  }
  try {
    return JSON.stringify(block) ?? "[malformed text block]";
  } catch {
    return "[malformed text block]";
  }
}

function cacheTtlMessageChars(message: AgentMessage): number {
  if (message.role === "user" && typeof message.content === "string") {
    return estimateStringChars(message.content);
  }
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
    return 256;
  }
  const content = Array.isArray(message.content) ? message.content : [];
  return content.reduce((chars, block) => {
    if (!isRecord(block)) {
      return chars;
    }
    const text = cacheTtlText(block, message.role !== "assistant");
    if (text !== undefined) {
      return chars + estimateStringChars(text);
    }
    if (block.type === "image") {
      return chars + CACHE_TTL_IMAGE_CHARS;
    }
    if (message.role !== "assistant") {
      return chars;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "thinking" || record.type === "redacted_thinking") {
      const values = [
        record.thinking,
        record.thinkingSignature,
        ...(record.type === "redacted_thinking" ? [record.data] : []),
      ];
      return values.reduce<number>(
        (sum, value) => sum + (typeof value === "string" ? estimateStringChars(value) : 0),
        chars,
      );
    }
    if (record.type !== "toolCall") {
      return chars;
    }
    try {
      return chars + JSON.stringify(record.arguments ?? {}).length;
    } catch {
      return chars + 128;
    }
  }, 0);
}

function softPruneCacheTtlToolResult(
  message: CacheTtlToolResultMessage,
): CacheTtlToolResultMessage {
  const content = Array.isArray(message.content) ? message.content : [];
  const hasImage = content.some((block) => isRecord(block) && block.type === "image");
  const text = content
    .flatMap(
      (block) =>
        cacheTtlText(block) ??
        (isRecord(block) && block.type === "image" ? CACHE_TTL_IMAGE_MARKER : []),
    )
    .join("\n");
  if (!hasImage && text.length <= 4_000) {
    return message;
  }
  const projected =
    text.length <= 4_000
      ? text
      : `${sliceUtf16Safe(text, 0, 1_500)}\n...\n${sliceUtf16Safe(text, -1_500)}\n\n` +
        `[Tool result trimmed: kept first 1500 chars and last 1500 chars of ${text.length} chars.]`;
  return { ...message, content: [{ type: "text", text: projected }] };
}

/** Projects expired cache-TTL history without mutating the transcript. */
export function pruneExpiredCacheTtlToolResults(params: {
  messages: AgentMessage[];
  settings: CacheTtlPruningSettings;
  contextWindowTokens: number;
  lastCacheTouchAt: number | null;
  dropThinkingBlocksForEstimate: boolean;
  now: number;
}): AgentMessage[] {
  const { messages, settings } = params;
  if (
    !params.lastCacheTouchAt ||
    settings.ttlMs <= 0 ||
    params.now - params.lastCacheTouchAt < settings.ttlMs
  ) {
    return messages;
  }
  const cutoff =
    messages.flatMap((message, index) => (message.role === "assistant" ? [index] : [])).at(-3) ??
    -1;
  const start = messages.findIndex((message) => message.role === "user");
  if (cutoff < 0 || start < 0) {
    return messages;
  }
  const estimate = params.dropThinkingBlocksForEstimate ? dropThinkingBlocks(messages) : messages;
  let totalChars = estimate.reduce((sum, message) => sum + cacheTtlMessageChars(message), 0);
  const charWindow = params.contextWindowTokens * 4;
  if (totalChars / charWindow < 0.3) {
    return messages;
  }
  let next: AgentMessage[] | undefined;
  const eligible: number[] = [];
  for (let index = start; index < cutoff; index++) {
    const message = messages[index];
    if (
      message?.role !== "toolResult" ||
      !settings.isToolPrunable(typeof message.toolName === "string" ? message.toolName : "")
    ) {
      continue;
    }
    eligible.push(index);
    const projected = softPruneCacheTtlToolResult(message);
    if (projected !== message) {
      totalChars += cacheTtlMessageChars(projected) - cacheTtlMessageChars(message);
      (next ??= messages.slice())[index] = projected;
    }
  }
  const output = next ?? messages;
  if (
    totalChars / charWindow < 0.5 ||
    !settings.hardClear ||
    eligible.reduce((sum, index) => sum + cacheTtlMessageChars(output[index]!), 0) < 50_000
  ) {
    return output;
  }
  for (const index of eligible) {
    if (totalChars / charWindow < 0.5) {
      break;
    }
    const message = (next ?? messages)[index] as AgentMessage;
    const cleared = {
      ...message,
      content: [{ type: "text", text: settings.placeholder }],
    } as AgentMessage;
    totalChars += cacheTtlMessageChars(cleared) - cacheTtlMessageChars(message);
    (next ??= messages.slice())[index] = cleared;
  }
  return next ?? messages;
}

const MIN_KEEP_CHARS = 2_000;
const RECOVERY_MIN_KEEP_CHARS = 0;
const TOOL_RESULT_WARNING_DEDUPE_LIMIT = 1_024;
export const toolResultWarningDedupe = {
  promptPressure: createDedupeCache({ ttlMs: 0, maxSize: TOOL_RESULT_WARNING_DEDUPE_LIMIT }),
  sessionRecovery: createDedupeCache({ ttlMs: 0, maxSize: TOOL_RESULT_WARNING_DEDUPE_LIMIT }),
};

type ToolResultTruncationOptions = {
  suffix?: string | ((truncatedChars: number) => string);
  minKeepChars?: number;
  minimumRawWeight?: number;
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
  if (
    params.aggregateReplacementCount <= 0 ||
    toolResultWarningDedupe.sessionRecovery.check(sessionLogKey)
  ) {
    log.info(message);
    return;
  }
  log.warn(
    `${message}; aggregate tool-result pressure detected; consider /compact or /new if pressure persists`,
  );
}

function resolveSuffixFactory(
  suffix: ToolResultTruncationOptions["suffix"],
): (truncatedChars: number) => string {
  return typeof suffix === "function"
    ? suffix
    : typeof suffix === "string"
      ? () => suffix
      : DEFAULT_SUFFIX;
}

function resolveEffectiveMinKeepChars(params: {
  maxChars: number;
  minKeepChars: number;
  suffixFactory: (truncatedChars: number) => string;
  minimumRawWeight?: number;
}): number {
  const suffixFloor = estimateToolResultTextChars(params.suffixFactory(1), {
    minimumRawWeight: params.minimumRawWeight,
  });
  return Math.max(0, Math.min(params.minKeepChars, Math.max(0, params.maxChars - suffixFloor)));
}

function appendBoundedTruncationSuffix(params: {
  keptText: string;
  originalTextLength: number;
  maxChars: number;
  suffixFactory: (truncatedChars: number) => string;
  minimumRawWeight?: number;
}): string {
  let keptText = params.keptText;
  const budgetOptions = { minimumRawWeight: params.minimumRawWeight };
  while (true) {
    const suffix = params.suffixFactory(Math.max(1, params.originalTextLength - keptText.length));
    const suffixChars = estimateToolResultTextChars(suffix, budgetOptions);
    if (suffixChars >= params.maxChars) {
      const fullOmissionSuffix = params.suffixFactory(Math.max(1, params.originalTextLength));
      return sliceToolResultTextToBudget(fullOmissionSuffix, params.maxChars, budgetOptions);
    }
    const nextKeptText = sliceToolResultTextToBudget(
      keptText,
      params.maxChars - suffixChars,
      budgetOptions,
    );
    const finalText = nextKeptText + suffix;
    if (
      nextKeptText.length === keptText.length &&
      estimateToolResultTextChars(finalText, budgetOptions) <= params.maxChars
    ) {
      return finalText;
    }
    if (nextKeptText.length === 0 && keptText.length === 0) {
      return sliceToolResultTextToBudget(finalText, params.maxChars, budgetOptions);
    }
    keptText = nextKeptText;
  }
}

const MIDDLE_OMISSION_MARKER =
  "\n\n⚠️ [... middle content omitted — showing head and tail ...]\n\n";

function hasImportantTail(text: string): boolean {
  const tail = normalizeLowercaseStringOrEmpty(sliceUtf16Safe(text, -2000));
  return (
    /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)\b/.test(tail) ||
    /\}\s*$/.test(tail.trim()) ||
    /\b(total|summary|result|complete|finished|done)\b/.test(tail)
  );
}

/** Truncates text while preserving an important diagnostic tail when present. */
export function truncateToolResultText(
  text: string,
  maxChars: number,
  options: ToolResultTruncationOptions = {},
): string {
  const suffixFactory = resolveSuffixFactory(options.suffix);
  const budgetOptions = { minimumRawWeight: options.minimumRawWeight };
  const minKeepChars = resolveEffectiveMinKeepChars({
    maxChars,
    minKeepChars: options.minKeepChars ?? MIN_KEEP_CHARS,
    suffixFactory,
    minimumRawWeight: options.minimumRawWeight,
  });
  if (estimateToolResultTextChars(text, budgetOptions) <= maxChars) {
    return text;
  }
  const initialKeptText = sliceToolResultTextToBudget(text, maxChars, budgetOptions);
  const defaultSuffix = suffixFactory(Math.max(1, text.length - initialKeptText.length));
  const budget = Math.max(
    minKeepChars,
    maxChars - estimateToolResultTextChars(defaultSuffix, budgetOptions),
  );

  if (hasImportantTail(text) && budget > minKeepChars * 2) {
    const tailBudget = Math.min(Math.floor(budget * 0.3), 4_000);
    const headBudget =
      budget - tailBudget - estimateToolResultTextChars(MIDDLE_OMISSION_MARKER, budgetOptions);

    if (headBudget > minKeepChars) {
      let headText = sliceToolResultTextToBudget(text, headBudget, budgetOptions);
      const headNewline = headText.lastIndexOf("\n");
      if (headNewline > headText.length * 0.8) {
        headText = sliceUtf16Safe(headText, 0, headNewline);
      }

      let tailText = sliceToolResultTextTailToBudget(text, tailBudget, budgetOptions);
      const tailNewline = tailText.indexOf("\n");
      if (tailNewline !== -1 && tailNewline < tailText.length * 0.2) {
        tailText = sliceUtf16Safe(tailText, tailNewline + 1);
      }

      if (headText.length + tailText.length < text.length) {
        return appendBoundedTruncationSuffix({
          keptText: headText + MIDDLE_OMISSION_MARKER + tailText,
          originalTextLength: text.length,
          maxChars,
          suffixFactory,
          minimumRawWeight: options.minimumRawWeight,
        });
      }
    }
  }

  let keptText = sliceToolResultTextToBudget(text, budget, budgetOptions);
  const lastNewline = keptText.lastIndexOf("\n");
  if (lastNewline > keptText.length * 0.8) {
    keptText = sliceUtf16Safe(keptText, 0, lastNewline);
  }
  return appendBoundedTruncationSuffix({
    keptText,
    originalTextLength: text.length,
    maxChars,
    suffixFactory,
    minimumRawWeight: options.minimumRawWeight,
  });
}

const calculateMaxToolResultChars = (contextWindowTokens: number) =>
  calculateMaxToolResultCharsWithCap(
    contextWindowTokens,
    resolveAutoLiveToolResultMaxChars(contextWindowTokens),
  );

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
  // Match the 0.5 safeguard/mid-turn pressure invariant so truncation cannot hide pressure.
  const contextShareChars = Math.floor(
    contextWindowTokens * 4 * AGGREGATE_TOOL_RESULT_CONTEXT_SHARE,
  );
  return Math.max(
    perResultMaxChars * PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER,
    contextShareChars,
  );
}

function getToolResultTextBudget(msg: AgentMessage): number {
  if (!msg || msg.role !== "toolResult") {
    return 0;
  }
  const content = (msg as { content?: unknown }).content;
  return Array.isArray(content)
    ? content.reduce(
        (total, block) =>
          total + (isToolResultTextBlock(block) ? estimateToolResultTextChars(block.text) : 0),
        0,
      )
    : 0;
}

export function truncateToolResultMessage(
  msg: AgentMessage,
  maxChars: number,
  options: ToolResultTruncationOptions = {},
): AgentMessage {
  const suffixFactory = resolveSuffixFactory(options.suffix);
  const budgetOptions = { minimumRawWeight: options.minimumRawWeight };
  const minKeepChars = resolveEffectiveMinKeepChars({
    maxChars,
    minKeepChars: options.minKeepChars ?? MIN_KEEP_CHARS,
    suffixFactory,
    minimumRawWeight: options.minimumRawWeight,
  });
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return msg;
  }

  const blockTextChars = content.map((block) =>
    isToolResultTextBlock(block) ? estimateToolResultTextChars(block.text, budgetOptions) : 0,
  );
  const totalTextChars = blockTextChars.reduce((sum, chars) => sum + chars, 0);
  if (totalTextChars <= maxChars) {
    return msg;
  }

  // A caller's raw-text safety floor changes cost, not which semantic blocks
  // are short. Reserve their actual weighted cost before shrinking larger text.
  const smallBlocks = content.map(
    (block, index) =>
      (blockTextChars[index] ?? 0) > 0 &&
      isToolResultTextBlock(block) &&
      estimateToolResultTextChars(block.text) <= minKeepChars,
  );
  const blockNoticeChars = content.map((block, index) =>
    (blockTextChars[index] ?? 0) > 0 && isToolResultTextBlock(block)
      ? estimateToolResultTextChars(suffixFactory(Math.max(1, block.text.length)), budgetOptions)
      : 0,
  );
  const smallBlockChars = blockTextChars.reduce(
    (sum, chars, index) => sum + (smallBlocks[index] ? chars : 0),
    0,
  );
  const largeBlockNoticeChars = blockNoticeChars.reduce(
    (sum, chars, index) => sum + (smallBlocks[index] ? 0 : chars),
    0,
  );
  // Preserve short semantic blocks when larger ones can retain a complete truncation notice.
  const preserveSmallBlocks = smallBlockChars + largeBlockNoticeChars <= maxChars;
  const preservedChars = preserveSmallBlocks ? smallBlockChars : 0;
  const remainingBudget = Math.max(0, maxChars - preservedChars);
  const reducibleChars = totalTextChars - preservedChars;
  const reducibleNoticeChars = preserveSmallBlocks
    ? largeBlockNoticeChars
    : blockNoticeChars.reduce((sum, chars) => sum + chars, 0);
  const noticeScale =
    reducibleNoticeChars > 0 ? Math.min(1, remainingBudget / reducibleNoticeChars) : 0;
  const distributableBudget = Math.max(0, remainingBudget - reducibleNoticeChars);

  const newContent = content.map((block: unknown, index) => {
    if (!isToolResultTextBlock(block)) {
      return block;
    }
    const textBlock = block;
    const textChars = blockTextChars[index] ?? 0;
    const preserveBlock = preserveSmallBlocks && smallBlocks[index];
    const blockShare = reducibleChars > 0 ? textChars / reducibleChars : 0;
    const noticeBudget = (blockNoticeChars[index] ?? 0) * noticeScale;
    const blockBudget = preserveBlock
      ? textChars
      : Math.floor(noticeBudget + distributableBudget * blockShare);
    const blockMinKeepChars = preserveBlock ? textChars : Math.floor(minKeepChars * blockShare);
    const truncatedText = truncateToolResultText(textBlock.text, blockBudget, {
      suffix: suffixFactory,
      minKeepChars: blockMinKeepChars,
      minimumRawWeight: options.minimumRawWeight,
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

function getToolResultSpillDetails(message: AgentMessage) {
  const details = (message as { details?: unknown }).details;
  if (!isRecord(details)) {
    return undefined;
  }
  const nestedSpill = isRecord(details.spill) ? details.spill : undefined;
  // web_fetch owns the nested contract. Exec tools still own the flat spill fields.
  const path = nestedSpill?.path ?? details.fullOutputPath;
  if (typeof path !== "string" || path.length === 0) {
    return undefined;
  }
  const chars = nestedSpill?.chars ?? details.spilledChars;
  return {
    path,
    truncated: nestedSpill?.truncated === true || details.spillTruncated === true,
    ...(typeof chars === "number" && Number.isFinite(chars)
      ? { chars: Math.max(0, Math.floor(chars)) }
      : {}),
  };
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
  const content = (message as { content?: unknown }).content;
  const footer = formatFullOutputFooter(spill.path);
  const escapedFooter = JSON.stringify(footer).slice(1, -1);
  // Preserve only paths already visible in the original footer.
  if (
    !Array.isArray(content) ||
    !content.some(
      (block) =>
        isToolResultTextBlock(block) &&
        (block.text.includes(footer) || block.text.includes(escapedFooter)),
    )
  ) {
    return undefined;
  }
  // Avoid pointing recovery at already-deleted spill files.
  if (!existsSync(spill.path)) {
    return undefined;
  }
  // The original footer already disclosed this path, so preserving it adds no disclosure.
  const kind = spill.truncated ? "partial" : "full";
  const count = spill.truncated
    ? ` (${spill.chars === undefined ? "capped content" : `first ${spill.chars} chars`})`
    : "";
  const output = `${kind} output`;
  return {
    full: `[tool result elided: ${output} preserved at ${spill.path}${count}; read it if the output is needed]`,
    compact: spill.truncated ? `[partial: ${spill.path}]` : `[read ${spill.path}]`,
    truncationSuffix: (truncatedChars) =>
      `[... ${Math.max(1, Math.floor(truncatedChars))} chars truncated; ${output} at ${spill.path}]`,
  };
}

/** Projects bounded tool-result history without mutating the transcript. */
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
  const { maxChars, aggregateBudgetChars } = resolveToolResultBudgets({
    contextWindowTokens,
    maxCharsOverride,
    aggregateMaxCharsOverride,
  });
  const sourceBranch = messages.map((message, index) => ({
    id: `message-${index}`,
    type: "message",
    message,
  }));
  const projection = projectionState
    ? projectToolResultBranch({
        branch: sourceBranch,
        projectionState,
        recordSources: true,
      })
    : undefined;
  const branch = projection?.branch ?? sourceBranch;
  const projectionKeys = projection?.keys ?? [];
  const plan = buildToolResultReplacementPlan({
    branch,
    maxChars,
    aggregateBudgetChars,
    minKeepChars: RECOVERY_MIN_KEEP_CHARS,
    protectTrailingToolResults: Boolean(projectionState),
  });
  const replacedBranch = plan.branch;
  if (projectionState) {
    for (const [index, originalMessage] of messages.entries()) {
      const projectedMessage = replacedBranch[index]?.message;
      const projectionKey = projectionKeys[index];
      if (projectionKey) {
        projectionState.frozen.add(projectionKey);
        if (
          plan.replacements.length > 0 &&
          projectedMessage &&
          projectedMessage !== originalMessage
        ) {
          projectionState.replacements.set(projectionKey, projectedMessage);
        }
      }
    }
  }
  const output = replacedBranch.map((entry) => entry.message as AgentMessage);
  return {
    messages: output.some((message, index) => message !== messages[index]) ? output : messages,
    truncatedCount: new Set(plan.replacements.map((replacement) => replacement.entryId)).size,
    aggregateTruncatedCount: plan.aggregateReplacementCount,
    aggregatePressureEngaged: plan.aggregatePressureExceeded,
    aggregateBudgetChars,
  };
}

function resolveToolResultBudgets(params: {
  contextWindowTokens: number;
  maxCharsOverride?: number;
  aggregateMaxCharsOverride?: number;
}): { maxChars: number; aggregateBudgetChars: number } {
  const maxChars = Math.max(
    1,
    params.maxCharsOverride ?? calculateMaxToolResultChars(params.contextWindowTokens),
  );
  return {
    maxChars,
    aggregateBudgetChars: Math.max(
      1,
      params.aggregateMaxCharsOverride ??
        resolveLiveToolResultAggregateMaxChars({
          contextWindowTokens: params.contextWindowTokens,
          perResultMaxChars: maxChars,
        }),
    ),
  };
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
      const count = (baseKeyCounts.get(baseKey) ?? 0) + 1;
      baseKeyCounts.set(baseKey, count);
      if (count > 1) {
        projectionState.ambiguousBaseKeys.add(baseKey);
      }
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
    // Stable identities keep ambiguous tool ids from rewriting cache-tail projections (#99495).
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

/** Drops projections whose source messages no longer exist in canonical session history. */
export function reconcileToolResultPromptProjectionState(
  messages: AgentMessage[],
  projectionState: ToolResultPromptProjectionState,
): void {
  const canonicalKeys = new Set(getToolResultProjectionKeys(messages, projectionState));
  for (const key of [
    ...projectionState.frozen,
    ...projectionState.replacements.keys(),
    ...projectionState.sourceTextByKey.keys(),
  ]) {
    if (!canonicalKeys.has(key)) {
      projectionState.frozen.delete(key);
      projectionState.replacements.delete(key);
      projectionState.sourceTextByKey.delete(key);
    }
  }
  const representedBaseKeys = new Set(messages.map(getToolResultProjectionBaseKey));
  for (const baseKey of projectionState.ambiguousBaseKeys) {
    if (!representedBaseKeys.has(baseKey)) {
      projectionState.ambiguousBaseKeys.delete(baseKey);
    }
  }
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
  const projectedText = projectedContent.flatMap((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
  );
  const currentText = getToolResultTextBlocks(message);
  if (
    (sourceText && currentText.some((text, index) => text !== sourceText[index])) ||
    currentText.length !== projectedText.length
  ) {
    return message;
  }
  let textIndex = 0;
  const mergedContent = currentContent.map((block) => {
    if (!isRecord(block) || block.type !== "text") {
      return block;
    }
    return Object.assign({}, block, { text: projectedText[textIndex++] });
  });
  return { ...message, content: mergedContent } as AgentMessage;
}

function projectToolResultBranch(params: {
  branch: ToolResultBranchEntry[];
  projectionState: ToolResultPromptProjectionState;
  frozenOnly?: boolean;
  recordSources?: boolean;
}): { branch: ToolResultBranchEntry[]; keys: Array<string | undefined> } {
  const messageEntries = params.branch.filter(
    (entry): entry is ToolResultBranchEntry & { message: AgentMessage } =>
      entry.type === "message" && entry.message !== undefined,
  );
  const keys = getToolResultProjectionKeys(
    messageEntries.map((entry) => entry.message),
    params.projectionState,
  );
  const hasFrozenProjectionBaseline = params.projectionState.frozen.size > 0;
  let messageIndex = 0;
  return {
    keys,
    branch: params.branch.map((entry) => {
      if (entry.type !== "message" || !entry.message) {
        return entry;
      }
      const key = keys[messageIndex++];
      const frozen = key !== undefined && params.projectionState.frozen.has(key);
      const projected =
        key && (!params.frozenOnly || frozen)
          ? params.projectionState.replacements.get(key)
          : undefined;
      if (key && params.recordSources && !params.projectionState.sourceTextByKey.has(key)) {
        params.projectionState.sourceTextByKey.set(key, getToolResultTextBlocks(entry.message));
      }
      const message = projected
        ? mergeProjectedToolResultMessage(
            entry.message,
            projected,
            key ? params.projectionState.sourceTextByKey.get(key) : undefined,
          )
        : entry.message;
      return {
        ...entry,
        message,
        aggregateEligible:
          !key || !frozen || (projected !== undefined && message === entry.message),
        // Reduce frozen history first so steering cannot make fresh output disappear.
        deferAggregateRecovery: key !== undefined && hasFrozenProjectionBaseline && !frozen,
      };
    }),
  };
}

function getToolResultTextBlocks(message: AgentMessage): string[] {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content)
    ? content.flatMap((block) =>
        isRecord(block) && block.type === "text"
          ? [typeof block.text === "string" ? block.text : ""]
          : [],
      )
    : [];
}

function buildAggregateToolResultReplacements(params: {
  branch: ToolResultBranchEntry[];
  spillSourceBranch?: ToolResultBranchEntry[];
  aggregateBudgetChars: number;
  minKeepChars?: number;
  protectedEntryIds?: Set<string>;
}): { replacements: ToolResultReplacement[]; pressureExceeded: boolean } {
  const minKeepChars = params.minKeepChars ?? MIN_KEEP_CHARS;
  const candidates = params.branch
    .flatMap((entry, index) => {
      const message = entry.message;
      return entry.type === "message" && message?.role === "toolResult"
        ? [
            {
              entryId: entry.id,
              message,
              spillSourceMessage: params.spillSourceBranch?.[index]?.message ?? message,
              textLength: getToolResultTextBudget(message),
              aggregateEligible: entry.aggregateEligible !== false,
              deferredByFreshProjection: entry.deferAggregateRecovery === true,
              protectedByTrailingBatch: params.protectedEntryIds?.has(entry.id) ?? false,
            },
          ]
        : [];
    })
    .filter((item) => item.textLength > 0);

  if (candidates.length < 2) {
    return { replacements: [], pressureExceeded: false };
  }

  const suffixFactory =
    minKeepChars === RECOVERY_MIN_KEEP_CHARS &&
    params.aggregateBudgetChars < candidates.length * estimateToolResultTextChars(DEFAULT_SUFFIX(1))
      ? COMPACT_RECOVERY_SUFFIX
      : DEFAULT_SUFFIX;
  const minTruncatedTextChars = minKeepChars + estimateToolResultTextChars(suffixFactory(1));

  const totalChars = candidates.reduce((sum, item) => sum + item.textLength, 0);
  if (totalChars <= params.aggregateBudgetChars) {
    return { replacements: [], pressureExceeded: false };
  }

  let remainingReduction = totalChars - params.aggregateBudgetChars;
  const replacements = new Map<string, ToolResultReplacement>();
  // Frozen projections shrink first; stable sorting preserves the original oldest-first order.
  const recoveryCandidates = candidates
    .filter((candidate) => !candidate.protectedByTrailingBatch)
    .toSorted(
      (left, right) =>
        Number(left.deferredByFreshProjection) - Number(right.deferredByFreshProjection) ||
        Number(right.aggregateEligible) - Number(left.aggregateEligible),
    );

  // Trim all older entries before clearing any, so fresh output and spill pointers stay recoverable.
  for (const clear of [false, true]) {
    for (const candidate of recoveryCandidates) {
      if (remainingReduction <= 0) {
        break;
      }
      const baseMessage = replacements.get(candidate.entryId)?.message ?? candidate.message;
      const baseTextLength = getToolResultTextBudget(baseMessage);
      if (!clear && baseTextLength <= minTruncatedTextChars) {
        continue;
      }
      const spillMarkers = resolveAggregateElisionMarkers(candidate.spillSourceMessage);
      let message: AgentMessage;
      if (clear) {
        message = clearToolResultText(
          candidate.message,
          Math.max(0, baseTextLength - remainingReduction),
          spillMarkers,
        );
      } else {
        const suffix = spillMarkers?.truncationSuffix ?? suffixFactory;
        const targetChars = Math.max(
          minTruncatedTextChars,
          baseTextLength - remainingReduction,
          estimateToolResultTextChars(suffix(1)),
        );
        message = truncateToolResultMessage(candidate.message, targetChars, {
          minKeepChars,
          suffix,
        });
      }
      const actualReduction = Math.max(0, baseTextLength - getToolResultTextBudget(message));
      if (actualReduction <= 0 && (!clear || !spillMarkers)) {
        continue;
      }
      replacements.set(candidate.entryId, { entryId: candidate.entryId, message });
      remainingReduction -= actualReduction;
    }
  }

  return { replacements: [...replacements.values()], pressureExceeded: true };
}

function getTrailingToolResultEntryIds(branch: ToolResultBranchEntry[]): Set<string> {
  const ids = new Set<string>();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message" || !entry.message) {
      if (ids.size === 0) {
        continue;
      }
      break;
    }
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
    // Keep recoverable pointers; their ~130 chars are negligible against the 64k+ floor.
    remainingTextBudget = Math.max(
      remainingTextBudget,
      estimateToolResultTextChars(spillMarkers.compact),
    );
  }
  return {
    ...message,
    content: content.map((block) => {
      if (!isToolResultTextBlock(block)) {
        return block;
      }
      const replacementText =
        [spillMarkers?.full, spillMarkers?.compact].find(
          (marker): marker is string =>
            typeof marker === "string" &&
            estimateToolResultTextChars(marker) <= remainingTextBudget,
        ) ?? sliceToolResultTextToBudget(AGGREGATE_ELISION_MARKER, remainingTextBudget);
      remainingTextBudget = Math.max(
        0,
        remainingTextBudget - estimateToolResultTextChars(replacementText),
      );
      return Object.assign({}, block, {
        text: replacementText,
        ...(typeof block.content === "string" ? { content: replacementText } : {}),
      });
    }),
  } as AgentMessage;
}

function applyToolResultReplacementsToBranch(
  branch: ToolResultBranchEntry[],
  replacements: ToolResultReplacement[],
): { branch: ToolResultBranchEntry[]; reducedChars: number } {
  if (replacements.length === 0) {
    return { branch, reducedChars: 0 };
  }
  const replacementsById = new Map(replacements.map(({ entryId, message }) => [entryId, message]));
  let reducedChars = 0;
  const nextBranch = branch.map((entry) => {
    const message = replacementsById.get(entry.id);
    if (!message || entry.type !== "message" || !entry.message) {
      return entry;
    }
    reducedChars += Math.max(
      0,
      getToolResultTextBudget(entry.message) - getToolResultTextBudget(message),
    );
    return { ...entry, message };
  });
  return { branch: nextBranch, reducedChars };
}

function buildToolResultReplacementPlan(params: {
  branch: ToolResultBranchEntry[];
  maxChars: number;
  aggregateBudgetChars: number;
  minKeepChars?: number;
  protectTrailingToolResults?: boolean;
}): {
  branch: ToolResultBranchEntry[];
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
  const oversizedReplacements = params.branch.flatMap((entry): ToolResultReplacement[] => {
    const message = entry.message;
    if (
      entry.type !== "message" ||
      message?.role !== "toolResult" ||
      getToolResultTextBudget(message) <= params.maxChars
    ) {
      return [];
    }
    const suffix = resolveAggregateElisionMarkers(message)?.truncationSuffix;
    const maxChars = Math.max(params.maxChars, suffix ? estimateToolResultTextChars(suffix(1)) : 0);
    return [
      {
        entryId: entry.id,
        message: truncateToolResultMessage(message, maxChars, {
          minKeepChars: protectedEntryIds?.has(entry.id)
            ? Math.max(minKeepChars, MIN_KEEP_CHARS)
            : minKeepChars,
          ...(suffix ? { suffix } : {}),
        }),
      },
    ];
  });
  const oversizedPhase = applyToolResultReplacementsToBranch(params.branch, oversizedReplacements);
  const aggregatePlan = buildAggregateToolResultReplacements({
    branch: oversizedPhase.branch,
    spillSourceBranch: params.branch,
    aggregateBudgetChars: params.aggregateBudgetChars,
    minKeepChars,
    protectedEntryIds,
  });
  const aggregatePhase = applyToolResultReplacementsToBranch(
    oversizedPhase.branch,
    aggregatePlan.replacements,
  );

  return {
    branch: aggregatePhase.branch,
    replacements: [...oversizedReplacements, ...aggregatePlan.replacements],
    oversizedReplacementCount: oversizedReplacements.length,
    aggregateReplacementCount: aggregatePlan.replacements.length,
    aggregatePressureExceeded: aggregatePlan.pressureExceeded,
    oversizedReducibleChars: oversizedPhase.reducedChars,
    aggregateReducibleChars: aggregatePhase.reducedChars,
  };
}

function buildRecoveryToolResultReplacementPlan(params: {
  branch: ToolResultBranchEntry[];
  contextWindowTokens: number;
  maxCharsOverride?: number;
  aggregateMaxCharsOverride?: number;
  protectTrailingToolResults?: boolean;
  projectionState?: ToolResultPromptProjectionState;
}): {
  maxChars: number;
  aggregateBudgetChars: number;
  plan: ReturnType<typeof buildToolResultReplacementPlan>;
} {
  const { maxChars, aggregateBudgetChars } = resolveToolResultBudgets(params);
  const projectedBranch = params.projectionState
    ? projectToolResultBranch({
        branch: params.branch,
        projectionState: params.projectionState,
        frozenOnly: true,
      }).branch
    : params.branch;
  const plan = buildToolResultReplacementPlan({
    branch: projectedBranch,
    maxChars,
    aggregateBudgetChars,
    minKeepChars: RECOVERY_MIN_KEEP_CHARS,
    protectTrailingToolResults: params.protectTrailingToolResults,
  });
  const replacements = params.branch.flatMap((entry, index) => {
    const finalEntry = plan.branch[index];
    if (
      entry.type !== "message" ||
      !entry.message ||
      finalEntry?.type !== "message" ||
      !finalEntry.message ||
      JSON.stringify(entry.message) === JSON.stringify(finalEntry.message)
    ) {
      return [];
    }
    return [{ entryId: entry.id, message: finalEntry.message }];
  });
  return {
    maxChars,
    aggregateBudgetChars,
    plan: {
      ...plan,
      replacements,
    },
  };
}

export function estimateToolResultReductionPotential(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
  maxCharsOverride?: number;
  aggregateMaxCharsOverride?: number;
}): ToolResultReductionPotential {
  const { messages } = params;
  const { maxChars, aggregateBudgetChars } = resolveToolResultBudgets(params);
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
    const textLength = getToolResultTextBudget(msg);
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
  projectionState?: ToolResultPromptProjectionState;
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  storePath?: string;
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
    projectionState: params.projectionState,
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
  const hasRuntimeTarget = Boolean(
    params.sessionId && params.sessionKey && params.agentId && params.storePath,
  );
  if (rewriteResult.changed && (params.sessionFile || hasRuntimeTarget)) {
    emitSessionTranscriptUpdate({
      ...(params.sessionFile ? { sessionFile: params.sessionFile } : {}),
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionId && params.sessionKey && params.agentId && params.storePath
        ? {
            target: {
              agentId: params.agentId,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              storePath: params.storePath,
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
  projectionState?: ToolResultPromptProjectionState;
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

export async function truncateOversizedToolResultsInActiveTarget(params: {
  scope: RuntimeTranscriptScope;
  contextWindowTokens: number;
  maxCharsOverride?: number;
  aggregateMaxCharsOverride?: number;
  protectTrailingToolResults?: boolean;
  projectionState?: ToolResultPromptProjectionState;
}): Promise<{ truncated: boolean; truncatedCount: number; reason?: string }> {
  try {
    const target = await resolveRuntimeTranscriptReadTarget(params.scope);
    const sessionManager = SessionManager.open(target);
    return truncateOversizedToolResultsInExistingSessionManager({
      sessionManager,
      contextWindowTokens: params.contextWindowTokens,
      maxCharsOverride: params.maxCharsOverride,
      aggregateMaxCharsOverride: params.aggregateMaxCharsOverride,
      protectTrailingToolResults: params.protectTrailingToolResults,
      projectionState: params.projectionState,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      agentId: target.agentId,
      storePath: target.storePath,
    });
  } catch (err) {
    const errMsg = formatErrorMessage(err);
    log.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
    return { truncated: false, truncatedCount: 0, reason: errMsg };
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
