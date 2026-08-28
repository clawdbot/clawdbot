// Transcript event helpers serialize and trim session transcript events.
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveGlobalSet, resolveGlobalSingleton } from "../shared/global-singleton.js";

/** Storage-neutral identity for the session transcript that changed. */
type SessionTranscriptUpdateTarget = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
};

type SessionTranscriptUpdateFields = {
  /** The session file was just created by an archive lifecycle owner. */
  archiveFile?: true;
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
  runId?: string;
};

/** Normalized transcript update emitted after a session transcript changes. */
export type SessionTranscriptUpdate = Omit<
  SessionTranscriptUpdateFields,
  "archiveFile" | "sessionFile" | "lifecycleRevision" | "target"
> & {
  target: Omit<SessionTranscriptUpdateTarget, "storePath">;
};

/** Internal transcript update that may identify a transcript without a file path. */
export type InternalSessionTranscriptUpdate = SessionTranscriptUpdateFields;

/** Persists authoritative run ownership on assistant and tool-result rows. */
export function attachSessionTranscriptRunId<T>(message: T, runId: string | null | undefined): T {
  const normalizedRunId = normalizeOptionalString(runId);
  if (
    !normalizedRunId ||
    !isRecord(message) ||
    (message.role !== "assistant" && message.role !== "toolResult")
  ) {
    return message;
  }
  const metadata = isRecord(message["__openclaw"]) ? message["__openclaw"] : {};
  if (metadata.runId === normalizedRunId) {
    return message;
  }
  return {
    ...message,
    __openclaw: { ...metadata, runId: normalizedRunId },
  };
}

/** Correlates only terminal assistant rows with the run that actually produced them. */
export function resolveTerminalAssistantTranscriptRunId(
  message: unknown,
  runId: string | null | undefined,
): string | undefined {
  const normalizedRunId = normalizeOptionalString(runId);
  if (!normalizedRunId || !isRecord(message) || message.role !== "assistant") {
    return undefined;
  }
  if (
    message.stopReason === "toolUse" ||
    (Array.isArray(message.content) &&
      message.content.some(
        (block) =>
          isRecord(block) &&
          (block.type === "toolCall" || block.type === "toolUse" || block.type === "functionCall"),
      ))
  ) {
    return undefined;
  }
  return normalizedRunId;
}

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

const SESSION_TRANSCRIPT_UPDATE_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionTranscriptUpdateState"),
  () => ({ version: 0 }),
);

/** Monotonic fence for projections that embed transcript-derived fields (previews, titles). */
export function readSessionTranscriptUpdateVersion(): number {
  return SESSION_TRANSCRIPT_UPDATE_STATE.version;
}

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
  const nextUpdate = normalizeSessionTranscriptUpdate(update);
  if (!nextUpdate) {
    return;
  }
  // Commit-then-broadcast: a subscriber's refetch races the sessions.list
  // cache, so the fence must advance before any listener can observe the write.
  SESSION_TRANSCRIPT_UPDATE_STATE.version += 1;
  const publicUpdate = projectPublicSessionTranscriptUpdate(nextUpdate);
  if (publicUpdate) {
    emitPublicSessionTranscriptUpdate(publicUpdate);
  }
  emitInternalTranscriptUpdate(nextUpdate);
}

function normalizeSessionTranscriptUpdate(
  update: InternalSessionTranscriptUpdate,
): InternalSessionTranscriptUpdate | undefined {
  const trimmed = normalizeOptionalString(update.sessionFile);
  const target = normalizeUpdateTarget(update);
  if (!trimmed && !target) {
    return undefined;
  }
  const messageSeq = asPositiveSafeInteger(update.messageSeq);
  const sessionKey = normalizeOptionalString(update.sessionKey) ?? target?.sessionKey;
  const agentId = normalizeOptionalString(update.agentId) ?? target?.agentId;
  const sessionId = normalizeOptionalString(update.sessionId) ?? target?.sessionId;
  const lifecycleRevision = normalizeOptionalString(update.lifecycleRevision);
  const messageId = normalizeOptionalString(update.messageId);
  const runId = normalizeOptionalString(update.runId);
  return {
    ...(update.archiveFile === true ? { archiveFile: true } : {}),
    ...(trimmed ? { sessionFile: trimmed } : {}),
    ...(target ? { target } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(lifecycleRevision ? { lifecycleRevision } : {}),
    ...(update.message !== undefined ? { message: update.message } : {}),
    ...(messageId ? { messageId } : {}),
    ...(messageSeq !== undefined ? { messageSeq } : {}),
    ...(runId ? { runId } : {}),
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
    ...(update.message !== undefined
      ? { message: projectPublicSessionTranscriptMessage(update.message) }
      : {}),
    ...(update.messageId ? { messageId: update.messageId } : {}),
    ...(update.messageSeq !== undefined ? { messageSeq: update.messageSeq } : {}),
    ...(update.runId ? { runId: update.runId } : {}),
  };
}

function projectPublicSessionTranscriptMessage(message: unknown): unknown {
  if (!isRecord(message) || !Object.hasOwn(message, "providerReplay")) {
    return message;
  }
  const publicMessage = { ...message };
  delete publicMessage.providerReplay;
  return publicMessage;
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
