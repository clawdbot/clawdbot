import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import {
  lookupSessionGoalOperation,
  SessionGoalOperationError,
} from "../../config/sessions/goals-operations.js";
import { SESSION_ROUTING_CHANGED_ERROR_REASON } from "../../config/sessions/main-session.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { chatAbortMarkerTimestampMs } from "../server-chat-state.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX } from "../server-shared.js";
import { loadSessionEntry } from "../session-utils.js";
import {
  buildAbortedChatSendPayload,
  readPreRegisteredRun,
  resolveChatAbortRequester,
} from "./chat-abort-authorization.js";
import {
  abortChatRunsForSessionKeyWithPartials,
  createChatAbortOps,
  descendantAbortError,
} from "./chat-abort-runtime.js";
import { resolveDurableChatClaim } from "./chat-restart-recovery.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { resolveChatSendStopOwnerScope } from "./chat-send-stop-owner-scope.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export const ACTIVE_LEAF_CHANGED_ERROR_REASON = "active-leaf-changed";

export function respondChatSessionRoutingChanged(respond: GatewayRequestHandlerOptions["respond"]) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "session routing changed; review and retry", {
      details: { reason: SESSION_ROUTING_CHANGED_ERROR_REASON },
    }),
  );
}

export function respondChatActiveLeafChanged(respond: GatewayRequestHandlerOptions["respond"]) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "active branch changed; review and retry", {
      details: { reason: ACTIVE_LEAF_CHANGED_ERROR_REASON },
    }),
  );
}

type ChatSendPreAdmissionParams = {
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  respond: GatewayRequestHandlerOptions["respond"];
  context: GatewayRequestHandlerOptions["context"];
  client: GatewayRequestHandlerOptions["client"];
};

/** Recheck synchronously at reservation: recovery lookups can yield to a competing request. */
export function inspectGoalChatSendRetry({
  request,
  session,
  respond,
  context,
  durableClaimAccepted,
}: ChatSendPreAdmissionParams & { durableClaimAccepted?: boolean }) {
  const { sessionKey, storePath, entry, clientRunId, pendingChatSendKey } = session;
  if (!request.goalOperation) {
    return { kind: "new" } as const;
  }
  try {
    const receipt = lookupSessionGoalOperation({
      sessionKey,
      storePath,
      agentId: session.agentId,
      expectedSessionId: entry?.sessionId ?? session.backingSessionId ?? clientRunId,
      operation: request.goalOperation,
    });
    if (receipt) {
      return { kind: "replay", receipt } as const;
    }
    const pending = readPreRegisteredRun({
      key: pendingChatSendKey,
      entry: context.dedupe.get(pendingChatSendKey),
      keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
    });
    if (
      pending?.payload.goalFingerprint === request.goalOperation.requestFingerprint ||
      (!pending && !durableClaimAccepted && context.chatAbortControllers.has(clientRunId))
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Goal is being admitted; retry the same request.", {
          retryable: true,
        }),
      );
      return { kind: "settled" } as const;
    }
    if (
      pending ||
      durableClaimAccepted ||
      context.dedupe.has(`chat:${clientRunId}`) ||
      context.chatRunState.hasAbortMarker(clientRunId) ||
      context.chatAbortControllers.has(clientRunId) ||
      context.chatQueuedTurns?.has(clientRunId)
    ) {
      throw new SessionGoalOperationError(
        "operation-conflict",
        "Goal operation ID is already used by another request.",
      );
    }
    return { kind: "new" } as const;
  } catch (error) {
    if (!(error instanceof SessionGoalOperationError)) {
      throw error;
    }
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
        details: { reason: `goal-${error.code}` },
      }),
    );
    return { kind: "settled" } as const;
  }
}

/** Settle stop/retry/dedupe cases before reserving lifecycle admission. */
export async function runChatSendPreAdmission(
  params: ChatSendPreAdmissionParams,
): Promise<boolean> {
  const { request, session, respond, context, client } = params;
  const { stopCommand } = request;
  const {
    cfg,
    entry,
    sessionKey,
    rawSessionKey,
    sessionLoadKey,
    selectedAgent,
    clientRunId,
    pendingChatSendKey,
    sessionLoadOptions,
    storePath,
    legacyKey,
    sessionRoutingChanged,
  } = session;

  const sendPolicy = resolveSendPolicy({
    cfg,
    entry,
    sessionKey,
    channel: sessionDeliveryChannel(entry),
    chatType: entry?.chatType,
  });
  if (sendPolicy === "deny") {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
    );
    return false;
  }

  if (request.goalOperation) {
    const retry = inspectGoalChatSendRetry(params);
    if (retry.kind === "settled") {
      return false;
    }
    if (retry.kind === "replay") {
      // Let the existing recovery owner wake an interrupted admission before replaying its
      // original result. A receipt never creates another Goal or another human turn.
      const claim = await resolveDurableChatClaim({
        canonicalSessionKey: sessionKey,
        cfg,
        clientRunId,
        entry,
        persistedSessionKey: legacyKey ?? sessionKey,
        reloadEntry: () => loadSessionEntry(sessionLoadKey, sessionLoadOptions).entry,
        storePath,
        recoveryRuntime: context.recoveryRuntime,
        warn: (message) => context.logGateway.warn(message),
      });
      if (claim.kind === "pending" || claim.kind === "rejected") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, claim.message, {
            retryable: claim.kind === "pending",
          }),
        );
      } else {
        respond(true, { ...retry.receipt, replayed: true }, undefined, {
          cached: true,
          runId: clientRunId,
        });
      }
      return false;
    }
  }

  if (stopCommand) {
    if (sessionRoutingChanged(cfg)) {
      respondChatSessionRoutingChanged(respond);
      return false;
    }
    const stopOwnerScope = resolveChatSendStopOwnerScope({
      cfg,
      selectedAgentId: selectedAgent.agentId,
      sessionKey,
    });
    const res = await abortChatRunsForSessionKeyWithPartials({
      context,
      ops: createChatAbortOps(context),
      sessionKey,
      sessionKeyAliases: sessionKey === rawSessionKey ? undefined : [rawSessionKey],
      agentId: stopOwnerScope.agentId,
      sessionId: entry?.sessionId,
      session: {
        ok: true,
        value: { cfg, storePath, entry, canonicalKey: sessionKey, agentId: session.agentId },
      },
      defaultAgentId: stopOwnerScope.defaultAgentId,
      abortOrigin: "stop-command",
      stopReason: "stop",
      requester: resolveChatAbortRequester(client),
      cascadeDescendants: true,
    });
    const error = res.unauthorized
      ? errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized")
      : descendantAbortError(res.descendants, "Session");
    if (error) {
      respond(false, undefined, error);
      return false;
    }
    respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
    return false;
  }

  const cached = context.dedupe.get(`chat:${clientRunId}`);
  if (cached) {
    respond(cached.ok, cached.payload, cached.error, { cached: true });
    return false;
  }

  const abortMarker = context.chatRunState.runs.get(clientRunId)?.abortMarker;
  if (abortMarker !== undefined) {
    const abortedAt = chatAbortMarkerTimestampMs(abortMarker);
    const payload = buildAbortedChatSendPayload({ runId: clientRunId, endedAt: abortedAt });
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `chat:${clientRunId}`,
      entry: { ts: abortedAt, ok: true, payload },
    });
    respond(true, payload, undefined, { cached: true, runId: clientRunId });
    return false;
  }

  const pendingChatSend = readPreRegisteredRun({
    key: pendingChatSendKey,
    entry: context.dedupe.get(pendingChatSendKey),
    keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
  });
  if (pendingChatSend) {
    respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
      cached: true,
      runId: clientRunId,
    });
    return false;
  }

  if (context.chatAbortControllers.has(clientRunId) || context.chatQueuedTurns?.has(clientRunId)) {
    respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
      cached: true,
      runId: clientRunId,
    });
    return false;
  }

  const durableClaim = await resolveDurableChatClaim({
    canonicalSessionKey: sessionKey,
    cfg,
    clientRunId,
    entry,
    persistedSessionKey: legacyKey ?? sessionKey,
    reloadEntry: () => loadSessionEntry(sessionLoadKey, sessionLoadOptions).entry,
    storePath,
    recoveryRuntime: context.recoveryRuntime,
    warn: (message) =>
      context.logGateway.warn(`failed to retry durable chat recovery ${clientRunId}: ${message}`),
  });
  if (durableClaim.kind === "pending" || durableClaim.kind === "rejected") {
    respond(
      false,
      undefined,
      errorShape(
        durableClaim.kind === "pending" || durableClaim.unavailable
          ? ErrorCodes.UNAVAILABLE
          : ErrorCodes.INVALID_REQUEST,
        durableClaim.message,
        { retryable: durableClaim.kind === "pending" },
      ),
    );
    return false;
  }
  if (durableClaim.kind === "accepted") {
    if (request.goalOperation) {
      const retry = inspectGoalChatSendRetry({ ...params, durableClaimAccepted: true });
      if (retry.kind === "replay") {
        respond(true, { ...retry.receipt, replayed: true }, undefined, {
          cached: true,
          runId: clientRunId,
        });
      }
      return false;
    }
    // An active source claim or terminal tombstone proves the durable turn
    // was already accepted. Retire the outbox without dispatching twice.
    respond(true, { runId: clientRunId, status: "ok" as const }, undefined, {
      cached: true,
      runId: clientRunId,
    });
    return false;
  }

  // Cached/in-flight retries stay bound to their original target. Gate only a new dispatch.
  if (sessionRoutingChanged(cfg)) {
    respondChatSessionRoutingChanged(respond);
    return false;
  }
  const archivedSessionError = resolveSessionWorkStartError(sessionKey, entry, {
    allowPendingWorkspace: true,
  });
  if (archivedSessionError) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, archivedSessionError));
    return false;
  }
  return true;
}
