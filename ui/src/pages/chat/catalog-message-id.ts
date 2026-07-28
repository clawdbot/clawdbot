// Catalog transcript pagination owns its message-id normalization separately
// from live history merging so wrapped provider records keep their identity.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

export function catalogMessageId(message: unknown): string | null {
  const messageId = asNullableRecord(message)?.messageId;
  return typeof messageId === "string" && messageId ? messageId : null;
}
