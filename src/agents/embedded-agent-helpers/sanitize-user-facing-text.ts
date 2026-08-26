/** Strips internal scaffolding from text before user-facing delivery. */
import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/index.js";
import { stripInboundMetadata } from "../../auto-reply/reply/strip-inbound-meta.js";
import { coerceChatContentText } from "../../shared/chat-content.js";
import {
  stripAssistantInternalTraceLines,
  stripLegacyBracketToolCallBlocks,
  stripMinimaxToolCallXml,
  stripToolCallXmlTags,
} from "../../shared/text/assistant-visible-text.js";
import { findCodeRegions } from "../../shared/text/code-regions.js";
import { stripFinalTags } from "../../shared/text/final-tags.js";
import { stripInternalRuntimeContext } from "../internal-runtime-context.js";

const TOOL_CALLS_OMITTED_PLACEHOLDER_LINE_RE = /^[ \t]*\[tool calls omitted\][ \t]*$/i;

function stripFinalTagsFromText(text: unknown): string {
  const normalized = coerceChatContentText(text);
  return normalized ? stripFinalTags(normalized) : normalized;
}

function stripToolCallsOmittedPlaceholderLines(text: string): string {
  let result = "";
  let start = 0;
  while (start < text.length) {
    const newlineIndex = text.indexOf("\n", start);
    const end = newlineIndex === -1 ? text.length : newlineIndex + 1;
    const chunk = text.slice(start, end);
    const line = chunk.endsWith("\n") ? chunk.slice(0, -1).replace(/\r$/, "") : chunk;
    if (!TOOL_CALLS_OMITTED_PLACEHOLDER_LINE_RE.test(line)) {
      result += chunk;
    }
    start = end;
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

export function sanitizeUserFacingText(text: unknown, opts?: { errorContext?: boolean }): string {
  const raw = coerceChatContentText(text);
  if (!raw) {
    return raw;
  }
  const stripped = stripInboundMetadata(stripInternalRuntimeContext(stripFinalTagsFromText(raw)));
  const withoutToolCallXml = stripToolCallXmlTags(stripMinimaxToolCallXml(stripped), {
    stripFunctionCallsXmlPayloads: true,
  });
  // Replay repair may synthesize this placeholder to keep provider transcripts valid.
  // It is internal scaffolding, so drop standalone placeholder lines before delivery.
  const withoutPlaceholder = stripToolCallsOmittedPlaceholderLines(withoutToolCallXml);
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
