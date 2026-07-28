import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";

/** Native transcript metadata remains authoritative over event and legacy IDs. */
export function readChatThreadSourceMessageId(message: unknown): string | null {
  const record = asRecord(message);
  if (!record) {
    return null;
  }
  const openclawId = asRecord(record["__openclaw"])?.id;
  if (typeof openclawId === "string" && openclawId.trim()) {
    return openclawId.trim();
  }
  const messageId = typeof record.messageId === "string" ? record.messageId.trim() : "";
  if (messageId) {
    return messageId;
  }
  const id = typeof record.id === "string" ? record.id.trim() : "";
  return id || null;
}

/** Provider-local IDs may identify a bubble only inside their complete import source. */
export function readChatThreadDuplicateSourceKey(
  message: unknown,
  role: string,
  nativeMessageId: string | null,
): string | null {
  if (role !== "assistant" && role !== "user") {
    return null;
  }
  const identity = readSessionMessageIdentity(message);
  if (!identity?.isImported) {
    return nativeMessageId ? `${role}:${nativeMessageId}` : null;
  }
  if (identity.externalSource) {
    return `${role}:import:${identity.externalSource}`;
  }
  return identity.sequence === null ? null : `${role}:import-seq:${identity.sequence}`;
}

/** Without a source tuple or persisted position, equal display text cannot prove an import replay. */
export function isUnprovenImportedChatThreadMessage(message: unknown): boolean {
  const identity = readSessionMessageIdentity(message);
  return (
    identity?.isImported === true && identity.externalSource === null && identity.sequence === null
  );
}
