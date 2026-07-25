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
