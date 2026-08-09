/** Appends channel-supplied prompt context to the user-role body under a marked label. */
import { truncateUtf16Safe } from "../../utils.js";
import { markInboundContextLabel } from "./inbound-context-marker.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";

/**
 * The fixed marker lets strippers recognize OpenClaw-injected context; it is not
 * a trust guardrail. Trust guidance travels with each entry instead
 * (`buildChannelMetadata` wraps entries in `wrapExternalContent`, whose SECURITY
 * NOTICE carries the do-not-obey clause).
 */
export function appendChannelPromptContext(base: string, channelPromptContext?: string[]): string {
  if (!Array.isArray(channelPromptContext) || channelPromptContext.length === 0) {
    return base;
  }
  const entries = channelPromptContext
    .map((entry) => normalizeInboundTextNewlines(entry))
    .filter((entry) => Boolean(entry));
  if (entries.length === 0) {
    return base;
  }
  const header = markInboundContextLabel("Context:");
  const block = [header, ...entries].join("\n");
  return [base, block].filter(Boolean).join("\n\n");
}

export const MAX_CONTEXT_JSON_STRING_CHARS = 2_000;
// Same untrusted-entry budget as inbound-meta.ts (MAX_UNTRUSTED_HISTORY_ENTRIES):
// repeated channel-supplied entries are capped at that count.
export const MAX_CONTEXT_JSON_ARRAY_ENTRIES = 20;
// The largest first-party payload (the Conversation info block) carries ~25 keys;
// 50 leaves headroom while bounding channel-controlled key fan-out.
export const MAX_CONTEXT_JSON_OBJECT_KEYS = 50;

export function neutralizeMarkdownFences(value: string): string {
  return value.replaceAll("```", "`\u200b``");
}

function truncateContextJsonString(value: string): string {
  if (value.length <= MAX_CONTEXT_JSON_STRING_CHARS) {
    return value;
  }
  return `${truncateUtf16Safe(value, Math.max(0, MAX_CONTEXT_JSON_STRING_CHARS - 14)).trimEnd()}…[truncated]`;
}

function sanitizeContextJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return neutralizeMarkdownFences(truncateContextJsonString(value));
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_CONTEXT_JSON_ARRAY_ENTRIES);
    const omitted = value.length - kept.length;
    return [
      ...kept.map((entry) => sanitizeContextJsonValue(entry)),
      // Keep the head like truncateContextJsonString does, and flag the drop.
      ...(omitted > 0
        ? [`…[truncated: ${omitted} more ${omitted === 1 ? "entry" : "entries"}]`]
        : []),
    ];
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value);
  const kept = entries.slice(0, MAX_CONTEXT_JSON_OBJECT_KEYS);
  const omitted = entries.length - kept.length;
  return Object.fromEntries([
    ...kept.map(([key, entry]) => [key, sanitizeContextJsonValue(entry)] as const),
    // Truncation flag mirrors the sibling `history_truncated: true` convention.
    ...(omitted > 0
      ? [[`…[truncated: ${omitted} more ${omitted === 1 ? "key" : "keys"}]`, true] as const]
      : []),
  ]);
}

export function formatContextJsonBlock(label: string, payload: unknown): string {
  return [label, "```json", JSON.stringify(sanitizeContextJsonValue(payload)), "```"].join("\n");
}
