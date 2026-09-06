import { GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT } from "@openclaw/gateway-protocol/gateway-error-details";
import { asNullableRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionProjectionString as readNonemptyString } from "./session-projection-message-identity.js";

export function readSessionMessageDisplayContent(message: unknown): {
  text: string;
  hasNonText: boolean;
  usesFallbackText: boolean;
} {
  const record = readRecord(message);
  const content = typeof message === "string" ? message : record?.content;
  const media = readRecord(record?.["__openclaw"])?.media;
  let hasNonText = Array.isArray(media) && media.length > 0;
  const texts: string[] = [];
  for (const block of Array.isArray(content) ? content : [content]) {
    const entry = readRecord(block);
    if (
      entry &&
      entry.type !== "text" &&
      entry.type !== "input_text" &&
      entry.type !== "output_text"
    ) {
      hasNonText ||=
        entry.type !== "thinking" &&
        entry.type !== "reasoning" &&
        entry.type !== "redacted_thinking";
      continue;
    }
    const text = readNonemptyString(entry ? entry.text : block);
    if (text) {
      texts.push(text);
    }
  }
  const fallback = texts.length === 0 ? readNonemptyString(record?.text) : null;
  return { text: fallback ?? texts.join("\n"), hasNonText, usesFallbackText: fallback !== null };
}

function normalizeChatErrorComparisonText(text: string): string {
  return text
    .trim()
    .replace(/^⚠️\s*/u, "")
    .replace(/^Error:\s*/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Diagnostic-only error projections can be retired when their run resumes. */
export function isSessionProjectionErrorMessage(message: unknown, errorMessage?: string): boolean {
  const role = readRecord(message)?.role;
  if (typeof role === "string" && role.trim().toLowerCase() !== "assistant") {
    return false;
  }
  const { text, hasNonText } = readSessionMessageDisplayContent(message);
  const normalizedText = normalizeChatErrorComparisonText(text);
  return (
    !hasNonText &&
    (!normalizedText ||
      normalizedText === "[assistant turn failed before producing content]" ||
      normalizedText === GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT ||
      normalizedText === normalizeChatErrorComparisonText(errorMessage ?? ""))
  );
}
