import { expectDefined } from "@openclaw/normalization-core";
// Assistant visible text helpers strip hidden reasoning and control marker text.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  consumeLineBreak,
  skipHorizontalWhitespace,
  skipWhitespace,
} from "../../../packages/tool-call-repair/src/grammar.js";
import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/index.js";
import { findCodeRegions, isInsideCode, stripLinesOutsideCode } from "./code-regions.js";
import { stripModelSpecialTokens } from "./model-special-tokens.js";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";
import { applyTextFilters, trimTextFilter, type TextFilter } from "./text-projection.js";

const MEMORY_TAG_RE = /<\s*(\/?)\s*relevant[-_]memories\b[^<>]*>/gi;
const MEMORY_TAG_QUICK_RE = /<\s*\/?\s*relevant[-_]memories\b/i;
const LEGACY_BRACKET_TOOL_BLOCK_QUICK_RE = /\[\s*\/?\s*TOOL_(?:CALL|RESULT)\s*\]/i;
const INTERNAL_TRACE_LINE_QUICK_RE =
  /(?:📊|🛠️|📖|📝|🔍|🔎|⚙️|tool[-_ ]?call|tool[-_ ]?result|function[-_ ]?call)/i;
const INTERNAL_TRACE_LINE_RE =
  /^(?:>\s*)?(?:⚠️\s*)?(?:📊|🛠️|📖|📝|🔍|🔎|⚙️)\s*(?:Session Status|Exec|Read|Edit|Write|Patch|Search|Open|Click|Find|Screenshot|Update Plan|Tool Call|Tool Result|Function Call|Shell|Command)\s*:/i;
// The current producer reserves "⚠️ 🛠️ Exec|Bash failed[:...]" for exec warnings, so
// echoed copies must be removed. The second branch preserves the historical "(agent) failed" shape.
const INTERNAL_COMPACT_FAILURE_TRACE_LINE_RE =
  /^(?:>\s*)?⚠️\s*🛠️\s+(?:(?:Exec|Bash)\s+failed(?:(?:\s+\(exit\s+-?\d+\))|(?:\s*:[^\r\n]*))?|\S[^\r\n]*\s+\(agent\)`{0,2}\s+failed(?:\s*:[^\r\n]*)?)\s*$/i;
const INTERNAL_COMPACT_COMMAND_TRACE_LINE_RE =
  /^(?:>\s*)?🛠️\s*(?:(?:(?:elevated|pty)\b\s*(?:·|,)\s*)+)?(?:`{1,2}\s*\S|(?:run|check|fetch|pull|push|view|show|list|switch|create|merge|rebase|stage|restore|reset|stash|search|find|print|copy|move|remove|install|start|cd|git|pnpm|npm|yarn|bun|node|python|python3|bash|sh)\b)/i;
const INTERNAL_CHANNEL_TRACE_LINE_RE =
  /^(?:>\s*)?(?:tool[-_ ]?call|tool[-_ ]?result|function[-_ ]?call)\s*[:=]/i;

/**
 * Strip XML-style tool call tags that models sometimes emit as plain text.
 * This stateful pass hides content from an opening tag through the matching
 * closing tag, or to end-of-string if the stream was truncated mid-tag.
 */
const TOOL_CALL_QUICK_RE =
  /<\s*\/?\s*(?:antml:)?(?:tool_call|tool_result|function_calls?|function_response|function|tool_calls|invoke|parameter)\b/i;
const TOOL_CALL_TAG_NAMES = new Set([
  "tool_call",
  "tool_result",
  "function_call",
  "function_calls",
  "function_response",
  "function",
  "tool_calls",
  "antml:invoke",
  "antml:parameter",
]);
const TOOL_CALL_JSON_PAYLOAD_START_RE =
  /^(?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))*\s*(?:\r?\n\s*)?[[{]/;
const TOOL_CALL_XML_PAYLOAD_START_RE =
  /^\s*(?:\r?\n\s*)?<(?:antml:)?(?:function_call|tool_call|function|invoke|parameters?|arguments?)\b/i;
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

// Match only the tag head; quote-aware scanning owns the close boundary.
const XML_TAG_HEAD_RE = /<\s*(?:(\/)\s*)?([A-Za-z_:][A-Za-z0-9_.:-]*)(?=$|[\s/>])/y;

function parseXmlTagAt(text: string, start: number): ParsedToolCallTag | null {
  XML_TAG_HEAD_RE.lastIndex = start;
  const match = XML_TAG_HEAD_RE.exec(text);
  if (!match) {
    return null;
  }
  const contentStart = XML_TAG_HEAD_RE.lastIndex;
  const isClose = match[1] === "/";
  const closeIndex = findTagCloseIndex(text, contentStart);
  const isTruncated = closeIndex === -1;
  return {
    contentStart,
    end: isTruncated ? text.length : closeIndex + 1,
    isClose,
    isSelfClosing: !isTruncated && !isClose && /\/\s*$/.test(text.slice(contentStart, closeIndex)),
    tagName: normalizeLowercaseStringOrEmpty(match[2]),
    isTruncated,
  };
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
  const nestedTag = parseToolCallTagAt(text, skipWhitespace(text, start));
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

  return idx < 0 || text[idx] === "\n" || text[idx] === "\r" || /[.!?:]/.test(text.charAt(idx));
}

function isAdjacentToStrippedToolCallBlock(
  text: string,
  tagStart: number,
  lastStrippedBlockEnd: number | null,
): boolean {
  if (lastStrippedBlockEnd === null || lastStrippedBlockEnd > tagStart) {
    return false;
  }
  for (let idx = lastStrippedBlockEnd; idx < tagStart; idx += 1) {
    if (text[idx] !== " " && text[idx] !== "\t" && text[idx] !== "\n" && text[idx] !== "\r") {
      return false;
    }
  }
  return true;
}

function findMatchingToolCallCloseIndex(text: string, start: number, tagName: string): number {
  for (let idx = start; idx < text.length; idx += 1) {
    if (text[idx] !== "<") {
      continue;
    }
    const tag = parseToolCallTagAt(text, idx);
    if (!tag) {
      continue;
    }
    if (tag.isClose && tag.tagName === tagName && !tag.isTruncated) {
      return idx;
    }
    idx = Math.max(idx, tag.end - 1);
  }
  return -1;
}

function findAdjacentOpeningToolCallTag(
  text: string,
  start: number,
  tagName: string,
): ParsedToolCallTag | null {
  const tag = parseToolCallTagAt(text, skipWhitespace(text, start));
  if (!tag || tag.isClose || tag.tagName !== tagName) {
    return null;
  }
  return tag;
}

function parseToolCallTagAt(text: string, start: number): ParsedToolCallTag | null {
  const tag = parseXmlTagAt(text, start);
  return tag && TOOL_CALL_TAG_NAMES.has(tag.tagName) ? tag : null;
}

function hasMatchingXmlCloseTag(text: string, start: number, tagName: string): boolean {
  let depth = 1;
  for (let idx = start; idx < text.length; idx += 1) {
    if (text[idx] !== "<") {
      continue;
    }
    const tag = parseXmlTagAt(text, idx);
    if (!tag || tag.tagName !== tagName || tag.isTruncated) {
      continue;
    }
    if (tag.isClose) {
      depth -= 1;
      if (depth === 0) {
        return true;
      }
    } else if (!tag.isSelfClosing) {
      depth += 1;
    }
    idx = Math.max(idx, tag.end - 1);
  }
  return false;
}

function isDanglingFunctionParameterParent(text: string, tag: ParsedToolCallTag): boolean {
  if (tag.tagName !== "function" || !/\bname\s*=/.test(text.slice(tag.contentStart, tag.end))) {
    return false;
  }
  const nextTag = parseXmlTagAt(text, skipWhitespace(text, tag.end));
  return nextTag?.tagName === "parameter" && !nextTag.isClose;
}

function trimImmediateLineBreakBefore(text: string, start: number, end: number): number {
  if (end > start && text[end - 1] === "\n") {
    return end - (end - 2 >= start && text[end - 2] === "\r" ? 2 : 1);
  }
  return end > start && text[end - 1] === "\r" ? end - 1 : end;
}

function isLineStartAt(text: string, start: number): boolean {
  let cursor = start - 1;
  while (cursor >= 0 && (text[cursor] === " " || text[cursor] === "\t")) {
    cursor -= 1;
  }
  return cursor < 0 || text[cursor] === "\n" || text[cursor] === "\r";
}

function isLineEndAfter(text: string, end: number): boolean {
  const cursor = skipHorizontalWhitespace(text, end);
  return cursor >= text.length || text[cursor] === "\n" || text[cursor] === "\r";
}

function unwrapStandaloneParameterTags(text: string): string {
  if (!/<\s*\/?\s*parameter\b/i.test(text)) {
    return text;
  }

  const codeRegions = findCodeRegions(text);
  const openTags: Array<{ name: string; unwrap: boolean; trimBoundaryLineBreaks: boolean }> = [];
  let result = "";
  let lastIndex = 0;

  for (let idx = 0; idx < text.length; idx += 1) {
    if (text[idx] !== "<" || isInsideCode(idx, codeRegions)) {
      continue;
    }
    const tag = parseXmlTagAt(text, idx);
    if (!tag || tag.isTruncated) {
      continue;
    }

    if (tag.isClose) {
      const openIndex = openTags.findLastIndex((entry) => entry.name === tag.tagName);
      if (openIndex !== -1) {
        const opening = expectDefined(openTags[openIndex], "open tags entry at open index");
        if (opening.unwrap) {
          const contentEnd =
            opening.trimBoundaryLineBreaks &&
            isLineStartAt(text, idx) &&
            isLineEndAfter(text, tag.end)
              ? trimImmediateLineBreakBefore(text, lastIndex, idx)
              : idx;
          result += text.slice(lastIndex, contentEnd);
          lastIndex = tag.end;
        }
        openTags.splice(openIndex);
      }
    } else if (tag.isSelfClosing) {
      if (tag.tagName === "parameter" && openTags.length === 0) {
        result += text.slice(lastIndex, idx);
        lastIndex = tag.end;
      }
    } else if (
      hasMatchingXmlCloseTag(text, tag.end, tag.tagName) ||
      isDanglingFunctionParameterParent(text, tag)
    ) {
      const unwrap = tag.tagName === "parameter" && openTags.length === 0;
      let trimBoundaryLineBreaks = false;
      if (unwrap) {
        result += text.slice(lastIndex, idx);
        lastIndex = tag.end;
        const contentStart = isLineStartAt(text, idx) ? consumeLineBreak(text, lastIndex) : null;
        if (contentStart !== null) {
          lastIndex = contentStart;
          trimBoundaryLineBreaks = true;
        }
      }
      openTags.push({ name: tag.tagName, unwrap, trimBoundaryLineBreaks });
    }
    idx = Math.max(idx, tag.end - 1);
  }

  return result + text.slice(lastIndex);
}

export function stripToolCallXmlTags(
  input: string,
  options: {
    stripFunctionCallsXmlPayloads?: boolean;
    stripFunctionResponseAfterPluralToolCalls?: boolean;
  } = {},
): string {
  const text = input;
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
  let lastStrippedToolCallBlockEnd: number | null = null;
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
        lastStrippedToolCallBlockEnd = tag.end;
        lastIndex = tag.end;
        idx = Math.max(idx, tag.end - 1);
        continue;
      }
      const payloadStart = tag.isTruncated ? tag.contentStart : tag.end;
      const isPluralToolCallWrapper =
        tag.tagName === "function_calls" || tag.tagName === "tool_calls";
      const matchingCloseStart = isPluralToolCallWrapper
        ? findMatchingToolCallCloseIndex(text, tag.end, tag.tagName)
        : -1;
      const matchingCloseTag =
        matchingCloseStart === -1 ? null : parseToolCallTagAt(text, matchingCloseStart);
      const shouldStripPluralWrapperBeforeResponse =
        options.stripFunctionResponseAfterPluralToolCalls === true &&
        isPluralToolCallWrapper &&
        matchingCloseTag !== null &&
        findAdjacentOpeningToolCallTag(text, matchingCloseTag.end, "function_response") !== null;
      const shouldDetectXmlPayload =
        tag.tagName === "tool_call" ||
        tag.tagName === "function" ||
        tag.tagName === "antml:invoke" ||
        ((options.stripFunctionCallsXmlPayloads === true ||
          shouldStripPluralWrapperBeforeResponse) &&
          isPluralToolCallWrapper);
      const payloadKind = shouldDetectXmlPayload
        ? detectToolCallPayloadKind(text, payloadStart)
        : TOOL_CALL_JSON_PAYLOAD_START_RE.test(text.slice(payloadStart))
          ? "json"
          : null;
      const shouldStripStandaloneFunction =
        tag.tagName !== "function" || isLikelyStandaloneFunctionToolCall(text, idx, tag);
      const functionResponseCloseStart =
        tag.tagName === "function_response"
          ? findMatchingToolCallCloseIndex(text, tag.end, tag.tagName)
          : -1;
      const shouldStripStandaloneResult =
        tag.tagName === "function_response" &&
        ((isLineStartAt(text, idx) && isLineEndAfter(text, tag.end)) ||
          isAdjacentToStrippedToolCallBlock(text, idx, lastStrippedToolCallBlockEnd) ||
          (functionResponseCloseStart !== -1 &&
            isLineStartAt(result, result.length) &&
            isLineEndAfter(text, tag.end)));
      if ((payloadKind && shouldStripStandaloneFunction) || shouldStripStandaloneResult) {
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
      const closedBlockTagName = toolCallBlockTagName;
      inToolCallBlock = false;
      toolCallBlockNeedsQuoteBalance = false;
      toolCallBlockTagName = null;
      if (closedBlockTagName) {
        lastStrippedToolCallBlockEnd = tag.end;
      }
    }

    lastIndex = tag.end;
    idx = Math.max(idx, tag.end - 1);
  }

  if (!inToolCallBlock) {
    result += text.slice(lastIndex);
  } else if (toolCallBlockTagName === "function") {
    result += text.slice(toolCallBlockStart);
  }

  return unwrapStandaloneParameterTags(result);
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
  for (const openMatch of text.matchAll(/\[\s*TOOL_(CALL|RESULT)\s*\]/gi)) {
    const openStart = openMatch.index;
    if (openStart < cursor || isInsideCode(openStart, codeRegions)) {
      continue;
    }
    const payloadStart = openStart + openMatch[0].length;
    const isResult = openMatch[1]?.toUpperCase() === "RESULT";
    const closeRe = isResult ? /\[\s*\/\s*TOOL_RESULT\s*\]/gi : /\[\s*\/\s*TOOL_CALL\s*\]/gi;
    closeRe.lastIndex = payloadStart;
    const closeMatch = closeRe.exec(text);
    const closeStart =
      closeMatch && !isInsideCode(closeMatch.index, codeRegions) ? closeMatch.index : -1;
    const payload = text.slice(payloadStart, closeStart >= 0 ? closeStart : text.length);
    if (
      !(isResult
        ? isLegacyBracketToolResultPayload(payload)
        : isLegacyBracketToolCallPayload(payload))
    ) {
      continue;
    }
    result += text.slice(cursor, openStart);
    cursor = closeStart >= 0 ? closeStart + (closeMatch?.[0].length ?? 0) : text.length;
    if (cursor === text.length) {
      break;
    }
  }
  return result + text.slice(cursor);
}

function consumeJsonish(input: string, start: number): number | null {
  let index = start;
  while (index < input.length && /[ \t\r\n]/.test(input[index] ?? "")) {
    index += 1;
  }
  const opening = input[index];
  if (opening === undefined) {
    return null;
  }
  if (opening !== "{" && opening !== "[" && opening !== '"') {
    while (index < input.length && input[index] !== "\n" && input[index] !== "\r") {
      index += 1;
    }
    return index;
  }

  // Downgraded history accepts quoted scalars and mixed container balance without JSON validation.
  let depth = opening === '"' ? 0 : 1;
  let inString = opening === '"';
  let escaped = false;
  for (index += 1; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
    if (!inString && depth === 0) {
      return index + 1;
    }
  }
  return null;
}

function stripDowngradedToolCalls(input: string): string {
  let codeRegions: ReturnType<typeof findCodeRegions> | undefined;
  let result = "";
  let cursor = 0;
  for (const match of input.matchAll(/\[Tool Call:[^\]]*\]/gi)) {
    const start = match.index;
    if (start < cursor || isInsideCode(start, (codeRegions ??= findCodeRegions(input)))) {
      continue;
    }
    result += input.slice(cursor, start);
    let index = skipHorizontalWhitespace(input, start + match[0].length);
    index = skipHorizontalWhitespace(input, consumeLineBreak(input, index) ?? index);
    if (normalizeLowercaseStringOrEmpty(input.slice(index, index + 9)) === "arguments") {
      index += 9;
      if (input[index] === ":") {
        index += 1;
      }
      if (input[index] === " ") {
        index += 1;
      }
      index = consumeJsonish(input, index) ?? index;
    }
    if (!result || result.endsWith("\n") || result.endsWith("\r")) {
      index = consumeLineBreak(input, index) ?? index;
    }
    cursor = index;
  }
  return result + input.slice(cursor);
}

/**
 * Strip downgraded tool call text representations that leak into user-visible
 * text content when replaying history across providers.
 */
export function stripDowngradedToolCallText(text: string): string {
  if (!text || (!/\[Tool (?:Call|Result)/i.test(text) && !/\[Historical context/i.test(text))) {
    return text;
  }
  let cleaned = stripDowngradedToolCalls(text);
  for (const pattern of [
    /\[Tool Result for ID[^\]]*\]\n?[\s\S]*?(?=\n*\[Tool |\n*$)/gi,
    /\[Historical context:[^\]]*\]\n?/gi,
  ]) {
    const input = cleaned;
    // An earlier removal can change Markdown ownership for the next marker family.
    let codeRegions: ReturnType<typeof findCodeRegions> | undefined;
    cleaned = input.replace(pattern, (match, offset: number) =>
      isInsideCode(offset, (codeRegions ??= findCodeRegions(input))) ? match : "",
    );
  }
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

function stripAssistantInternalTraceLines(text: string): string {
  if (!text || !INTERNAL_TRACE_LINE_QUICK_RE.test(text)) {
    return text;
  }

  return stripLinesOutsideCode(text, (line) => {
    const trimmed = line.trim();
    return (
      INTERNAL_TRACE_LINE_RE.test(trimmed) ||
      INTERNAL_COMPACT_FAILURE_TRACE_LINE_RE.test(trimmed) ||
      INTERNAL_COMPACT_COMMAND_TRACE_LINE_RE.test(trimmed) ||
      INTERNAL_CHANNEL_TRACE_LINE_RE.test(trimmed)
    );
  });
}

export type AssistantVisibleTextSanitizerProfile =
  | "delivery"
  | "final-answer-delivery"
  | "history"
  | "internal-scaffolding"
  | "tool-progress";

const profileFilters = new Map<string, readonly TextFilter[]>();

export function assistantVisibleTextFilters(
  profile: AssistantVisibleTextSanitizerProfile,
  streaming = false,
): readonly TextFilter[] {
  const key = `${profile}:${streaming}`;
  const cached = profileFilters.get(key);
  if (cached) {
    return cached;
  }
  const preserve = profile === "internal-scaffolding";
  const trim = preserve ? "start" : profile === "history" ? "none" : "both";
  const reasoning: TextFilter = {
    activationTokens: ["<"],
    transform: (text) =>
      stripReasoningTagsFromText(text, {
        mode: preserve ? "preserve" : "strict",
        scope: profile === "final-answer-delivery" ? "leading" : "all",
        trim,
        // An unfinished stream cannot use terminal malformed-output recovery.
        recoverUnclosed: !streaming,
      }),
  };
  const filters: TextFilter[] = [
    ...(!preserve ? [{ transform: stripMinimaxToolCallXml, activationTokens: ["<"] }] : []),
    { transform: stripModelSpecialTokens, activationTokens: ["<"] },
    { transform: stripRelevantMemoriesTags, activationTokens: ["<"] },
    {
      activationTokens: ["<"],
      transform: (text) =>
        stripToolCallXmlTags(text, {
          stripFunctionCallsXmlPayloads: profile === "tool-progress",
          stripFunctionResponseAfterPluralToolCalls:
            profile === "delivery" || profile === "final-answer-delivery",
        }),
    },
    ...(profile === "tool-progress" ? [] : [assistantTraceTextFilter]),
    { transform: stripLegacyBracketToolCallBlocks, activationTokens: ["["] },
    plainToolCallTextFilter,
    ...(!preserve ? [{ transform: stripDowngradedToolCallText, activationTokens: ["["] }] : []),
  ];
  if (preserve) {
    filters.unshift(reasoning);
  } else {
    filters.push(reasoning);
  }
  filters.push(trimTextFilter(trim));
  profileFilters.set(key, filters);
  return filters;
}

// Activation is a necessary condition only; the canonical parsers still own
// syntax, code protection, and later corrections once a marker has appeared.
export const assistantTraceTextFilter: TextFilter = {
  transform: stripAssistantInternalTraceLines,
  activationTokens: ["tool", "function", "📊", "🛠", "📖", "📝", "🔍", "🔎", "⚙"],
};

export const plainToolCallTextFilter: TextFilter = {
  transform: (text) =>
    stripPlainTextToolCallBlocks(text, { resolveProtectedRanges: findCodeRegions }),
  activationTokens: ["[", "<", "to="],
};

export function sanitizeAssistantVisibleTextWithProfile(
  text: string,
  profile: AssistantVisibleTextSanitizerProfile = "delivery",
  streaming = false,
): string {
  return applyTextFilters(text, assistantVisibleTextFilters(profile, streaming));
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

/** Sanitizes text already marked as final-answer prose by the agent runtime. */
export function sanitizeAssistantFinalAnswerText(text: string): string {
  return sanitizeAssistantVisibleTextWithProfile(text, "final-answer-delivery");
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
