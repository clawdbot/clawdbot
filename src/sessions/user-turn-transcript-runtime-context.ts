// Transient user-turn transcript context carried through runtime queues.
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";

const RUNTIME_USER_TURN_TRANSCRIPT_CONTEXT = Symbol.for(
  "openclaw.runtimeUserTurnTranscriptContext",
);
const RUNTIME_USER_TURN_TRANSCRIPT_RECORDER = Symbol.for(
  "openclaw.runtimeUserTurnTranscriptRecorder",
);

type RuntimeUserTurnTranscriptContext = {
  message: PersistedUserTurnMessage;
  recorder: UserTurnTranscriptRecorder;
};

// The recorder pre-persists a user turn under its own SQLite event id. The id rides
// the prepared message's __openclaw meta so SessionManager adopts one event identity
// instead of force-inserting a duplicate idempotency-key row (#115389).
const PERSISTED_USER_TURN_EVENT_ID_META_KEY = "persistedEventId";

function readOpenClawMeta(message: unknown): Record<string, unknown> | undefined {
  const meta =
    message && typeof message === "object"
      ? (message as Record<string, unknown>)["__openclaw"]
      : undefined;
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : undefined;
}

export function readPersistedUserTurnEventId(message: unknown): string | undefined {
  const value = readOpenClawMeta(message)?.[PERSISTED_USER_TURN_EVENT_ID_META_KEY];
  return typeof value === "string" && value ? value : undefined;
}

/** Marks a prepared user turn with the SQLite event id it was pre-persisted under. */
export function stampPersistedUserTurnEventId(
  message: PersistedUserTurnMessage,
  eventId: string,
): PersistedUserTurnMessage {
  if (readPersistedUserTurnEventId(message) === eventId) {
    return message;
  }
  return {
    ...(message as unknown as Record<string, unknown>),
    __openclaw: { ...readOpenClawMeta(message), [PERSISTED_USER_TURN_EVENT_ID_META_KEY]: eventId },
  } as unknown as PersistedUserTurnMessage;
}

/** Takes the adoption marker off a message before it becomes a session entry payload. */
export function takePersistedUserTurnEventId<TMessage>(message: TMessage): {
  eventId?: string;
  message: TMessage;
} {
  const meta = readOpenClawMeta(message);
  const eventId = meta?.[PERSISTED_USER_TURN_EVENT_ID_META_KEY];
  if (!meta || typeof eventId !== "string" || !eventId) {
    return { message };
  }
  const { [PERSISTED_USER_TURN_EVENT_ID_META_KEY]: _removed, ...restMeta } = meta;
  const record: Record<string, unknown> = { ...(message as Record<string, unknown>) };
  if (Object.keys(restMeta).length > 0) {
    record["__openclaw"] = restMeta;
  } else {
    delete record["__openclaw"];
  }
  return { eventId, message: record as TMessage };
}

/** Carries transcript-only fields with a queued runtime message without exposing them to the model. */
export function attachRuntimeUserTurnTranscriptContext(
  runtimeMessage: PersistedUserTurnMessage,
  context: RuntimeUserTurnTranscriptContext,
): PersistedUserTurnMessage {
  Object.defineProperty(runtimeMessage, RUNTIME_USER_TURN_TRANSCRIPT_CONTEXT, {
    configurable: true,
    value: context,
  });
  return runtimeMessage;
}

/** Consumes the transient queued-turn context before the message is serialized. */
export function takeRuntimeUserTurnTranscriptContext(
  runtimeMessage: AgentMessage,
): RuntimeUserTurnTranscriptContext | undefined {
  const record = runtimeMessage as unknown as Record<PropertyKey, unknown>;
  const context = record[RUNTIME_USER_TURN_TRANSCRIPT_CONTEXT] as
    | RuntimeUserTurnTranscriptContext
    | undefined;
  if (context) {
    delete record[RUNTIME_USER_TURN_TRANSCRIPT_CONTEXT];
  }
  return context;
}

/** Keeps the queued recorder attached to the exact final message until persistence succeeds. */
export function attachRuntimeUserTurnTranscriptRecorder(
  runtimeMessage: AgentMessage,
  recorder: UserTurnTranscriptRecorder,
): AgentMessage {
  Object.defineProperty(runtimeMessage, RUNTIME_USER_TURN_TRANSCRIPT_RECORDER, {
    configurable: true,
    value: recorder,
  });
  return runtimeMessage;
}

export function takeRuntimeUserTurnTranscriptRecorder(
  runtimeMessage: AgentMessage,
): UserTurnTranscriptRecorder | undefined {
  const record = runtimeMessage as unknown as Record<PropertyKey, unknown>;
  const recorder = record[RUNTIME_USER_TURN_TRANSCRIPT_RECORDER] as
    | UserTurnTranscriptRecorder
    | undefined;
  if (recorder) {
    delete record[RUNTIME_USER_TURN_TRANSCRIPT_RECORDER];
  }
  return recorder;
}
