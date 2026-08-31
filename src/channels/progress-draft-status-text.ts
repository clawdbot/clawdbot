// Progress-draft status text normalization for reasoning, preamble, and commentary lanes.
import { formatReasoningMessage } from "../agents/embedded-agent-utils.js";
import { findCodeRegions, isInsideCode } from "../shared/text/code-regions.js";
import { stripInlineDirectiveTagsForDelivery } from "../utils/directive-tags.js";

const REASONING_PROGRESS_TAG_RE =
  /<\s*(\/?)\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/giu;
const REASONING_PROGRESS_TAG_NAMES = [
  "think",
  "thinking",
  "thought",
  "antthinking",
  "antml:think",
  "antml:thinking",
  "antml:thought",
  "mm:think",
  "mm:thinking",
  "mm:thought",
] as const;
const REASONING_PROGRESS_TAG_PREFIXES = REASONING_PROGRESS_TAG_NAMES.flatMap((name) => [
  `<${name}`,
  `</${name}`,
]);

export function normalizeReasoningProgressLine(text: string): string {
  const reasoningText = readReasoningProgressTextOutsideCode(text);
  if (reasoningText === undefined) {
    return "";
  }
  return stripReasoningProgressTagsOutsideCode(reasoningText)
    .replace(
      /^\s*(?:>\s*)?(?:Reasoning:\s*(?:\r?\n|\r)\s*|Thinking\.{0,3}\s*(?:\r?\n|\r)\s*(?:\r?\n|\r)\s*)/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function readReasoningProgressTextOutsideCode(text: string): string | undefined {
  if (isPartialReasoningProgressTagPrefix(text)) {
    // Hold partial tags until more bytes arrive; otherwise a streaming "<thi"
    // fragment can flash as user-visible progress.
    return undefined;
  }
  const codeRegions = findCodeRegions(text);
  let hasTags = false;
  let inReasoning = false;
  let cursor = 0;
  const chunks: string[] = [];
  for (const match of text.matchAll(REASONING_PROGRESS_TAG_RE)) {
    const offset = match.index ?? 0;
    if (isInsideCode(offset, codeRegions)) {
      // Preserve code examples that mention reasoning tags; only actual model
      // wrapper tags outside code delimit private reasoning progress.
      continue;
    }
    hasTags = true;
    if (match[1]) {
      if (inReasoning) {
        chunks.push(text.slice(cursor, offset));
      }
      inReasoning = false;
      cursor = offset + match[0].length;
      continue;
    }
    if (inReasoning) {
      chunks.push(text.slice(cursor, offset));
    }
    inReasoning = true;
    cursor = offset + match[0].length;
  }
  if (!hasTags) {
    return text;
  }
  if (inReasoning) {
    chunks.push(text.slice(cursor));
  }
  return chunks.join("").trim();
}

function isPartialReasoningProgressTagPrefix(text: string): boolean {
  const normalized = text.trimStart().toLowerCase();
  return (
    normalized.startsWith("<") &&
    !normalized.includes(">") &&
    REASONING_PROGRESS_TAG_PREFIXES.some(
      (prefix) => prefix.startsWith(normalized) || normalized.startsWith(prefix),
    )
  );
}

function stripReasoningProgressTagsOutsideCode(text: string): string {
  const codeRegions = findCodeRegions(text);
  return text.replace(REASONING_PROGRESS_TAG_RE, (match, _closing: string, offset: number) =>
    isInsideCode(offset, codeRegions) ? match : "",
  );
}

function normalizeReasoningProgressInput(text: string): string {
  const normalized = normalizeReasoningProgressLine(text);
  const italic = normalized.match(/^_(.*)_$/u);
  return (italic?.[1] ?? normalized).trim();
}

export function formatReasoningProgressDisplayLine(text: string, maxChars: number): string {
  const normalizedText = normalizeReasoningProgressInput(text);
  const formatted = normalizeReasoningProgressLine(formatReasoningMessage(normalizedText));
  if (!formatted) {
    return "";
  }
  if (Array.from(formatted).length <= maxChars) {
    return formatted;
  }
  const italic = formatted.match(/^_(.*)_$/u);
  if (!italic) {
    return compactReasoningProgressDisplayLine(formatted, maxChars);
  }
  const body = compactReasoningProgressDisplayLine(italic[1] ?? "", Math.max(1, maxChars - 2));
  return body ? `_${body}_` : "";
}

function compactReasoningProgressDisplayLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 1) {
    return "…";
  }
  const head = chars
    .slice(0, maxChars - 1)
    .join("")
    .trimEnd();
  const boundary = head.search(/\s+\S*$/u);
  if (boundary > Math.floor(maxChars * 0.6)) {
    return `${head.slice(0, boundary).trimEnd()}…`;
  }
  return `${head}…`;
}

export function sanitizeProgressStatusText(text: string): string {
  const cleaned = stripInlineDirectiveTagsForDelivery(text).text.trim();
  if (!cleaned || isSilentCommentaryProgressText(cleaned)) {
    return "";
  }
  return cleaned;
}

export function normalizeCommentaryProgressText(text: string): string {
  const cleaned = sanitizeProgressStatusText(text);
  if (!cleaned) {
    return "";
  }
  return cleaned
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((line) => `_${line}_`)
    .join("\n");
}

function isSilentCommentaryProgressText(text: string): boolean {
  const normalized = text.replace(/^[\s*_`~]+|[\s*_`~]+$/gu, "").trim();
  return /^NO_REPLY$/iu.test(normalized);
}

export function mergeReasoningProgressText(
  current: string,
  incoming: string,
  options?: { snapshot?: boolean },
): string {
  if (!current) {
    return incoming;
  }
  const normalizedCurrent = normalizeReasoningProgressInput(current);
  const normalizedIncoming = normalizeReasoningProgressInput(incoming);
  if (!normalizedIncoming) {
    return shouldAppendEmptyReasoningProgressDelta(current, incoming)
      ? `${current}${incoming}`
      : current;
  }
  if (normalizedIncoming === normalizedCurrent) {
    return current;
  }
  if (
    options?.snapshot === true ||
    isReasoningSnapshotText(incoming) ||
    (normalizedCurrent && normalizedIncoming.startsWith(normalizedCurrent))
  ) {
    // Snapshot-style providers resend the full reasoning text. Replace the
    // buffer instead of duplicating the already-seen prefix.
    return incoming;
  }
  return `${current}${incoming}`;
}

function isReasoningSnapshotText(text: string): boolean {
  return /^\s*(?:>\s*)?(?:Reasoning:\s*(?:\r?\n|\r)\s*|Thinking\.{0,3}\s*(?:\r?\n|\r)\s*(?:\r?\n|\r)\s*)/i.test(
    text,
  );
}

function shouldAppendEmptyReasoningProgressDelta(current: string, incoming: string): boolean {
  return (
    isPartialReasoningProgressTagPrefix(current) ||
    isPartialReasoningProgressTagPrefix(incoming) ||
    hasReasoningProgressTagOutsideCode(incoming)
  );
}

function hasReasoningProgressTagOutsideCode(text: string): boolean {
  const codeRegions = findCodeRegions(text);
  for (const match of text.matchAll(REASONING_PROGRESS_TAG_RE)) {
    if (!isInsideCode(match.index ?? 0, codeRegions)) {
      return true;
    }
  }
  return false;
}
