import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

// Match only the complete, no-warning frame emitted by the Gateway catalog copy.
// Anchoring protects quoted/fenced examples and truncated or malformed history.
// The optional label belongs to session-catalog-history-import, not to the frame.
const IMPORT_FRAME =
  /^(?<label>(?:Thinking|Tool call|Tool result|Other)\r?\n\r?\n)?<<<EXTERNAL_UNTRUSTED_CONTENT id="(?<id>[a-f0-9]{16})">>>\r?\nSource: External\r?\n---\r?\n(?<body>[\s\S]*?)\r?\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\k<id>">>>$/u;

function unwrapImportFrame(text: string): string {
  const match = IMPORT_FRAME.exec(text);
  return match?.groups ? (match.groups.label ?? "") + match.groups.body : text;
}

/**
 * Presentation-only copy. Stored history and model context must retain their
 * untrusted-content framing. Never infer import provenance from message text:
 * ordinary user/assistant messages can intentionally quote an entire wrapper.
 */
export function projectImportedMessageForDisplay(message: unknown): unknown {
  const record = asOptionalRecord(message);
  if (!record || (record.role !== "user" && record.role !== "assistant")) {
    return message;
  }
  const metadata = asOptionalRecord(record["__openclaw"]);
  // History reads project the persisted key into __openclaw; inline events can
  // still carry it at the top level. Both originate at the catalog importer.
  const importKey = metadata?.idempotencyKey ?? record.idempotencyKey;
  if (typeof importKey !== "string" || !/^[^:\s]+-catalog:/u.test(importKey)) {
    return message;
  }
  const content = record.content;
  return {
    ...record,
    ...(typeof record.text === "string" ? { text: unwrapImportFrame(record.text) } : {}),
    ...(typeof content === "string"
      ? { content: unwrapImportFrame(content) }
      : Array.isArray(content)
        ? {
            content: content.map((value) => {
              const block = asOptionalRecord(value);
              return block &&
                typeof block.text === "string" &&
                (block.type === "text" ||
                  block.type === "input_text" ||
                  (record.role === "assistant" && block.type === "output_text"))
                ? Object.assign({}, block, { text: unwrapImportFrame(block.text) })
                : value;
            }),
          }
        : {}),
  };
}
