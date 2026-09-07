import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "../../../../packages/agent-core/src/types.js";
import {
  loadSessionEntry,
  loadTranscriptHeaderSync,
  readActiveTranscriptEntryAnchor,
  type SessionTranscriptWriteScope,
} from "../../../config/sessions/session-accessor.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptInitialWriter,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "../../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptRecorder,
} from "../../../sessions/user-turn-transcript.types.js";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../../internal-runtime-context.js";
import {
  AGENT_RUN_RESTART_ABORT_ERROR,
  AGENT_RUN_RESTART_ABORT_ERROR_CODE,
} from "../../run-termination.js";
import type { SessionManager } from "../../sessions/session-manager.js";

/** Re-adopt the current turn without reopening arbitrary historical keyed users. */
export function preparePersistedCurrentUserTurn(params: {
  sessionManager: SessionManager;
  message: PersistedUserTurnMessage | undefined;
  recorder: UserTurnTranscriptRecorder | undefined;
  runId: string;
}): (() => void) | undefined {
  const { sessionManager, message, recorder, runId } = params;
  const target = sessionManager.getSessionTarget();
  if (!target || !message?.idempotencyKey || !recorder) {
    return undefined;
  }
  const scope: typeof target & SessionTranscriptWriteScope =
    withOwnedSessionTranscriptWriterFence(target);
  const assertOwned = captureOwnedTranscriptWriteAssertion(scope);
  const initialWriter = getOwnedSessionTranscriptInitialWriter({ sessionTarget: scope });
  const readCurrentTurn = () => {
    assertOwned();
    const current: InternalSessionEntry | undefined = loadSessionEntry(scope);
    // First-insert ownership precedes the row. Only the exact live lease with
    // no durable transcript may continue to the ordinary initial append.
    if (
      !current &&
      initialWriter &&
      !initialWriter.committedFence &&
      loadTranscriptHeaderSync(scope) === undefined
    ) {
      return undefined;
    }
    if (
      !current ||
      current.sessionId !== scope.sessionId ||
      (scope.expectedLifecycleRevision !== undefined &&
        current.lifecycleRevision !== scope.expectedLifecycleRevision) ||
      (scope.expectedWriterRunId !== undefined &&
        current.activeWriterRunId !== scope.expectedWriterRunId)
    ) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    sessionManager.reloadPersistedTranscript();
    const userId = sessionManager.resolveCurrentTurnEntryId((entry) => {
      if (entry.type === "custom_message") {
        return (
          entry.customType === "openclaw:turn-aborted" ||
          entry.customType === OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE
        );
      }
      if (entry.type !== "message" || entry.message.role !== "assistant") {
        return false;
      }
      const aborted = entry.message;
      const errorCode: unknown = Reflect.get(aborted, "errorCode");
      return (
        aborted.stopReason === "aborted" &&
        Reflect.get(aborted, "__openclaw")?.runId === runId &&
        (errorCode !== undefined
          ? errorCode === AGENT_RUN_RESTART_ABORT_ERROR_CODE
          : aborted.errorMessage === AGENT_RUN_RESTART_ABORT_ERROR) &&
        aborted.content.every((part) => part.type === "text" && part.text === "")
      );
    });
    const user = userId ? sessionManager.getEntry(userId) : undefined;
    if (
      user?.type !== "message" ||
      user.message.role !== "user" ||
      !isDeepStrictEqual(user.message, message)
    ) {
      return undefined;
    }
    return readActiveTranscriptEntryAnchor({ ...scope, entryId: user.id });
  };
  const anchor = readCurrentTurn();
  if (!anchor) {
    return undefined;
  }
  recorder.markRuntimePersisted(message, anchor, { appended: false });
  // Preparation may await hooks or compaction. The anchor alone does not prove
  // that a later user/final has not consumed this turn; recheck at core admission.
  let pending = true;
  return () => {
    if (!pending) {
      return;
    }
    const current = readCurrentTurn();
    if (
      !current ||
      current.entryId !== anchor.entryId ||
      current.generation !== anchor.generation
    ) {
      throw new Error("Persisted user turn changed before replay admission");
    }
    pending = false;
  };
}

export function sessionMessagesContainIdempotencyKey(
  messages: AgentMessage[],
  idempotencyKey: string,
): boolean {
  return messages.some(
    (message) => (message as { idempotencyKey?: unknown }).idempotencyKey === idempotencyKey,
  );
}

export function reconcilePrePersistedCurrentUserTurn(params: {
  activeSession: { agent: { state: { messages: AgentMessage[] } } };
  currentUserTurnMessage: AgentMessage | undefined;
  durableUserTurnMessage: AgentMessage | undefined;
  userTurnAlreadyPersisted: boolean;
}): boolean {
  const idempotencyKey = (params.currentUserTurnMessage as { idempotencyKey?: unknown } | undefined)
    ?.idempotencyKey;
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return false;
  }
  const durableIdempotencyKey = (
    params.durableUserTurnMessage as { idempotencyKey?: unknown } | undefined
  )?.idempotencyKey;
  // Recorder state is process-local; after restart the durable keyed leaf is the
  // authoritative proof that this exact admitted turn was already persisted.
  const durableTurnMatches = durableIdempotencyKey === idempotencyKey;
  if (!params.userTurnAlreadyPersisted && !durableTurnMatches) {
    return false;
  }
  const messages = params.activeSession.agent.state.messages;
  const tail = messages.at(-1) as (AgentMessage & { idempotencyKey?: unknown }) | undefined;
  const activeTailMatches = tail?.role === "user" && tail.idempotencyKey === idempotencyKey;
  if (!activeTailMatches && !durableTurnMatches) {
    // Excluded turns deliberately lack a model-context copy; writes still validate admission.
    return (
      (params.currentUserTurnMessage as { excludeFromContext?: unknown }).excludeFromContext ===
      true
    );
  }
  if (activeTailMatches) {
    // BTW snapshots represent prior conversation; keep the current user separate
    // until prompt submission reinjects it with the resolved runtime context.
    params.activeSession.agent.state.messages = messages.slice(0, -1);
  }
  return true;
}
