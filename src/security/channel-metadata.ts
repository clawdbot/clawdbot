// Extracts channel metadata used by security audit findings.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { wrapExternalContent } from "./external-content.js";

const DEFAULT_MAX_CHARS = 800;
const DEFAULT_MAX_ENTRY_CHARS = 400;

function normalizeEntry(entry: string): string {
  return entry.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (value.length <= maxChars) {
    return value;
  }
  const trimmed = truncateUtf16Safe(value, Math.max(0, maxChars - 3)).trimEnd();
  return `${trimmed}...`;
}

/**
 * Build bounded, externally wrapped channel metadata for prompt context.
 * Channel-provided labels can be user-controlled, so callers must treat this as untrusted content.
 */
export function buildUntrustedChannelMetadata(params: {
  source: string;
  label: string;
  entries: Array<string | null | undefined>;
  maxChars?: number;
}): string | undefined {
  const cleaned = params.entries
    .map((entry) => (typeof entry === "string" ? normalizeEntry(entry) : ""))
    .filter((entry) => Boolean(entry))
    // Bound each entry before dedupe so one oversized metadata value cannot crowd out others.
    .map((entry) => truncateText(entry, DEFAULT_MAX_ENTRY_CHARS));
  const deduped = uniqueStrings(cleaned);
  if (deduped.length === 0) {
    return undefined;
  }

  const body = deduped.join("\n");
  const header = `UNTRUSTED channel metadata (${params.source})`;
  const labeled = `${params.label}:\n${body}`;
  const truncated = truncateText(`${header}\n${labeled}`, params.maxChars ?? DEFAULT_MAX_CHARS);

  return wrapExternalContent(truncated, {
    source: "channel_metadata",
    includeWarning: false,
  });
}
