import { Buffer } from "node:buffer";

const CODEX_HISTORY_IMPORT_MAX_MESSAGE_BYTES = 64 * 1024;
const CODEX_HISTORY_TRUNCATION_SUFFIX = "\n\n[Message truncated during Codex history import.]";

function isUtf8ContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function truncateUtf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  let end = Math.max(0, maxBytes);
  while (end > 0 && isUtf8ContinuationByte(bytes[end])) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

/** How history import stores a single upstream text value: trimmed, and capped so one
 * message cannot consume the whole import budget. Drift checks must compare against
 * this projection rather than raw upstream text, or a stored entry reads as divergence. */
export function normalizeImportedHistoryText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  if (!text) {
    return undefined;
  }
  if (Buffer.byteLength(text, "utf8") <= CODEX_HISTORY_IMPORT_MAX_MESSAGE_BYTES) {
    return text;
  }
  const suffixBytes = Buffer.byteLength(CODEX_HISTORY_TRUNCATION_SUFFIX, "utf8");
  const contentLimitBytes = Math.max(0, CODEX_HISTORY_IMPORT_MAX_MESSAGE_BYTES - suffixBytes);
  return `${truncateUtf8Prefix(text, contentLimitBytes)}${CODEX_HISTORY_TRUNCATION_SUFFIX}`;
}

/** Project the ordered parts of one upstream user message the way import stores it:
 * each part normalized, empties dropped, joined, then normalized again so the joined
 * result also respects the per-message cap. */
export function projectImportedHistoryTextParts(rawParts: readonly string[]): string | undefined {
  const parts: string[] = [];
  for (const raw of rawParts) {
    const text = normalizeImportedHistoryText(raw);
    if (text) {
      parts.push(text);
    }
  }
  return normalizeImportedHistoryText(parts.join("\n"));
}
