import { randomUUID } from "node:crypto";
import { AGENT_RUN_RESTART_ABORT_STOP_REASON } from "../../agents/run-termination.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { resolveAgentRunExpiresAtMs } from "../chat-abort.js";
import { resolveSessionStoreKey } from "../session-utils.js";
import {
  isAcceptedAgentDedupePayload,
  isPreRegistrationAbortedAgentDedupeEntryForSession,
  readGatewayDedupeEntry,
  setAbortedAgentDedupeEntries,
  setGatewayDedupeEntries,
} from "./agent-dedupe.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import type { CommittedResetCompletion } from "./agent-reset-phase.js";
import { deleteGatewayDedupeEntries } from "./agent-run-dispatch.js";
import {
  buildBareSessionResetResponse,
  buildBareSessionResetResult,
  sessionResetAckText,
} from "./agent-session-reset.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export type AgentDedupeLifecycle = ReturnType<typeof createAgentDedupeLifecycle>;

export function createAgentDedupeLifecycle(params: {
  cfg: ReturnType<GatewayRequestHandlerOptions["context"]["getRuntimeConfig"]>;
  request: AgentRunRequest;
  runId: string;
  lifecycleGeneration: string;
  agentDedupeKeys: string[];
  suppressVisibleSessionEffects: boolean;
  ownerConnId?: string;
  ownerDeviceId?: string;
  context: GatewayRequestHandlerOptions["context"];
  respond: GatewayRequestHandlerOptions["respond"];
}) {
  let reserved = false;
  let accepted = false;
  let committedResetCompletion: CommittedResetCompletion | undefined;
  const reservationId = randomUUID();
  const replayCapability = params.request.replayCapability;

  const reserve = (sessionKey?: string, dedupeAgentId?: string) => {
    if (reserved) {
      return;
    }
    const dedupeSessionResolvesGlobal = sessionKey
      ? resolveSessionStoreKey({ cfg: params.cfg, sessionKey }) === "global"
      : false;
    const acceptedAt = Date.now();
    const pendingTimeoutMs = resolveAgentTimeoutMs({
      cfg: params.cfg,
      overrideSeconds:
        typeof params.request.timeout === "number" ? params.request.timeout : undefined,
    });
    setGatewayDedupeEntries({
      dedupe: params.context.dedupe,
      keys: params.agentDedupeKeys,
      entry: {
        ts: acceptedAt,
        ok: true,
        agentReplayCapability: replayCapability,
        payload: {
          runId: params.runId,
          reservationId,
          status: "accepted" as const,
          ...(sessionKey ? { sessionKey } : {}),
          ...(dedupeAgentId && (!sessionKey || dedupeSessionResolvesGlobal)
            ? { agentId: dedupeAgentId }
            : {}),
          controlUiVisible: !params.suppressVisibleSessionEffects,
          acceptedAt,
          dedupeKeys: params.agentDedupeKeys,
          expiresAtMs: resolveAgentRunExpiresAtMs({ now: acceptedAt, timeoutMs: pendingTimeoutMs }),
          ownerConnId: params.ownerConnId,
          ownerDeviceId: params.ownerDeviceId,
        },
      },
    });
    reserved = true;
  };

  const clearUnaccepted = () => {
    if (!reserved || accepted) {
      return;
    }
    const entry = readGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      keys: params.agentDedupeKeys,
    });
    if (
      isPreRegistrationAbortedAgentDedupeEntryForSession({ entry, runId: params.runId }) ||
      (entry?.ok &&
        isAcceptedAgentDedupePayload(entry.payload) &&
        entry.payload.reservationId !== reservationId)
    ) {
      return;
    }
    deleteGatewayDedupeEntries({
      dedupe: params.context.dedupe,
      keys: params.agentDedupeKeys,
    });
    reserved = false;
  };

  const abortForLifecycleRotation = (target?: { sessionKey?: string; agentId?: string }) => {
    if (params.lifecycleGeneration === getAgentEventLifecycleGeneration()) {
      return false;
    }
    if (committedResetCompletion) {
      const completion = committedResetCompletion;
      const responsePayload = buildBareSessionResetResponse({
        runId: params.runId,
        result: buildBareSessionResetResult({
          reason: completion.reason,
          sessionId: completion.sessionId,
          ackText: completion.followUpPending
            ? `${sessionResetAckText(completion.reason)} Gateway restarted before the follow-up ran; send the follow-up message again.`
            : undefined,
        }),
      });
      accepted = true;
      setGatewayDedupeEntries({
        dedupe: params.context.dedupe,
        keys: params.agentDedupeKeys,
        entry: {
          ts: Date.now(),
          ok: true,
          agentReplayCapability: replayCapability,
          payload: responsePayload,
        },
      });
      params.respond(true, responsePayload, undefined, { runId: params.runId });
      emitSessionsChanged(params.context, {
        sessionKey: completion.sessionKey,
        ...(completion.sessionKey === "global" && completion.agentId
          ? { agentId: completion.agentId }
          : {}),
        reason: completion.reason,
      });
      return true;
    }
    accepted = true;
    setAbortedAgentDedupeEntries({
      dedupe: params.context.dedupe,
      keys: params.agentDedupeKeys,
      agentId: target?.agentId,
      sessionKey: target?.sessionKey,
      runId: params.runId,
      stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
      agentReplayCapability: replayCapability,
    });
    params.respond(
      true,
      {
        runId: params.runId,
        status: "timeout" as const,
        summary: "aborted",
        stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
        timeoutPhase: "queue" as const,
        providerStarted: false,
      },
      undefined,
      { runId: params.runId },
    );
    return true;
  };

  return {
    reservationId,
    replayCapability,
    reserve,
    clearUnaccepted,
    abortForLifecycleRotation,
    isReserved: () => reserved,
    isAccepted: () => accepted,
    markAccepted: (value: boolean) => {
      accepted = value;
    },
    setCommittedResetCompletion: (value: CommittedResetCompletion) => {
      committedResetCompletion = value;
    },
  };
}
