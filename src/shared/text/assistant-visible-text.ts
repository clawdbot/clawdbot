import { normalizeLowercaseStringOrEmpty } from "../string-coerce.js";
import { findCodeRegions, isInsideCode } from "./code-regions.js";
import { stripModelSpecialTokens } from "./model-special-tokens.js";
import { stripPlainTextToolCallBlocks } from "./plain-text-tool-call-blocks.js";
import {
  stripReasoningTagsFromText,
  type ReasoningTagMode,
  type ReasoningTagTrim,
} from "./reasoning-tags.js";

const MEMORY_TAG_RE = /<\s*(\/?)\s*relevant[-_]memories\b[^<>]*>/gi;
const MEMORY_TAG_QUICK_RE = /<\s*\/?\s*relevant[-_]memories\b/i;
const LEGACY_BRACKET_TOOL_BLOCK_QUICK_RE = /\[\s*\/?\s*TOOL_(?:CALL|RESULT)\s*\]/i;

/**
 * Strip XML-style tool call tags that models sometimes emit as plain text.
 * This stateful pass hides content from an opening tag through the matching
 * closing tag, or to end-of-string if the stream was truncated mid-tag.
 */
const TOOL_CALL_QUICK_RE =
  /<\s*\/?\s*(?:tool_call|tool_result|function_calls?|function|tool_calls)\b/i;
const TOOL_CALL_TAG_NAMES = new Set([
  "tool_call",
  "tool_result",
  "function_call",
  "function_calls",
  "function",
  "tool_calls",
]);
const TOOL_CALL_JSON_PAYLOAD_START_RE =
  /^(?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))*\s*(?:\r?\n\s*)?[[{]/;
const TOOL_CALL_XML_PAYLOAD_START_RE =
  /^\s*(?:\r?\n\s*)?<(?:function_call|tool_call|function|invoke|parameters?|arguments?)\b/i;
const NESTED_JSON_TOOL_CALL_PAYLOAD_START_RE = /^\s*(?:\r?\n\s*)?<(?:function_call|tool_call)\b/i;

type ToolCallPayloadKind = "json" | "xml" | null;

function endsInsideQuotedString(text: string, start: number, end: number): boolean {
  let quoteChar: "'" | '"' | null = null;
  let isEscaped = false;

  for (let idx = start; idx < end; idx += 1) {
    const char = text[idx];
    if (quoteChar === null) {
      if (char === '"' || char === "'") {
        quoteChar = char;
      }
      continue;
    }

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === "\\") {
      isEscaped = true;
      continue;
    }

    if (char === quoteChar) {
      quoteChar = null;
    }
  }

  return quoteChar !== null;
}

interface ParsedToolCallTag {
  contentStart: number;
  end: number;
  isClose: boolean;
  isSelfClosing: boolean;
  tagName: string;
  isTruncated: boolean;
}

function isToolCallBoundary(char: string | undefined): boolean {
  return !char || /\s/.test(char) || char === "/" || char === ">";
}

function findTagCloseIndex(text: string, start: number): number {
  let quoteChar: "'" | '"' | null = null;
  let isEscaped = false;

  for (let idx = start; idx < text.length; idx += 1) {
    const char = text[idx];
    if (quoteChar !== null) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === "\\") {
        isEscaped = true;
        continue;
      }
      if (char === quoteChar) {
        quoteChar = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quoteChar = char;
      continue;
    }
    if (char === "<") {
      return -1;
    }
    if (char === ">") {
      return idx;
    }
  }

  return -1;
}

function detectToolCallPayloadKind(text: string, start: number): ToolCallPayloadKind {
  const rest = text.slice(start);
  if (TOOL_CALL_JSON_PAYLOAD_START_RE.test(rest)) {
    return "json";
  }
  if (TOOL_CALL_XML_PAYLOAD_START_RE.test(rest)) {
    return "xml";
  }
  return null;
}

function startsWithNestedJsonToolCallPayload(text: string, start: number): boolean {
  if (!NESTED_JSON_TOOL_CALL_PAYLOAD_START_RE.test(text.slice(start))) {
    return false;
  }
  let cursor = start;
  while (cursor < text.length && /\s/.test(text[cursor])) {
    cursor += 1;
  }
  const nestedTag = parseToolCallTagAt(text, cursor);
  if (
    !nestedTag ||
    nestedTag.isClose ||
    nestedTag.isSelfClosing ||
    nestedTag.isTruncated ||
    (nestedTag.tagName !== "function_call" && nestedTag.tagName !== "tool_call")
  ) {
    return false;
  }
  return TOOL_CALL_JSON_PAYLOAD_START_RE.test(text.slice(nestedTag.end));
}

function isLikelyStandaloneFunctionToolCall(
  text: string,
  tagStart: number,
  tag: ParsedToolCallTag,
): boolean {
  if (tag.tagName !== "function" || tag.isClose || tag.isSelfClosing || tag.isTruncated) {
    return false;
  }

  if (!/\bname\s*=/.test(text.slice(tag.contentStart, tag.end))) {
    return false;
  }

  let idx = tagStart - 1;
  while (idx >= 0 && (text[idx] === " " || text[idx] === "\t")) {
    idx -= 1;
  }

  return idx < 0 || text[idx] === "\n" || text[idx] === "\r" || /[.!?:]/.test(text[idx]);
}

function parseToolCallTagAt(text: string, start: number): ParsedToolCallTag | null {
  if (text[start] !== "<") {
    return null;
  }

  let cursor = start + 1;
  while (cursor < text.length && /\s/.test(text[cursor])) {
    cursor += 1;
  }

  let isClose = false;
  if (text[cursor] === "/") {
    isClose = true;
    cursor += 1;
    while (cursor < text.length && /\s/.test(text[cursor])) {
      cursor += 1;
    }
  }

  const nameStart = cursor;
  while (cursor < text.length && /[A-Za-z_]/.test(text[cursor])) {
    cursor += 1;
  }

  const tagName = normalizeLowercaseStringOrEmpty(text.slice(nameStart, cursor));
  if (!TOOL_CALL_TAG_NAMES.has(tagName) || !isToolCallBoundary(text[cursor])) {
    return null;
  }
  const contentStart = cursor;

  const closeIndex = findTagCloseIndex(text, cursor);
  if (closeIndex === -1) {
    return {
      contentStart,
      end: text.length,
      isClose,
      isSelfClosing: false,
      tagName,
      isTruncated: true,
    };
  }

  return {
    contentStart,
    end: closeIndex + 1,
    isClose,
    isSelfClosing: !isClose && /\/\s*$/.test(text.slice(cursor, closeIndex)),
    tagName,
    isTruncated: false,
  };
}

export function stripToolCallXmlTags(
  text: string,
  options: { stripFunctionCallsXmlPayloads?: boolean } = {},
): string {
  if (!text || !TOOL_CALL_QUICK_RE.test(text)) {
    return text;
  }

  const codeRegions = findCodeRegions(text);
  let result = "";
  let lastIndex = 0;
  let inToolCallBlock = false;
  let toolCallBlockContentStart = 0;
  let toolCallBlockNeedsQuoteBalance = false;
  let toolCallBlockStart = 0;
  let toolCallBlockTagName: string | null = null;
  const visibleTagBalance = new Map<string, number>();

  for (let idx = 0; idx < text.length; idx += 1) {
    if (text[idx] !== "<") {
      continue;
    }
    if (!inToolCallBlock && isInsideCode(idx, codeRegions)) {
      continue;
    }

    const tag = parseToolCallTagAt(text, idx);
    if (!tag) {
      continue;
    }

    if (!inToolCallBlock) {
      result += text.slice(lastIndex, idx);
      if (tag.isClose) {
        if (tag.isTruncated) {
          const preserveEnd = tag.contentStart;
          result += text.slice(idx, preserveEnd);
          lastIndex = preserveEnd;
          idx = Math.max(idx, preserveEnd - 1);
          continue;
        }
        const balance = visibleTagBalance.get(tag.tagName) ?? 0;
        if (balance > 0) {
          result += text.slice(idx, tag.end);
          visibleTagBalance.set(tag.tagName, balance - 1);
        }
        lastIndex = tag.end;
        idx = Math.max(idx, tag.end - 1);
        continue;
      }
      if (tag.isSelfClosing) {
        lastIndex = tag.end;
        idx = Math.max(idx, tag.end - 1);
        continue;
      }
      const payloadStart = tag.isTruncated ? tag.contentStart : tag.end;
      const shouldDetectXmlPayload =
        tag.tagName === "tool_call" ||
        tag.tagName === "function" ||
        (options.stripFunctionCallsXmlPayloads === true &&
          (tag.tagName === "function_calls" || tag.tagName === "tool_calls"));
      const payloadKind = shouldDetectXmlPayload
        ? detectToolCallPayloadKind(text, payloadStart)
        : TOOL_CALL_JSON_PAYLOAD_START_RE.test(text.slice(payloadStart))
          ? "json"
          : null;
      const shouldStripStandaloneFunction =
        tag.tagName !== "function" || isLikelyStandaloneFunctionToolCall(text, idx, tag);
      if (!tag.isClose && payloadKind && shouldStripStandaloneFunction) {
        inToolCallBlock = true;
        toolCallBlockContentStart = tag.end;
        toolCallBlockNeedsQuoteBalance =
          payloadKind === "json" ||
          (payloadKind === "xml" && startsWithNestedJsonToolCallPayload(text, payloadStart));
        toolCallBlockStart = idx;
        toolCallBlockTagName = tag.tagName;
        if (tag.isTruncated) {
          lastIndex = text.length;
          break;
        }
      } else {
        const preserveEnd = tag.isTruncated ? tag.contentStart : tag.end;
        result += text.slice(idx, preserveEnd);
        if (!tag.isTruncated) {
          visibleTagBalance.set(tag.tagName, (visibleTagBalance.get(tag.tagName) ?? 0) + 1);
        }
        lastIndex = preserveEnd;
        idx = Math.max(idx, preserveEnd - 1);
        continue;
      }
    } else if (
      tag.isClose &&
      (tag.tagName === toolCallBlockTagName ||
        (toolCallBlockTagName === "tool_result" && tag.tagName === "tool_call")) &&
      (!toolCallBlockNeedsQuoteBalance ||
        !endsInsideQuotedString(text, toolCallBlockContentStart, idx))
    ) {
      inToolCallBlock = false;
      toolCallBlockNeedsQuoteBalance = false;
      toolCallBlockTagName = null;
    }

    lastIndex = tag.end;
    idx = Math.max(idx, tag.end - 1);
  }

  if (!inToolCallBlock) {
    result += text.slice(lastIndex);
  } else if (toolCallBlockTagName === "function") {
    result += text.slice(toolCallBlockStart);
  }

  return result;
}

/**
 * Strip malformed Minimax tool invocations that leak into text content.
 * Minimax sometimes embeds tool calls as XML in text blocks instead of
 * proper structured tool calls.
 */
export function stripMinimaxToolCallXml(text: string): string {
  if (!text || !/minimax:tool_call/i.test(text)) {
    return text;
  }

  const codeRegions = findCodeRegions(text);
  const minimaxToolXmlRe = /<invoke\b[^>]*>[\s\S]*?<\/invoke>|<\/?minimax:tool_call>/gi;
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(minimaxToolXmlRe)) {
    const start = match.index ?? 0;
    if (isInsideCode(start, codeRegions)) {
      continue;
    }
    result += text.slice(cursor, start);
    cursor = start + match[0].length;
  }
  result += text.slice(cursor);
  return result;
}

function isLegacyBracketToolCallPayload(value: string): boolean {
  return (
    /\btool\s*=>\s*["'][A-Za-z_][A-Za-z0-9_.:-]{0,119}["']/i.test(value) &&
    /\bargs\s*=>/i.test(value)
  );
}

function isLegacyBracketToolResultPayload(value: string): boolean {
  return (
    /^\s*[{[]/.test(value) ||
    /\b(?:tool|result|output|content)\s*=>/i.test(value) ||
    /\b(?:tool|result|output|content)\s*:/i.test(value)
  );
}

export function stripLegacyBracketToolCallBlocks(text: string): string {
  if (!text || !LEGACY_BRACKET_TOOL_BLOCK_QUICK_RE.test(text)) {
    return text;
  }

  const codeRegions = findCodeRegions(text);
  let result = "";
  let cursor = 0;
  while (cursor < text.length) {
    const openMatch = /\[\s*TOOL_(CALL|RESULT)\s*\]/gi.exec(text.slice(cursor));
    if (!openMatch?.[0]) {
      result += text.slice(cursor);
      break;
    }
    const blockKind = openMatch[1]?.toUpperCase();
    const openStart = cursor + (openMatch.index ?? 0);
    const payloadStart = openStart + openMatch[0].length;
    if (isInsideCode(openStart, codeRegions)) {
      result += text.slice(cursor, payloadStart);
      cursor = payloadStart;
      continue;
    }

    const closeRe =
      blockKind === "RESULT" ? /\[\s*\/\s*TOOL_RESULT\s*\]/gi : /\[\s*\/\s*TOOL_CALL\s*\]/gi;
    const closeMatch = closeRe.exec(text.slice(payloadStart));
    const closeStart =
      closeMatch?.[0] && !isInsideCode(payloadStart + (closeMatch.index ?? 0), codeRegions)
        ? payloadStart + (closeMatch.index ?? 0)
        : -1;
    const payloadEnd = closeStart >= 0 ? closeStart : text.length;
    const payload = text.slice(payloadStart, payloadEnd);
    const shouldStrip =
      blockKind === "RESULT"
        ? isLegacyBracketToolResultPayload(payload)
        : isLegacyBracketToolCallPayload(payload);
    if (!shouldStrip) {
      result += text.slice(cursor, payloadStart);
      cursor = payloadStart;
      continue;
    }

    result += text.slice(cursor, openStart);
    cursor = closeStart >= 0 ? closeStart + (closeMatch?.[0].length ?? 0) : text.length;
  }

  return result;
}

/**
 * Strip downgraded tool call text representations that leak into user-visible
 * text content when replaying history across providers.
 */
export function stripDowngradedToolCallText(text: string): string {
  if (!text) {
    return text;
  }
  if (!/\[Tool (?:Call|Result)/i.test(text) && !/\[Historical context/i.test(text)) {
    return text;
  }

  const consumeJsonish = (
    input: string,
    start: number,
    options?: { allowLeadingNewlines?: boolean },
  ): number | null => {
    const { allowLeadingNewlines = false } = options ?? {};
    let index = start;
    while (index < input.length) {
      const ch = input[index];
      if (ch === " " || ch === "\t") {
        index += 1;
        continue;
      }
      if (allowLeadingNewlines && (ch === "\n" || ch === "\r")) {
        index += 1;
        continue;
      }
      break;
    }
    if (index >= input.length) {
      return null;
    }

    const startChar = input[index];
    if (startChar === "{" || startChar === "[") {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let idx = index; idx < input.length; idx += 1) {
        const ch = input[idx];
        if (inString) {
          if (escape) {
            escape = false;
          } else if (ch === "\\") {
            escape = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === "{" || ch === "[") {
          depth += 1;
        } else if (ch === "}" || ch === "]") {
          depth -= 1;
          if (depth === 0) {
            return idx + 1;
          }
        }
      }
      return null;
    }

    if (startChar === '"') {
      let escape = false;
      for (let idx = index + 1; idx < input.length; idx += 1) {
        const ch = input[idx];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') {
          return idx + 1;
        }
      }
      return null;
    }

    let end = index;
    while (end < input.length && input[end] !== "\n" && input[end] !== "\r") {
      end += 1;
    }
    return end;
  };

  const stripToolCalls = (input: string): string => {
    const toolCallRe = /\[Tool Call:[^\]]*\]/gi;
    let result = "";
    let cursor = 0;
    for (const match of input.matchAll(toolCallRe)) {
      const start = match.index ?? 0;
      if (start < cursor) {
        continue;
      }
      result += input.slice(cursor, start);
      let index = start + match[0].length;
      while (index < input.length && (input[index] === " " || input[index] === "\t")) {
        index += 1;
      }
      if (input[index] === "\r") {
        index += 1;
        if (input[index] === "\n") {
          index += 1;
        }
      } else if (input[index] === "\n") {
        index += 1;
      }
      while (index < input.length && (input[index] === " " || input[index] === "\t")) {
        index += 1;
      }
      if (normalizeLowercaseStringOrEmpty(input.slice(index, index + 9)) === "arguments") {
        index += 9;
        if (input[index] === ":") {
          index += 1;
        }
        if (input[index] === " ") {
          index += 1;
        }
        const end = consumeJsonish(input, index, { allowLeadingNewlines: true });
        if (end !== null) {
          index = end;
        }
      }
      if (
        (input[index] === "\n" || input[index] === "\r") &&
        (result.endsWith("\n") || result.endsWith("\r") || result.length === 0)
      ) {
        if (input[index] === "\r") {
          index += 1;
        }
        if (input[index] === "\n") {
          index += 1;
        }
      }
      cursor = index;
    }
    result += input.slice(cursor);
    return result;
  };

  // Remove [Tool Call: name (ID: ...)] blocks and their Arguments.
  let cleaned = stripToolCalls(text);

  // Remove [Tool Result for ID ...] blocks and their content.
  cleaned = cleaned.replace(/\[Tool Result for ID[^\]]*\]\n?[\s\S]*?(?=\n*\[Tool |\n*$)/gi, "");

  // Remove [Historical context: ...] markers (self-contained within brackets).
  cleaned = cleaned.replace(/\[Historical context:[^\]]*\]\n?/gi, "");

  return cleaned.trim();
}

function stripRelevantMemoriesTags(text: string): string {
  if (!text || !MEMORY_TAG_QUICK_RE.test(text)) {
    return text;
  }
  MEMORY_TAG_RE.lastIndex = 0;

  const codeRegions = findCodeRegions(text);
  let result = "";
  let lastIndex = 0;
  let inMemoryBlock = false;

  for (const match of text.matchAll(MEMORY_TAG_RE)) {
    const idx = match.index ?? 0;
    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    const isClose = match[1] === "/";
    if (!inMemoryBlock) {
      result += text.slice(lastIndex, idx);
      if (!isClose) {
        inMemoryBlock = true;
      }
    } else if (isClose) {
      inMemoryBlock = false;
    }

    lastIndex = idx + match[0].length;
  }

  if (!inMemoryBlock) {
    result += text.slice(lastIndex);
  }

  return result;
}

export type AssistantVisibleTextSanitizerProfile = "delivery" | "history" | "internal-scaffolding";

type AssistantVisibleTextPipelineOptions = {
  finalTrim: ReasoningTagTrim;
  preserveDowngradedToolText?: boolean;
  preserveMinimaxToolXml?: boolean;
  stripFunctionCallsXmlPayloads?: boolean;
  reasoningMode: ReasoningTagMode;
  reasoningTrim: ReasoningTagTrim;
  stageOrder: "reasoning-first" | "reasoning-last";
};

const ASSISTANT_VISIBLE_TEXT_PIPELINE_OPTIONS: Record<
  AssistantVisibleTextSanitizerProfile,
  AssistantVisibleTextPipelineOptions
> = {
  delivery: {
    finalTrim: "both",
    reasoningMode: "strict",
    reasoningTrim: "both",
    stageOrder: "reasoning-last",
  },
  history: {
    finalTrim: "none",
    reasoningMode: "strict",
    reasoningTrim: "none",
    stageOrder: "reasoning-last",
  },
  "internal-scaffolding": {
    finalTrim: "start",
    preserveDowngradedToolText: true,
    preserveMinimaxToolXml: true,
    reasoningMode: "preserve",
    reasoningTrim: "start",
    stageOrder: "reasoning-first",
  },
};

function applyAssistantVisibleTextStagePipeline(
  text: string,
  options: AssistantVisibleTextPipelineOptions,
): string {
  if (!text) {
    return text;
  }

  const stripReasoning = (value: string) =>
    stripReasoningTagsFromText(value, {
      mode: options.reasoningMode,
      trim: options.reasoningTrim,
    });
  const applyFinalTrim = (value: string) => {
    if (options.finalTrim === "none") {
      return value;
    }
    if (options.finalTrim === "start") {
      return value.trimStart();
    }
    return value.trim();
  };
  const stripNonReasoningStages = (value: string) => {
    let cleaned = value;
    if (!options.preserveMinimaxToolXml) {
      cleaned = stripMinimaxToolCallXml(cleaned);
    }
    cleaned = stripModelSpecialTokens(cleaned);
    cleaned = stripRelevantMemoriesTags(cleaned);
    cleaned = stripToolCallXmlTags(cleaned, {
      stripFunctionCallsXmlPayloads: options.stripFunctionCallsXmlPayloads,
    });
    cleaned = stripLegacyBracketToolCallBlocks(cleaned);
    cleaned = stripPlainTextToolCallBlocks(cleaned);
    if (!options.preserveDowngradedToolText) {
      cleaned = stripDowngradedToolCallText(cleaned);
    }
    return cleaned;
  };

  if (options.stageOrder === "reasoning-first") {
    return applyFinalTrim(stripNonReasoningStages(stripReasoning(text)));
  }

  return applyFinalTrim(stripReasoning(stripNonReasoningStages(text)));
}

export function sanitizeAssistantVisibleTextWithProfile(
  text: string,
  profile: AssistantVisibleTextSanitizerProfile = "delivery",
): string {
  return applyAssistantVisibleTextStagePipeline(
    text,
    ASSISTANT_VISIBLE_TEXT_PIPELINE_OPTIONS[profile],
  );
}

export function stripAssistantInternalScaffolding(text: string): string {
  return sanitizeAssistantVisibleTextWithProfile(text, "internal-scaffolding");
}

/**
 * Canonical user-visible assistant text sanitizer for delivery and history
 * extraction paths. Keeps prose, removes internal scaffolding.
 */
export function sanitizeAssistantVisibleText(text: string): string {
  return sanitizeAssistantVisibleTextWithProfile(text, "delivery");
}

/**
 * Backwards-compatible trim wrapper.
 * Prefer sanitizeAssistantVisibleTextWithProfile for new call sites.
 */
export function sanitizeAssistantVisibleTextWithOptions(
  text: string,
  options?: { trim?: "none" | "both" },
): string {
  const profile = options?.trim === "none" ? "history" : "delivery";
  return sanitizeAssistantVisibleTextWithProfile(text, profile);
}
