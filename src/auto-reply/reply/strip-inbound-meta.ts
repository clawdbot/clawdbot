/**
 * Strips OpenClaw-injected inbound metadata blocks from a user-role message
 * text before it is displayed in any UI surface (TUI, webchat, macOS app) or
 * replayed as historical context to the model.
 *
 * Background: `buildInboundUserContextPrefix` in `inbound-meta.ts` prepends
 * structured metadata blocks (Conversation info, Sender info, reply context,
 * etc.) directly to the stored user message content so the LLM can access
 * them. These blocks are current-turn AI-facing context only and must never
 * surface in user-visible chat history or accumulate in historical prompt
 * replay.
 *
 * Also strips the timestamp prefix injected by `injectTimestamp` so UI surfaces
 * do not show AI-facing envelope metadata as user text.
 *
 * Detection: every OpenClaw-injected context header is stamped with a fixed
 * provenance marker `⟦openclaw:ctx⟧`. Strippers key on this marker rather than
 * on label text, making detection label-agnostic (arbitrary structured labels
 * are supported) and collision-free (user text never carries the marker). This
 * fixes both label collision risks (e.g., `Sender:` in natural prose) and the
 * structured-context over-strip (arbitrary plugin labels are now recognized).
 */

import { MESSAGE_TOOL_DELIVERY_HINTS } from "./delivery-hints.js";
import { INBOUND_CONTEXT_MARKER } from "./inbound-context-marker.js";

const LEADING_TIMESTAMP_PREFIX_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;

const CHANNEL_CONTEXT_HEADER = `Context: ${INBOUND_CONTEXT_MARKER}`;
const ACTIVE_MEMORY_CONTEXT_HEADER = "Context:";
const ACTIVE_MEMORY_OPEN_TAG = "<active_memory_plugin>";
const ACTIVE_MEMORY_CLOSE_TAG = "</active_memory_plugin>";

// Detect a context header line by marker suffix (label-agnostic, collision-free).
function isInboundContextHeaderLine(line: string): boolean {
  const t = line.trim();
  return t.length > INBOUND_CONTEXT_MARKER.length && t.endsWith(INBOUND_CONTEXT_MARKER);
}

// Pre-compiled fast-path regex — avoids line-by-line parse when no blocks present.
// Active-memory's bare Context: sentinel is valid only as a complete line.
const SENTINEL_SUBSTRING_ALTERNATIVES = [INBOUND_CONTEXT_MARKER, ...MESSAGE_TOOL_DELIVERY_HINTS]
  .map((sentinel) => sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const ACTIVE_MEMORY_HEADER_ESCAPED = ACTIVE_MEMORY_CONTEXT_HEADER.replace(
  /[.*+?^${}()|[\]\\]/g,
  "\\$&",
);
const SENTINEL_FAST_RE = new RegExp(
  `${SENTINEL_SUBSTRING_ALTERNATIVES}|^[ \t]*${ACTIVE_MEMORY_HEADER_ESCAPED}[ \t]*$`,
  "m",
);

/** Fast check for whether text contains any inbound metadata sentinel. */
export function hasInboundMetadataSentinel(text: string): boolean {
  return Boolean(text && SENTINEL_FAST_RE.test(text));
}

function isMessageToolDeliveryHintLine(line: string): boolean {
  const trimmed = line.trim();
  return MESSAGE_TOOL_DELIVERY_HINTS.some((hint) => hint === trimmed);
}

function skipChatWindowContextBlock(lines: string[], index: number): number {
  let next = index + 1;
  while (next < lines.length && lines[next]?.trim() !== "") {
    next++;
  }
  while (next < lines.length && lines[next]?.trim() === "") {
    next++;
  }
  return next;
}

function restoreNeutralizedMarkdownFences(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replaceAll("`\u200b``", "```");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => restoreNeutralizedMarkdownFences(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, restoreNeutralizedMarkdownFences(entry)]),
  );
}

function parseJsonObjectRecord(jsonText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseInboundMetaBlock(
  lines: string[],
  sentinelBase: string,
): Record<string, unknown> | null {
  // Match the marked header line: sentinelBase + marker.
  const markedSentinel = `${sentinelBase} ${INBOUND_CONTEXT_MARKER}`;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() !== markedSentinel) {
      continue;
    }
    if (lines[i + 1]?.trim() !== "```json") {
      return null;
    }
    let end = i + 2;
    while (end < lines.length && lines[end]?.trim() !== "```") {
      end += 1;
    }
    if (end >= lines.length) {
      return null;
    }
    const jsonText = lines
      .slice(i + 2, end)
      .join("\n")
      .trim();
    if (!jsonText) {
      return null;
    }
    const parsed = parseJsonObjectRecord(jsonText);
    return parsed ? (restoreNeutralizedMarkdownFences(parsed) as Record<string, unknown>) : null;
  }
  return null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function shouldStripTrailingContextBlock(lines: string[], index: number): boolean {
  return lines[index]?.trim() === CHANNEL_CONTEXT_HEADER;
}

function stripTrailingContextBlockSuffix(lines: string[]): string[] {
  for (let i = 0; i < lines.length; i++) {
    if (!shouldStripTrailingContextBlock(lines, i)) {
      continue;
    }
    let end = i;
    while (end > 0 && lines[end - 1]?.trim() === "") {
      end -= 1;
    }
    return lines.slice(0, end);
  }
  return lines;
}

function stripActiveMemoryPromptPrefixBlocks(lines: string[]): string[] {
  const result: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines.at(index);
    if (line === undefined) {
      break;
    }
    if (
      line.trim() === ACTIVE_MEMORY_CONTEXT_HEADER &&
      lines[index + 1]?.trim() === ACTIVE_MEMORY_OPEN_TAG
    ) {
      let closeIndex = -1;
      for (let probe = index + 2; probe < lines.length; probe += 1) {
        if (lines[probe]?.trim() === ACTIVE_MEMORY_CLOSE_TAG) {
          closeIndex = probe;
          break;
        }
      }
      if (closeIndex !== -1) {
        index = closeIndex;
        while (index + 1 < lines.length && lines[index + 1]?.trim() === "") {
          index += 1;
        }
        continue;
      }
    }

    result.push(line);
  }

  return result;
}

/**
 * Remove all injected inbound metadata prefix blocks from `text`.
 *
 * Each block has the shape:
 *
 * ```
 * <header-with-marker>
 * ```json
 * { … }
 * ```
 * ```
 *
 * Returns the original string reference unchanged when no metadata is present
 * (fast path — zero allocation).
 */
/** Strips all injected inbound metadata blocks from user-visible text. */
export function stripInboundMetadata(text: string): string {
  if (!text) {
    return text;
  }

  const withoutTimestamp = text.replace(LEADING_TIMESTAMP_PREFIX_RE, "");
  if (!SENTINEL_FAST_RE.test(withoutTimestamp)) {
    return withoutTimestamp;
  }

  const lines = withoutTimestamp.split("\n");
  const strippedLeadingPrefixLines = stripActiveMemoryPromptPrefixBlocks(lines);
  const result: string[] = [];
  let inMetaBlock = false;
  let inFencedJson = false;

  for (let i = 0; i < strippedLeadingPrefixLines.length; i++) {
    const line = strippedLeadingPrefixLines.at(i);
    if (line === undefined) {
      break;
    }
    // Channel context is appended by OpenClaw as a terminal metadata suffix.
    // When this structured header appears, drop it and everything that follows.
    if (!inMetaBlock && shouldStripTrailingContextBlock(strippedLeadingPrefixLines, i)) {
      break;
    }

    if (!inMetaBlock && isMessageToolDeliveryHintLine(line)) {
      continue;
    }

    // Detect start of a metadata block: header line ending with marker.
    if (!inMetaBlock && isInboundContextHeaderLine(line)) {
      const next = strippedLeadingPrefixLines[i + 1];
      if (next?.trim() !== "```json") {
        // Prose body (no JSON fence) — skip to blank line.
        i = skipChatWindowContextBlock(strippedLeadingPrefixLines, i) - 1;
        continue;
      }
      inMetaBlock = true;
      inFencedJson = false;
      continue;
    }

    if (inMetaBlock) {
      if (!inFencedJson && line.trim() === "```json") {
        inFencedJson = true;
        continue;
      }
      if (inFencedJson) {
        if (line.trim() === "```") {
          inMetaBlock = false;
          inFencedJson = false;
        }
        continue;
      }
      // Blank separator lines between consecutive blocks are dropped.
      if (line.trim() === "") {
        continue;
      }
      // Unexpected non-blank line outside a fence — treat as user content.
      inMetaBlock = false;
    }

    result.push(line);
  }

  return result
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .replace(LEADING_TIMESTAMP_PREFIX_RE, "");
}

/** Strips only leading inbound metadata blocks while preserving later user text. */
export function stripLeadingInboundMetadata(text: string): string {
  if (!text || !SENTINEL_FAST_RE.test(text)) {
    return text;
  }

  const lines = stripActiveMemoryPromptPrefixBlocks(text.split("\n"));
  let index = 0;

  while (lines.at(index) === "") {
    index++;
  }
  const firstLine = lines.at(index);
  if (firstLine === undefined) {
    return "";
  }

  const strippedDeliveryHint = isMessageToolDeliveryHintLine(firstLine);
  while (true) {
    const line = lines.at(index);
    if (line === undefined || !isMessageToolDeliveryHintLine(line)) {
      break;
    }
    index++;
    while (lines.at(index) === "") {
      index++;
    }
  }
  const firstContentLine = lines.at(index);
  if (firstContentLine === undefined) {
    return "";
  }

  if (!isInboundContextHeaderLine(firstContentLine)) {
    const strippedNoLeading = stripTrailingContextBlockSuffix(
      strippedDeliveryHint ? lines.slice(index) : lines,
    );
    return strippedNoLeading.join("\n");
  }

  while (index < lines.length) {
    const line = lines.at(index);
    if (line === undefined) {
      break;
    }
    if (!isInboundContextHeaderLine(line)) {
      break;
    }

    if (lines[index + 1]?.trim() !== "```json") {
      // Prose body — skip to blank line.
      index = skipChatWindowContextBlock(lines, index);
      continue;
    }

    index++;
    if (lines.at(index)?.trim() === "```json") {
      index++;
      while (index < lines.length && lines.at(index)?.trim() !== "```") {
        index++;
      }
      if (lines.at(index)?.trim() === "```") {
        index++;
      }
    } else {
      return text;
    }

    while (lines.at(index)?.trim() === "") {
      index++;
    }
  }

  const strippedRemainder = stripTrailingContextBlockSuffix(lines.slice(index));
  return strippedRemainder.join("\n");
}

/** Extracts the sender label from injected inbound metadata when present. */
export function extractInboundSenderLabel(text: string): string | null {
  if (!text || !SENTINEL_FAST_RE.test(text)) {
    return null;
  }

  const lines = text.split("\n");
  const senderInfo = parseInboundMetaBlock(lines, "Sender:");
  const conversationInfo = parseInboundMetaBlock(lines, "Conversation info:");
  const conversationSender = conversationInfo?.sender;
  const conversationSenderFields =
    conversationSender &&
    typeof conversationSender === "object" &&
    !Array.isArray(conversationSender)
      ? [
          (conversationSender as Record<string, unknown>)["name"],
          (conversationSender as Record<string, unknown>)["username"],
          (conversationSender as Record<string, unknown>)["e164"],
          (conversationSender as Record<string, unknown>)["id"],
        ]
      : [conversationSender];
  return firstNonEmptyString(
    senderInfo?.label,
    senderInfo?.name,
    senderInfo?.username,
    senderInfo?.e164,
    senderInfo?.id,
    ...conversationSenderFields,
  );
}
