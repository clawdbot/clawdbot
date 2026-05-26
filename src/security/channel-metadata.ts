import { uniqueStrings } from "../shared/string-normalization.js";
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
  const trimmed = value.slice(0, Math.max(0, maxChars - 3)).trimEnd();
  return `${trimmed}...`;
}

export function buildUntrustedChannelMetadata(params: {
  source: string;
  label: string;
  entries: Array<string | null | undefined>;
  maxChars?: number;
}): string | undefined {
  const cleaned = params.entries
    .map((entry) => (typeof entry === "string" ? normalizeEntry(entry) : ""))
    .filter((entry) => Boolean(entry))
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
