/** Strips internal scaffolding from text before user-facing delivery. */
import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/index.js";
import { CURRENT_MESSAGE_MARKER, HISTORY_CONTEXT_MARKER } from "../../auto-reply/reply/history.js";
import { stripInboundMetadata } from "../../auto-reply/reply/strip-inbound-meta.js";
import { coerceChatContentText } from "../../shared/chat-content.js";
import { escapeRegExp } from "../../shared/regexp.js";
import {
  stripAssistantInternalTraceLines,
  stripLegacyBracketToolCallBlocks,
  stripMinimaxToolCallXml,
  stripToolCallXmlTags,
} from "../../shared/text/assistant-visible-text.js";
import { findCodeRegions, isInsideCode } from "../../shared/text/code-regions.js";
import { stripFinalTags } from "../../shared/text/final-tags.js";
import { EXEC_NO_OUTPUT_PLACEHOLDER } from "../bash-tools.exec-output.js";
import { stripInternalRuntimeContext } from "../internal-runtime-context.js";

const TOOL_CALLS_OMITTED_PLACEHOLDER_LINE_RE = /^[ \t]*\[tool calls omitted\][ \t]*$/i;

function stripFinalTagsFromText(text: unknown): string {
  const normalized = coerceChatContentText(text);
  return normalized ? stripFinalTags(normalized) : normalized;
}

function stripInternalPlaceholderLines(text: string): string {
  if (
    !text.toLowerCase().includes("[tool calls omitted]") &&
    !text.includes(EXEC_NO_OUTPUT_PLACEHOLDER)
  ) {
    return text;
  }
  let protectedRegions: ReturnType<typeof findCodeRegions> | undefined;
  let result = "";
  let start = 0;
  while (start < text.length) {
    const newlineIndex = text.indexOf("\n", start);
    const end = newlineIndex === -1 ? text.length : newlineIndex + 1;
    const chunk = text.slice(start, end);
    const line = chunk.endsWith("\n") ? chunk.slice(0, -1).replace(/\r$/, "") : chunk;
    const isInternalPlaceholder =
      TOOL_CALLS_OMITTED_PLACEHOLDER_LINE_RE.test(line) ||
      line.trim() === EXEC_NO_OUTPUT_PLACEHOLDER;
    if (
      !isInternalPlaceholder ||
      isInsideCode(start, (protectedRegions ??= findCodeRegions(text)))
    ) {
      result += chunk;
    }
    start = end;
  }
  return result;
}

function stripVerifiedConversationContext(
  text: string,
  conversationContext?: string,
  streaming = false,
): string {
  const source = conversationContext?.trim();
  if (
    !source ||
    (!source.includes(HISTORY_CONTEXT_MARKER) && !source.includes(CURRENT_MESSAGE_MARKER))
  ) {
    return text;
  }
  const containsConversationMarker =
    text.includes(HISTORY_CONTEXT_MARKER) || text.includes(CURRENT_MESSAGE_MARKER);
  if (!streaming && !containsConversationMarker) {
    return text;
  }
  const sourceCodeRegions = findCodeRegions(source);
  const ownsConversationContext = [HISTORY_CONTEXT_MARKER, CURRENT_MESSAGE_MARKER].some(
    (marker) => {
      let markerOffset = source.indexOf(marker);
      while (markerOffset !== -1) {
        const markerEnd = markerOffset + marker.length;
        const startsLine = markerOffset === 0 || source[markerOffset - 1] === "\n";
        const endsLine =
          markerEnd === source.length || source[markerEnd] === "\n" || source[markerEnd] === "\r";
        if (startsLine && endsLine && !isInsideCode(markerOffset, sourceCodeRegions)) {
          return true;
        }
        markerOffset = source.indexOf(marker, markerEnd);
      }
      return false;
    },
  );
  if (!ownsConversationContext) {
    return text;
  }

  const normalizedSource = source.replace(/\r\n?/gu, "\n");
  let result = text;
  if (containsConversationMarker) {
    const quotedLinePrefix = "(?:[ \\t]{0,3}>[ \\t]?)*";
    const promptPattern = normalizedSource
      .split("\n")
      .map(escapeRegExp)
      .join(`\\r?\\n${quotedLinePrefix}`);
    const copiedPrompt = new RegExp(`(?:^[ \\t]{0,3}(?:>[ \\t]?)+)?${promptPattern}`, "gmu");
    // Markdown formatting does not make an exact owner-bound private prompt safe to disclose.
    result = text.replace(copiedPrompt, "");
  }
  if (!streaming) {
    return result;
  }

  const sourceStart = normalizedSource[0];
  if (!sourceStart) {
    return result;
  }
  // CRLF can double the raw length of a normalized prompt; earlier bytes cannot form its suffix.
  const searchStart = Math.max(0, result.length - normalizedSource.length * 2);
  let candidateStart = result.indexOf(sourceStart, searchStart);
  while (candidateStart !== -1) {
    const suffix = result.slice(candidateStart).replace(/\r\n?/gu, "\n");
    const unquotedSuffix = suffix
      .replace(/\n(?:[ \t]{0,3}>[ \t]?)+/gu, "\n")
      .replace(/\n[ \t]{1,3}$/u, "\n");
    if (
      (suffix.length < normalizedSource.length && normalizedSource.startsWith(suffix)) ||
      (unquotedSuffix.length < normalizedSource.length &&
        normalizedSource.startsWith(unquotedSuffix))
    ) {
      // A later stream update can complete private prompt bytes that cannot be retracted once sent.
      return result.slice(0, candidateStart);
    }
    candidateStart = result.indexOf(sourceStart, candidateStart + 1);
  }
  return result;
}

function collapseConsecutiveDuplicateBlocks(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }
  const blocks = trimmed.split(/\n{2,}/);
  if (blocks.length < 2) {
    return text;
  }
  const result: string[] = [];
  let lastNormalized: string | null = null;
  for (const block of blocks) {
    const normalized = block.trim().replace(/\s+/g, " ");
    if (lastNormalized && normalized === lastNormalized) {
      continue;
    }
    result.push(block.trim());
    lastNormalized = normalized;
  }
  return result.length === blocks.length ? text : result.join("\n\n");
}

export function sanitizeUserFacingText(
  text: unknown,
  opts?: { errorContext?: boolean; conversationContext?: string; streaming?: boolean },
): string {
  const raw = coerceChatContentText(text);
  if (!raw) {
    return raw;
  }
  const withoutConversationContext = stripVerifiedConversationContext(
    raw,
    opts?.conversationContext,
    opts?.streaming,
  );
  const stripped = stripInboundMetadata(
    stripInternalRuntimeContext(stripFinalTagsFromText(withoutConversationContext)),
  );
  const withoutToolCallXml = stripToolCallXmlTags(stripMinimaxToolCallXml(stripped), {
    stripFunctionCallsXmlPayloads: true,
  });
  // Replay repair and empty exec output produce placeholders that never belong in visible replies.
  const withoutPlaceholder = stripInternalPlaceholderLines(withoutToolCallXml);
  const withoutInternalTraceLines = opts?.errorContext
    ? stripAssistantInternalTraceLines(withoutPlaceholder)
    : withoutPlaceholder;
  const withoutToolCallBlocks = stripPlainTextToolCallBlocks(
    stripLegacyBracketToolCallBlocks(withoutInternalTraceLines),
    { resolveProtectedRanges: findCodeRegions },
  );
  if (!withoutToolCallBlocks.trim()) {
    return "";
  }
  const withoutLeadingEmptyLines = withoutToolCallBlocks.replace(/^(?:[ \t]*\r?\n)+/, "");
  return collapseConsecutiveDuplicateBlocks(withoutLeadingEmptyLines);
}
