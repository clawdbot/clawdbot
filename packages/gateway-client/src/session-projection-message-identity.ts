import { asNullableRecord as readRecord } from "@openclaw/normalization-core/record-coerce";

export type SessionMessageEnvelope = {
  messageId?: unknown;
  messageSeq?: unknown;
  clientRunId?: unknown;
  runId?: unknown;
  idempotencyKey?: unknown;
};

export type SessionMessageIdentity = {
  role: string;
  id: string | null;
  sequence: number | null;
  idempotencyKey: string | null;
  runId: string | null;
  isImported: boolean;
  externalSource: string | null;
};

export function readSessionProjectionString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function readPositiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** History and status markers carry transcript order even when they have no chat role. */
export function readSessionMessageSequence(
  message: unknown,
  envelope?: SessionMessageEnvelope,
): number | null {
  const metadata = readRecord(readRecord(message)?.["__openclaw"]);
  return readPositiveSafeInteger(metadata?.seq) ?? readPositiveSafeInteger(envelope?.messageSeq);
}

/** Run ownership normalizes a user-turn suffix without changing its persisted send key. */
export function normalizeSessionProjectionRunId(value: unknown): string | null {
  const runId = readSessionProjectionString(value);
  return runId?.endsWith(":user") ? runId.slice(0, -":user".length) || null : runId;
}

/** Persisted row facts win; assistant run ownership comes from its authoritative producer. */
export function readSessionMessageIdentity(
  message: unknown,
  envelope?: SessionMessageEnvelope,
): SessionMessageIdentity | null {
  const record = readRecord(message);
  const role = readSessionProjectionString(record?.role)?.toLowerCase();
  if (!record || !role) {
    return null;
  }
  const metadata = readRecord(record["__openclaw"]);
  const importedFrom = readSessionProjectionString(metadata?.importedFrom);
  const cliSessionId = readSessionProjectionString(metadata?.cliSessionId);
  const externalId = readSessionProjectionString(metadata?.externalId);
  const idempotencyKey =
    readSessionProjectionString(metadata?.idempotencyKey) ??
    readSessionProjectionString(record.idempotencyKey) ??
    readSessionProjectionString(envelope?.idempotencyKey) ??
    readSessionProjectionString(envelope?.clientRunId);
  const persistedRunId = normalizeSessionProjectionRunId(idempotencyKey);
  const envelopeRunId = normalizeSessionProjectionRunId(envelope?.runId);
  const metadataRunId = normalizeSessionProjectionRunId(metadata?.runId);
  const mirroredMessage = readSessionProjectionString(metadata?.mirrorOrigin) !== null;
  // CLI persistence namespaces assistant send keys; the suffix is the
  // originating Gateway run identity consumed by every projection layer.
  const isCliAssistant =
    role === "assistant" && readSessionProjectionString(record.api)?.toLowerCase() === "cli";
  const canonicalPersistedRunId =
    isCliAssistant && persistedRunId?.startsWith("cli-assistant:")
      ? readSessionProjectionString(persistedRunId.slice("cli-assistant:".length))
      : persistedRunId;
  const optimisticRunId =
    metadata && Object.keys(metadata).every((key) => key === "idempotencyKey")
      ? canonicalPersistedRunId
      : null;
  return {
    role,
    id:
      readSessionProjectionString(metadata?.id) ?? readSessionProjectionString(envelope?.messageId),
    sequence: readSessionMessageSequence(message, envelope),
    idempotencyKey,
    runId:
      role === "assistant"
        ? (metadataRunId ??
          envelopeRunId ??
          (isCliAssistant || !mirroredMessage ? canonicalPersistedRunId : null) ??
          optimisticRunId)
        : (metadataRunId ?? canonicalPersistedRunId ?? envelopeRunId),
    isImported: Boolean(importedFrom || cliSessionId || externalId),
    // Imported IDs belong to their provider and CLI session, never the native ID namespace.
    externalSource:
      importedFrom && cliSessionId && externalId
        ? JSON.stringify([importedFrom, cliSessionId, externalId])
        : null,
  };
}
