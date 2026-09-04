import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { extractAssistantPhaseText } from "../../../shared/chat-message-content.js";

export function readSubagentRecoveryTranscriptMessage(
  message: unknown,
): { role?: string; text: string } | null {
  const record = asOptionalRecord(message);
  if (!record) {
    return null;
  }
  const role = typeof record.role === "string" ? record.role : undefined;
  const projected =
    role === "assistant"
      ? record
      : {
          content: Array.isArray(record.content)
            ? record.content.map((block) => ({
                type: "text",
                text: asOptionalRecord(block)?.text,
              }))
            : (record.content ?? record.text),
        };
  const text = extractAssistantPhaseText(projected);
  return text ? { role, text } : null;
}
