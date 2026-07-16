import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import { SESSION_ROUTING_CHANGED_ERROR_REASON } from "../../config/sessions/main-session.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { chatAbortMarkerTimestampMs } from "../server-chat-state.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX } from "../server-shared.js";
import { loadSessionEntry } from "../session-utils.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import {
  buildAbortedChatSendPayload,
  readPreRegisteredRun,
  resolveChatAbortRequester,
} from "./chat-abort-authorization.js";
import {
  abortChatRunsForSessionKeyWithPartials,
  createChatAbortOps,
} from "./chat-abort-runtime.js";
import { resolveDurableChatClaim } from "./chat-restart-recovery.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function respondChatSessionRoutingChanged(respond: GatewayRequestHandlerOptions["respond"]) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "session routing changed; review and retry", {
      details: { reason: SESSION_ROUTING_CHANGED_ERROR_REASON },
    }),
  );
}

/** Settle stop/retry/dedupe cases before reserving lifecycle admission. */
export async function runChatSendPreAdmission(params: {
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  respond: GatewayRequestHandlerOptions["respond"];
  context: GatewayRequestHandlerOptions["context"];
  client: GatewayRequestHandlerOptions["client"];
}): Promise<boolean> {
  const { request, session, respond, context, client } = params;
  const { stopCommand } = request;
  const {
    cfg,
    entry,
    sessionKey,
    rawSessionKey,
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
    channel: entry?.channel,
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

  if (stopCommand) {
    if (sessionRoutingChanged(cfg)) {
      respondChatSessionRoutingChanged(respond);
      return false;
    }
    const defaultAgentId = resolveDefaultAgentId(cfg);
    const stopAgentId =
      sessionKey === "global" ? (selectedAgent.agentId ?? defaultAgentId) : selectedAgent.agentId;
    const res = await abortChatRunsForSessionKeyWithPartials({
      context,
      ops: createChatAbortOps(context),
      sessionKey: rawSessionKey,
      sessionKeyAliases: sessionKey === rawSessionKey ? undefined : [sessionKey],
      agentId: stopAgentId,
      sessionId: entry?.sessionId,
      persistSessionKey: sessionKey,
      defaultAgentId,
      abortOrigin: "stop-command",
      stopReason: "stop",
      requester: resolveChatAbortRequester(client),
    });
    if (res.unauthorized) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
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

  const abortMarker = context.chatAbortedRuns.get(clientRunId);
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
    reloadEntry: () => loadSessionEntry(rawSessionKey, sessionLoadOptions).entry,
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
  const archivedSessionError = resolveSessionWorkStartError(sessionKey, entry);
  if (archivedSessionError) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, archivedSessionError));
    return false;
  }
  return true;
}
