// Transcript event helpers serialize and trim session transcript events.
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Normalized transcript update emitted after a session transcript changes. */
export type SessionTranscriptUpdate = {
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  message?: unknown;
  messageId?: string;
  messageSeq?: number;
};

type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;

const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();

/** Registers a listener for normalized session transcript updates. */
export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

/** Emits a normalized transcript update to all registered listeners. */
export function emitSessionTranscriptUpdate(update: string | SessionTranscriptUpdate): void {
  const normalized =
    typeof update === "string"
      ? { sessionFile: update }
      : {
          sessionFile: update.sessionFile,
          sessionKey: update.sessionKey,
          agentId: update.agentId,
          message: update.message,
          messageId: update.messageId,
          messageSeq: update.messageSeq,
        };
  const trimmed = normalizeOptionalString(normalized.sessionFile);
  if (!trimmed) {
    return;
  }
  const messageSeq = asPositiveSafeInteger(normalized.messageSeq);
  const nextUpdate: SessionTranscriptUpdate = {
    sessionFile: trimmed,
    ...(normalizeOptionalString(normalized.sessionKey)
      ? { sessionKey: normalizeOptionalString(normalized.sessionKey) }
      : {}),
    ...(normalizeOptionalString(normalized.agentId)
      ? { agentId: normalizeOptionalString(normalized.agentId) }
      : {}),
    ...(normalized.message !== undefined ? { message: normalized.message } : {}),
    ...(normalizeOptionalString(normalized.messageId)
      ? { messageId: normalizeOptionalString(normalized.messageId) }
      : {}),
    ...(messageSeq !== undefined ? { messageSeq } : {}),
  };
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    try {
      listener(nextUpdate);
    } catch {
      /* ignore */
    }
  }
}
