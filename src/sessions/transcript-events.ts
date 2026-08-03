// Transcript event helpers serialize and trim session transcript events.
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveGlobalSet } from "../shared/global-singleton.js";

/** Storage-neutral identity for the session transcript that changed. */
type SessionTranscriptUpdateTarget = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
};

type SessionTranscriptUpdateFields = {
  sessionFile?: string;
  target?: SessionTranscriptUpdateTarget;
  sessionKey?: string;
  agentId?: string;
  sessionId?: string;
  /** Committed lifecycle owner; internal delivery must not expose it publicly. */
  lifecycleRevision?: string;
  message?: unknown;
  messageId?: string;
  messageSeq?: number;
};

/** Normalized transcript update emitted after a session transcript changes. */
export type SessionTranscriptUpdate = Omit<
  SessionTranscriptUpdateFields,
  "sessionFile" | "lifecycleRevision" | "target"
> & {
  target: Omit<SessionTranscriptUpdateTarget, "storePath">;
};

/** Internal transcript update that may identify a transcript without a file path. */
export type InternalSessionTranscriptUpdate = SessionTranscriptUpdateFields;

type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;
type InternalSessionTranscriptListener = (update: InternalSessionTranscriptUpdate) => void;

const SESSION_TRANSCRIPT_LISTENERS = resolveGlobalSet<SessionTranscriptListener>(
  Symbol.for("openclaw.sessionTranscriptListeners"),
  "close-and-restart",
);
const INTERNAL_SESSION_TRANSCRIPT_LISTENERS = resolveGlobalSet<InternalSessionTranscriptListener>(
  Symbol.for("openclaw.internalSessionTranscriptListeners"),
  "close-and-restart",
);

/** Registers a listener for normalized session transcript updates. */
export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

/** Registers an internal listener for identity-only or file-backed transcript updates. */
export function onInternalSessionTranscriptUpdate(
  listener: InternalSessionTranscriptListener,
): () => void {
  INTERNAL_SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    INTERNAL_SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

/** Emits a normalized transcript update to all registered listeners. */
export function emitSessionTranscriptUpdate(update: InternalSessionTranscriptUpdate): void {
  const nextUpdate = normalizeSessionTranscriptUpdate(update, { allowIdentityOnly: true });
  if (!nextUpdate) {
    return;
  }
  const publicUpdate = projectPublicSessionTranscriptUpdate(nextUpdate);
  if (publicUpdate) {
    emitPublicSessionTranscriptUpdate(publicUpdate);
  }
  emitInternalTranscriptUpdate(nextUpdate);
}

function normalizeSessionTranscriptUpdate(
  update: InternalSessionTranscriptUpdate,
  options: { allowIdentityOnly: boolean },
): InternalSessionTranscriptUpdate | undefined {
  const normalized = {
    sessionFile: update.sessionFile,
    target: update.target,
    sessionKey: update.sessionKey,
    agentId: update.agentId,
    sessionId: update.sessionId,
    lifecycleRevision: update.lifecycleRevision,
    message: update.message,
    messageId: update.messageId,
    messageSeq: update.messageSeq,
  };
  const trimmed = normalizeOptionalString(normalized.sessionFile);
  const target = normalizeUpdateTarget(normalized);
  if (!trimmed && (!options.allowIdentityOnly || !target)) {
    return undefined;
  }
  const messageSeq = asPositiveSafeInteger(normalized.messageSeq);
  const sessionKey = normalizeOptionalString(normalized.sessionKey) ?? target?.sessionKey;
  const agentId = normalizeOptionalString(normalized.agentId) ?? target?.agentId;
  const sessionId = normalizeOptionalString(normalized.sessionId) ?? target?.sessionId;
  const lifecycleRevision = normalizeOptionalString(normalized.lifecycleRevision);
  return {
    ...(trimmed ? { sessionFile: trimmed } : {}),
    ...(target ? { target } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(lifecycleRevision ? { lifecycleRevision } : {}),
    ...(normalized.message !== undefined ? { message: normalized.message } : {}),
    ...(normalizeOptionalString(normalized.messageId)
      ? { messageId: normalizeOptionalString(normalized.messageId) }
      : {}),
    ...(messageSeq !== undefined ? { messageSeq } : {}),
  };
}

function emitPublicSessionTranscriptUpdate(nextUpdate: SessionTranscriptUpdate): void {
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    try {
      listener(nextUpdate);
    } catch {
      /* ignore */
    }
  }
}

function emitInternalTranscriptUpdate(nextUpdate: InternalSessionTranscriptUpdate): void {
  for (const listener of INTERNAL_SESSION_TRANSCRIPT_LISTENERS) {
    try {
      listener(nextUpdate);
    } catch {
      /* ignore */
    }
  }
}

function projectPublicSessionTranscriptUpdate(
  update: InternalSessionTranscriptUpdate,
): SessionTranscriptUpdate | undefined {
  const target = update.target;
  if (!target) {
    return undefined;
  }
  return {
    target: {
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
    },
    ...(update.sessionKey ? { sessionKey: update.sessionKey } : {}),
    ...(update.agentId ? { agentId: update.agentId } : {}),
    ...(update.sessionId ? { sessionId: update.sessionId } : {}),
    ...(update.message !== undefined ? { message: update.message } : {}),
    ...(update.messageId ? { messageId: update.messageId } : {}),
    ...(update.messageSeq !== undefined ? { messageSeq: update.messageSeq } : {}),
  };
}

function normalizeUpdateTarget(update: {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  target?: InternalSessionTranscriptUpdate["target"];
}): SessionTranscriptUpdateTarget | undefined {
  const sessionKey =
    normalizeOptionalString(update.target?.sessionKey) ??
    normalizeOptionalString(update.sessionKey);
  const agentId =
    normalizeOptionalString(update.target?.agentId) ??
    normalizeOptionalString(update.agentId) ??
    (sessionKey ? parseAgentSessionKey(sessionKey)?.agentId : undefined);
  const sessionId =
    normalizeOptionalString(update.target?.sessionId) ?? normalizeOptionalString(update.sessionId);
  const storePath = normalizeOptionalString(update.target?.storePath);
  if (!agentId || !sessionId || !sessionKey) {
    return undefined;
  }
  return {
    agentId,
    sessionId,
    sessionKey,
    ...(storePath ? { storePath } : {}),
  };
}
