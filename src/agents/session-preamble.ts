import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeProgressStatusText } from "../channels/progress-draft-status-text.js";
import { stripMarkdown } from "../shared/text/strip-markdown.js";

export function normalizeSessionPreambleText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") {
    return "";
  }
  const sanitized = sanitizeProgressStatusText(value);
  if (!sanitized) {
    return "";
  }
  const normalized = stripMarkdown(sanitized, { linkStyle: "label" }).replace(/\s+/gu, " ").trim();
  return truncateUtf16Safe(normalized, maxChars);
}
