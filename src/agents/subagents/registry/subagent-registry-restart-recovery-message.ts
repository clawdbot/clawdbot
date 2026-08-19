import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";

export function readSubagentRecoveryTranscriptMessage(
  message: unknown,
): { role?: string; text: string | null } | null {
  const record = asOptionalRecord(message);
  if (!record) {
    return null;
  }
  const role = readStringValue(record.role);
  if (typeof record.content === "string") {
    return { role, text: record.content.trim() || null };
  }
  if (Array.isArray(record.content)) {
    const text = record.content
      .flatMap((block) => {
        const blockText = readStringValue(asOptionalRecord(block)?.text)?.trim();
        return blockText ? [blockText] : [];
      })
      .join("\n")
      .trim();
    return { role, text: text || null };
  }
  const text = readStringValue(record.text)?.trim();
  return { role, text: text || null };
}
