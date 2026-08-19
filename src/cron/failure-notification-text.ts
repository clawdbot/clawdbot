import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { FailoverReason } from "../agents/failover/signal.js";
import { redactToolPayloadText } from "../logging/redact.js";

const GENERIC_FAILURE_DETAIL = "Check automation history for details.";
const EXTERNAL_CONTENT_MARKERS = [
  "EXTERNAL_UNTRUSTED_CONTENT",
  "SECURITY NOTICE: The following content is from an EXTERNAL, UNTRUSTED source",
];

function safeFailureDetail(rawError: string | undefined): string | undefined {
  if (!rawError || EXTERNAL_CONTENT_MARKERS.some((marker) => rawError.includes(marker))) {
    return undefined;
  }
  const firstLine = rawError.split(/\r\n?|[\n\u2028\u2029]/u).find((line) => line.trim());
  if (!firstLine) {
    return undefined;
  }
  const detail = redactToolPayloadText(sanitizeTerminalText(firstLine.replace(/\s+/gu, " ").trim()))
    .replace(/\s+/gu, " ")
    .trim();
  if (!detail) {
    return undefined;
  }
  return detail.length > 200 ? `${truncateUtf16Safe(detail, 199)}…` : detail;
}

/** Renders compact, safe failure context for operator-facing automation chat. */
export function cronFailureDetailLines(
  errorReason: FailoverReason | undefined,
  rawError?: string,
  detailLabel: "Last error" | "Skip reason" = "Last error",
): string[] {
  if (errorReason) {
    return [`Cause: ${errorReason}`];
  }
  const detail = safeFailureDetail(rawError);
  return detail ? [`${detailLabel}: ${detail}`] : [GENERIC_FAILURE_DETAIL];
}
