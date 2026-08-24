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
    return value.map((entry) => sanitizeContextJsonValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeContextJsonValue(entry)]),
  );
}

export function formatContextJsonBlock(label: string, payload: unknown): string {
  return [label, "```json", JSON.stringify(sanitizeContextJsonValue(payload)), "```"].join("\n");
}
