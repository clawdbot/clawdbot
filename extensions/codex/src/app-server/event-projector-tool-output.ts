import {
  formatToolAggregate,
  formatToolProgressOutput,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { readString } from "./event-projector-values.js";
import { isJsonObject, type CodexThreadItem } from "./protocol.js";

export const MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM = 20;
export const TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS = 10_000;
export const TOOL_PROGRESS_ECHO_PREFIX_MIN_CHARS = 1_024;
export const TOOL_PROGRESS_ECHO_SIGNATURE_CAP = MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM + 4;
const TOOL_OUTPUT_TRUNCATION_NOTICE_PREFIX = "...(OpenClaw truncated Codex native tool output";

type ToolOutputTrimState = {
  totalLength: number;
  leadingWhitespaceLength: number;
  trailingWhitespaceLength: number;
  sawNonWhitespace: boolean;
};

export class ToolOutputAccumulator {
  private readonly prefixByItem = new Map<string, string>();
  private readonly originalLengthByItem = new Map<string, number>();
  private readonly normalizedLengthByItem = new Map<string, number>();
  private readonly trimStateByItem = new Map<string, ToolOutputTrimState>();
  private readonly truncatedItemIds = new Set<string>();
  readonly textByItem = new Map<string, string>();

  append(
    itemId: string,
    delta: string,
  ): { text: string; originalLength: number; normalizedLength: number; rawPrefix: string } {
    const previousOriginalLength =
      this.originalLengthByItem.get(itemId) ?? this.textByItem.get(itemId)?.length ?? 0;
    const originalLength = previousOriginalLength + delta.length;
    this.originalLengthByItem.set(itemId, originalLength);
    const normalizedLength = updateToolOutputTrimState(this.trimStateByItem, itemId, delta);
    this.normalizedLengthByItem.set(itemId, normalizedLength);
    // Lengths keep growing after truncation for echo matching + the notice total;
    // the stored raw prefix freezes so later deltas cannot fill UTF-16 capacity
    // recovered by backing up over a split surrogate pair.
    if (this.truncatedItemIds.has(itemId)) {
      const frozenPrefix = this.prefixByItem.get(itemId) ?? this.textByItem.get(itemId) ?? "";
      const next = appendBoundedToolTranscriptText(frozenPrefix, "", originalLength);
      this.prefixByItem.set(itemId, next.rawPrefix);
      this.textByItem.set(itemId, next.text);
      return { text: next.text, originalLength, normalizedLength, rawPrefix: next.rawPrefix };
    }
    const currentPrefix = this.prefixByItem.get(itemId) ?? this.textByItem.get(itemId) ?? "";
    const next = appendBoundedToolTranscriptText(currentPrefix, delta, originalLength);
    this.prefixByItem.set(itemId, next.rawPrefix);
    this.textByItem.set(itemId, next.text);
    if (originalLength > TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS) {
      this.truncatedItemIds.add(itemId);
    }
    return { text: next.text, originalLength, normalizedLength, rawPrefix: next.rawPrefix };
  }
}

function updateToolOutputTrimState(
  trimStateByItem: Map<string, ToolOutputTrimState>,
  itemId: string,
  delta: string,
): number {
  const state = trimStateByItem.get(itemId) ?? {
    totalLength: 0,
    leadingWhitespaceLength: 0,
    trailingWhitespaceLength: 0,
    sawNonWhitespace: false,
  };
  state.totalLength += delta.length;
  const firstNonWhitespace = delta.search(/\S/u);
  if (firstNonWhitespace === -1) {
    if (!state.sawNonWhitespace) {
      state.leadingWhitespaceLength += delta.length;
    }
    state.trailingWhitespaceLength += delta.length;
    trimStateByItem.set(itemId, state);
    return state.sawNonWhitespace
      ? state.totalLength - state.leadingWhitespaceLength - state.trailingWhitespaceLength
      : 0;
  }
  if (!state.sawNonWhitespace) {
    state.leadingWhitespaceLength += firstNonWhitespace;
    state.sawNonWhitespace = true;
  }
  state.trailingWhitespaceLength = delta.match(/\s*$/u)?.[0].length ?? 0;
  trimStateByItem.set(itemId, state);
  return state.totalLength - state.leadingWhitespaceLength - state.trailingWhitespaceLength;
}

export function toolOutputRawEchoSignature(
  text: string,
): { rawLength: number; rawPrefix: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  return {
    rawLength: trimmed.length,
    rawPrefix: trimmed.slice(0, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS),
  };
}

export function normalizeToolTranscriptArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function collectDynamicToolContentText(
  contentItems: CodexThreadItem["contentItems"],
): string {
  if (!Array.isArray(contentItems)) {
    return "";
  }
  return contentItems
    .flatMap((entry) => {
      if (!isJsonObject(entry)) {
        return [];
      }
      const text = readString(entry, "text");
      return text ? [text] : [];
    })
    .join("\n");
}

function appendBoundedToolTranscriptText(
  currentPrefix: string,
  delta: string,
  originalLength: number,
): { text: string; rawPrefix: string } {
  if (originalLength <= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS) {
    const rawPrefix = currentPrefix + delta;
    return { text: rawPrefix, rawPrefix };
  }
  const notice = toolTranscriptTruncationNotice(originalLength);
  if (notice.length >= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS) {
    return { text: notice.slice(0, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS), rawPrefix: "" };
  }
  const textBudget = TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS - notice.length;
  const remaining = Math.max(0, textBudget - currentPrefix.length);
  const prefix =
    remaining > 0 ? `${currentPrefix}${truncateUtf16Safe(delta, remaining)}` : currentPrefix;
  const rawPrefix = truncateUtf16Safe(prefix, textBudget);
  return { text: `${rawPrefix}${notice}`, rawPrefix };
}

function toolTranscriptTruncationNotice(originalLength: number): string {
  const noticeText = `${TOOL_OUTPUT_TRUNCATION_NOTICE_PREFIX}: original ${originalLength} chars, showing ${TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS}; rerun with narrower args.)`;
  return `\n${noticeText}`;
}

export function truncateToolTranscriptText(text: string, originalLength = text.length): string {
  if (
    originalLength <= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS &&
    text.length <= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS
  ) {
    return text;
  }
  const notice = toolTranscriptTruncationNotice(originalLength);
  if (notice.length >= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS) {
    return notice.slice(1, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS + 1);
  }
  const textBudget = TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS - notice.length;
  return `${truncateUtf16Safe(text, textBudget)}${notice}`;
}

export function formatToolSummary(toolName: string, meta?: string): string {
  const trimmedMeta = meta?.trim();
  return formatToolAggregate(toolName, trimmedMeta ? [trimmedMeta] : undefined, {
    markdown: true,
  });
}

export function formatToolOutput(
  toolName: string,
  meta: string | undefined,
  output: string,
): string {
  const formattedOutput = formatToolProgressOutput(output);
  if (!formattedOutput) {
    return formatToolSummary(toolName, meta);
  }
  const fence = markdownFenceForText(formattedOutput);
  return `${formatToolSummary(toolName, meta)}\n${fence}txt\n${formattedOutput}\n${fence}`;
}

function markdownFenceForText(text: string): string {
  return "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const char of value) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
      continue;
    }
    current = 0;
  }
  return longest;
}
