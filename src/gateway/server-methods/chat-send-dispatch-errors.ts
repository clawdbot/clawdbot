import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { clearAgentRunContext } from "../../infra/agent-events.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import { formatForLog } from "../ws-log.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import { broadcastChatError, broadcastChatFinal } from "./chat-broadcast.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { hasTrackedActiveSessionRun } from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestContext } from "./types.js";

type PendingDispatchLifecycleError = {
  endedAt: number;
  error: string;
  sessionId: string;
  startedAt: number;
};

/** Own dispatch rejection projection and post-cleanup lifecycle persistence. */
export function createChatSendDispatchErrorLifecycle(params: {
  admission: Pick<
    AdmittedChatSend,
    "activeRunAbort" | "cleanupAdmittedRun" | "lifecycleGeneration" | "restartSafeAdmission"
  >;
  context: GatewayRequestContext;
  isQueuedFollowupEnqueued: () => boolean;
  persistUserTurnTranscript: () => Promise<unknown>;
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "backingSessionId" | "cfg" | "clientRunId" | "now" | "rawSessionKey" | "sessionKey"
  >;
  terminalizeRestartSafeAdmission: (state: {
    retryable: boolean;
    status: "failed" | "killed";
  }) => Promise<boolean>;
  userTurnRecorder: Pick<UserTurnTranscriptRecorder, "hasPersisted" | "isBlocked">;
}) {
  const {
    admission,
    context,
    isQueuedFollowupEnqueued,
    persistUserTurnTranscript,
    session,
    terminalizeRestartSafeAdmission,
    userTurnRecorder,
  } = params;
  const { activeRunAbort, cleanupAdmittedRun, lifecycleGeneration, restartSafeAdmission } =
    admission;
  const { agentId, backingSessionId, cfg, clientRunId, now, rawSessionKey, sessionKey } = session;
  let pendingDispatchLifecycleError: PendingDispatchLifecycleError | undefined;
  let persistDispatchErrorUserTurn: (() => Promise<void>) | undefined;

  const handleError = async (err: unknown) => {
    const errorMessage = String(err);
    const queuedFollowupEnqueued = isQueuedFollowupEnqueued();
    let restartSafeDispatchFailureTerminalized = false;
    if (restartSafeAdmission && !queuedFollowupEnqueued) {
      restartSafeDispatchFailureTerminalized = await terminalizeRestartSafeAdmission({
        retryable: true,
        status: "failed",
      }).catch((terminalizeError: unknown) => {
        context.logGateway.warn(
          `failed to release restart-safe chat admission after dispatch error: ${formatForLog(
            terminalizeError,
          )}`,
        );
        return false;
      });
      if (restartSafeDispatchFailureTerminalized) {
        emitSessionsChanged(context, {
          sessionKey,
          ...(agentId ? { agentId } : {}),
          reason: "chat.dispatch-error",
        });
      }
    }
    if (queuedFollowupEnqueued) {
      context.logGateway.warn(
        `webchat dispatch failed after followup queue admission: ${formatForLog(err)}`,
      );
      if (!context.chatRunState.hasAbortMarker(clientRunId)) {
        setGatewayDedupeEntry({
          dedupe: context.dedupe,
          key: `chat:${clientRunId}`,
          entry: {
            ts: Date.now(),
            ok: true,
            payload: { runId: clientRunId, status: "ok" as const },
          },
        });
        broadcastChatFinal({
          context,
          runId: clientRunId,
          sessionKey,
          agentId,
        });
      }
      return;
    }
    persistDispatchErrorUserTurn =
      userTurnRecorder.hasPersisted() || userTurnRecorder.isBlocked()
        ? undefined
        : async () => {
            await persistUserTurnTranscript();
          };
    if (
      !restartSafeDispatchFailureTerminalized &&
      !activeRunAbort.controller.signal.aborted &&
      !context.chatRunState.hasAbortMarker(clientRunId)
    ) {
      pendingDispatchLifecycleError = {
        endedAt: Date.now(),
        error: errorMessage,
        sessionId: activeRunAbort.entry?.sessionId ?? backingSessionId ?? clientRunId,
        startedAt: activeRunAbort.entry?.startedAtMs ?? now,
      };
    }
    const error = errorShape(ErrorCodes.UNAVAILABLE, errorMessage);
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `chat:${clientRunId}`,
      entry: {
        ts: Date.now(),
        ok: false,
        payload: {
          runId: clientRunId,
          status: "error" as const,
          summary: errorMessage,
        },
        error,
      },
    });
    broadcastChatError({
      context,
      runId: clientRunId,
      sessionKey,
      agentId,
      errorMessage,
    });
  };

  const finalize = () => {
    const dispatchError = pendingDispatchLifecycleError;
    // Reserve projection before cleanup retires the accepted dispatch root.
    const releaseDispatchErrorRoot = dispatchError
      ? retainGatewayRootWorkAdmissionContinuation()
      : null;
    cleanupAdmittedRun();
    clearAgentRunContext(clientRunId, lifecycleGeneration);
    context.removeChatRun(clientRunId, clientRunId, sessionKey);
    if (!dispatchError) {
      return;
    }
    const persistDispatchLifecycleError = async () => {
      const hasActiveRun = hasTrackedActiveSessionRun({
        context,
        requestedKey: rawSessionKey,
        canonicalKey: sessionKey,
        ...(sessionKey === "global" && agentId ? { agentId } : {}),
        defaultAgentId: resolveDefaultAgentId(cfg),
      });
      if (hasActiveRun) {
        return;
      }
      try {
        await persistGatewaySessionLifecycleEvent({
          sessionKey,
          ...(sessionKey === "global" && agentId ? { agentId } : {}),
          event: {
            runId: clientRunId,
            sessionId: dispatchError.sessionId,
            lifecycleGeneration,
            ts: dispatchError.endedAt,
            data: {
              phase: "error",
              startedAt: dispatchError.startedAt,
              endedAt: dispatchError.endedAt,
              error: dispatchError.error,
            },
          },
        });
        emitSessionsChanged(context, {
          sessionKey,
          ...(agentId ? { agentId } : {}),
          reason: "chat.dispatch-error",
        });
      } catch (persistErr: unknown) {
        context.logGateway.warn(
          `webchat session lifecycle persist failed after error: ${formatForLog(persistErr)}`,
        );
      }
    };
    void (async () => {
      await persistDispatchLifecycleError();
      await persistDispatchErrorUserTurn?.().catch((transcriptErr: unknown) => {
        context.logGateway.warn(
          `webchat user transcript update failed after error: ${formatForLog(transcriptErr)}`,
        );
      });
    })()
      .catch((continuationErr: unknown) => {
        context.logGateway.warn(
          `webchat session lifecycle continuation failed: ${formatForLog(continuationErr)}`,
        );
      })
      .finally(() => releaseDispatchErrorRoot?.());
  };

  return { finalize, handleError };
}
