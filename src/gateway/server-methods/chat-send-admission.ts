import { randomUUID } from "node:crypto";
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import {
  interruptReplyRunTarget,
  isReplyRunAbortableForSignal,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import { SESSION_ROUTING_CHANGED_ERROR_REASON } from "../../config/sessions/main-session.js";
import { readSessionTranscriptActivePathEntryRelation } from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { claimAgentRunContext, clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import {
  beginSessionWorkAdmission,
  interruptSessionWorkAdmissions,
  isCompetingSessionWorkAdmissionActive,
} from "../../sessions/session-lifecycle-admission.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { registerChatAbortController, resolveChatRunExpiresAtMs } from "../chat-abort.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX, type DedupeEntry } from "../server-shared.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  buildAbortedChatSendPayload,
  readPreRegisteredRun,
  writePreRegisteredChatAbort,
} from "./chat-abort-authorization.js";
import { resolveChatSendOriginatingRoute } from "./chat-origin-routing.js";
import {
  hasRestartRecoveryTerminalRun,
  isRetryableUnadoptedChatClaim,
  resolveRestartSafeChatAdmission,
} from "./chat-restart-recovery.js";
import {
  ACTIVE_LEAF_CHANGED_ERROR_REASON,
  respondChatActiveLeafChanged,
  respondChatSessionRoutingChanged,
} from "./chat-send-pre-admission.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { normalizeOptionalChatText, normalizeUnknownChatText } from "./chat-text-normalization.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Reserve the session lifecycle and register the abortable run before attachment work. */
export async function admitChatSend(params: {
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  respond: GatewayRequestHandlerOptions["respond"];
  context: GatewayRequestHandlerOptions["context"];
  client: GatewayRequestHandlerOptions["client"];
  onAdmissionOwned?: () => Promise<boolean>;
}) {
  const { request, session, respond, context, client } = params;
  const { p, explicitOrigin, normalizedAttachments, turnKind } = request;
  const {
    rawSessionKey,
    sessionLoadKey,
    clientRunId,
    pendingChatSendKey,
    sessionLoadOptions,
    cfg,
    storePath,
    entry,
    sessionKey,
    sessionRoutingChanged,
    selectedAgent,
    requestedSessionId,
    backingSessionId,
    agentId,
    resolvedSessionModel,
    resolvedSessionAuthProvider,
    activeRunScopeKey,
    timeoutMs,
    now,
    restartSafeRequest,
    expectedLeafEntryId,
  } = session;
  const chatSendTraceAttributes = {
    runId: clientRunId,
    sessionKey,
    agentId: selectedAgent.agentId ?? agentId,
    provider: resolvedSessionModel.provider,
    model: resolvedSessionModel.model,
    hasAttachments: normalizedAttachments.length > 0,
    hasExplicitOrigin: explicitOrigin !== undefined,
    hasConnectedClient: client?.connect !== undefined,
  };
  const originatingRoute = resolveChatSendOriginatingRoute({
    client: request.clientInfo,
    deliver: p.deliver,
    entry,
    explicitOrigin,
    hasConnectedClient: client?.connect !== undefined,
    mainKey: cfg.session?.mainKey,
    sessionKey,
  });
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const pendingAttemptId = randomUUID();
  const pendingExpiresAtMs = resolveChatRunExpiresAtMs({ now, timeoutMs });
  // Keep the run abortable while lifecycle mutation owns the session. Admission
  // must reject an expired/missing reservation instead of reviving evicted work.
  context.dedupe.set(pendingChatSendKey, {
    ts: now,
    ok: true,
    payload: {
      runId: clientRunId,
      attemptId: pendingAttemptId,
      status: "accepted" as const,
      sessionKey,
      ...(rawSessionKey === sessionKey ? {} : { sessionKeyAliases: [rawSessionKey] }),
      ...(selectedAgent.agentId ? { agentId: selectedAgent.agentId } : {}),
      ownerConnId: normalizeOptionalChatText(client?.connId),
      ownerDeviceId: normalizeOptionalChatText(client?.connect?.device?.id),
      expiresAtMs: pendingExpiresAtMs,
      turnKind,
    },
  });
  const clearPendingChatSendReservation = () => {
    const pending = readPreRegisteredRun({
      key: pendingChatSendKey,
      entry: context.dedupe.get(pendingChatSendKey),
      keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
    });
    if (
      pending?.runId === clientRunId &&
      normalizeUnknownChatText(pending.payload.attemptId) === pendingAttemptId
    ) {
      context.dedupe.delete(pendingChatSendKey);
    }
  };
  let admittedSessionId = backingSessionId ?? clientRunId;
  let gatewayWorkAdmission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
  let admittedRunAbort: ReturnType<typeof registerChatAbortController> | undefined;
  let restartSafeAdmission: ReturnType<typeof resolveRestartSafeChatAdmission>;
  let messageInjectionTarget: ReturnType<
    typeof replyRunRegistry.resolveCurrentMessageInjectionTarget
  >;
  let runInterruptTarget: ReturnType<typeof replyRunRegistry.resolveCurrentInterruptTarget>;
  let reservationSuperseded = false;
  let supersedingResult: DedupeEntry | undefined;
  const assertChatWorkAdmissionAllowed = (commitOutcome: boolean) => {
    if (context.chatRunState.hasAbortMarker(clientRunId)) {
      return;
    }
    const pendingReservation = readPreRegisteredRun({
      key: pendingChatSendKey,
      entry: context.dedupe.get(pendingChatSendKey),
      keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
    });
    if (
      pendingReservation &&
      normalizeUnknownChatText(pendingReservation.payload.attemptId) !== pendingAttemptId
    ) {
      if (commitOutcome) {
        reservationSuperseded = true;
      }
      return;
    }
    if (!pendingReservation) {
      const terminalResult = context.dedupe.get(`chat:${clientRunId}`);
      if (terminalResult || context.chatAbortControllers.has(clientRunId)) {
        if (commitOutcome) {
          reservationSuperseded = true;
          supersedingResult = terminalResult;
        }
        return;
      }
    }
    if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
      if (commitOutcome) {
        writePreRegisteredChatAbort({
          context,
          runId: clientRunId,
          stopReason: "restart",
          attemptId: pendingAttemptId,
        });
      }
      return;
    }
    if (
      !pendingReservation ||
      !isFutureDateTimestampMs(pendingReservation.payload.expiresAtMs, { nowMs: Date.now() })
    ) {
      if (commitOutcome) {
        writePreRegisteredChatAbort({
          context,
          runId: clientRunId,
          stopReason: "timeout",
          attemptId: pendingAttemptId,
        });
      }
      return;
    }
    const latestSession = loadSessionEntry(sessionLoadKey, sessionLoadOptions);
    if (sessionRoutingChanged(latestSession.cfg)) {
      throw new Error(SESSION_ROUTING_CHANGED_ERROR_REASON);
    }
    const latestEntry = latestSession.entry;
    if (entry && !latestEntry) {
      throw new Error(`Session "${sessionKey}" was deleted while starting work. Retry.`);
    }
    // Capture the exact direct owner under the writer barrier. If it clears
    // later, the opaque target rejects instead of resolving a successor.
    const resolvedInjectionTarget =
      p.queueMode === "steer"
        ? replyRunRegistry.resolveCurrentMessageInjectionTarget(activeRunScopeKey)
        : undefined;
    if (commitOutcome && resolvedInjectionTarget) {
      messageInjectionTarget = resolvedInjectionTarget;
    }
    const resolvedInterruptTarget =
      p.queueMode === "interrupt"
        ? replyRunRegistry.resolveCurrentInterruptTarget(activeRunScopeKey)
        : undefined;
    if (commitOutcome && resolvedInterruptTarget) {
      runInterruptTarget = resolvedInterruptTarget;
    }
    if (commitOutcome && p.queueMode !== "steer" && expectedLeafEntryId !== undefined) {
      // Runtime session identity resolves through the canonical SQLite accessor;
      // legacy/reset-archive files are read-only history fallbacks, never send targets.
      const activePathRelation = latestEntry?.sessionId
        ? readSessionTranscriptActivePathEntryRelation(
            {
              agentId,
              sessionId: latestEntry.sessionId,
              sessionKey: latestSession.canonicalKey,
              sessionEntry: latestEntry,
              storePath: latestSession.storePath,
            },
            expectedLeafEntryId,
          )
        : expectedLeafEntryId === null
          ? "exact"
          : "off-path";
      // Branch switches preserve entry ids while rotating session ids. A supplied session id
      // must fence exact and ancestor matches; omission remains legacy exact-only compatibility.
      const matchesRequestedSession =
        requestedSessionId === undefined || requestedSessionId === latestEntry?.sessionId;
      const matchesActivePath =
        activePathRelation === "exact" ||
        (activePathRelation === "ancestor" && requestedSessionId !== undefined);
      if (!matchesRequestedSession || !matchesActivePath) {
        throw new Error(ACTIVE_LEAF_CHANGED_ERROR_REASON);
      }
    }
    // Admission can queue behind reset. Never route a request captured
    // against the old session into the replacement transcript. Expected-leaf sends
    // defer this check to locked revalidation so branch rotation returns its typed error.
    if (
      backingSessionId &&
      latestEntry?.sessionId &&
      latestEntry.sessionId !== backingSessionId &&
      (expectedLeafEntryId === undefined || commitOutcome)
    ) {
      throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
    }
    const retryableClaim = isRetryableUnadoptedChatClaim(latestEntry, clientRunId);
    if (
      (latestEntry?.restartRecoveryDeliveryRunId &&
        latestEntry.restartRecoveryDeliverySourceRunId === clientRunId &&
        !retryableClaim) ||
      hasRestartRecoveryTerminalRun(latestEntry, clientRunId)
    ) {
      // Recovery can settle while this retry waits on lifecycle admission.
      // Revalidate under that admission so a stale pre-lock snapshot cannot dispatch twice.
      if (commitOutcome) {
        reservationSuperseded = true;
        supersedingResult = {
          ts: Date.now(),
          ok: true,
          payload: { runId: clientRunId, status: "ok" as const },
        };
      }
      return;
    }
    const archivedError = resolveSessionWorkStartError(sessionKey, latestEntry, {
      allowPendingWorkspace: true,
    });
    if (archivedError) {
      throw new Error(archivedError);
    }
    if (!commitOutcome) {
      return;
    }
    admittedSessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
    restartSafeAdmission = resolveRestartSafeChatAdmission({
      agentId,
      cfg: latestSession.cfg,
      clientRunId,
      context,
      entry: latestEntry,
      now: Date.now(),
      request: restartSafeRequest,
      requestedSessionId,
      sessionId: admittedSessionId,
      sessionKey: latestSession.canonicalKey,
      storePath: latestSession.storePath,
    });
    if (retryableClaim && !restartSafeAdmission) {
      throw new Error("chat retry does not match its durable admission");
    }
    // A terminal Control UI claim can survive a crash after status commit.
    // The transcript transaction merges its source with fresh tombstones.
    admittedRunAbort = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: clientRunId,
      sessionId: admittedSessionId,
      sessionKey,
      agentId: selectedAgent.agentId,
      timeoutMs,
      now,
      ownerConnId: normalizeOptionalChatText(client?.connId),
      ownerDeviceId: normalizeOptionalChatText(client?.connect?.device?.id),
      providerId: resolvedSessionModel.provider,
      authProviderId: resolvedSessionAuthProvider,
      isAbortable: (active) => isReplyRunAbortableForSignal(active.controller.signal),
      kind: "chat-send",
      turnKind,
      lifecycleGeneration,
    });
  };

  try {
    gatewayWorkAdmission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, backingSessionId],
      assertAllowed: () => assertChatWorkAdmissionAllowed(false),
      revalidateAllowed: () => assertChatWorkAdmissionAllowed(true),
      onInterrupt: () => {
        if (admittedRunAbort?.entry) {
          admittedRunAbort.entry.abortStopReason = "restart";
        }
        admittedRunAbort?.controller.abort(createAgentRunRestartAbortError());
      },
    });
  } catch (err) {
    clearPendingChatSendReservation();
    if (err instanceof Error && err.message === SESSION_ROUTING_CHANGED_ERROR_REASON) {
      respondChatSessionRoutingChanged(respond);
      return { ok: false as const };
    }
    if (err instanceof Error && err.message === ACTIVE_LEAF_CHANGED_ERROR_REASON) {
      respondChatActiveLeafChanged(respond);
      return { ok: false as const };
    }
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
    return { ok: false as const };
  }
  clearPendingChatSendReservation();
  const activeRunAbort = admittedRunAbort;
  if (reservationSuperseded) {
    gatewayWorkAdmission.release();
    const supersedingCached = supersedingResult ?? context.dedupe.get(`chat:${clientRunId}`);
    if (supersedingCached) {
      respond(supersedingCached.ok, supersedingCached.payload, supersedingCached.error, {
        cached: true,
        runId: clientRunId,
      });
      return { ok: false as const };
    }
    respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
      cached: true,
      runId: clientRunId,
    });
    return { ok: false as const };
  }
  if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
    if (activeRunAbort) {
      if (activeRunAbort.entry) {
        activeRunAbort.entry.abortStopReason = "restart";
      }
      activeRunAbort.controller.abort();
      activeRunAbort.cleanup({ force: true });
    }
    gatewayWorkAdmission.release();
    if (!context.dedupe.has(`chat:${clientRunId}`)) {
      writePreRegisteredChatAbort({
        context,
        runId: clientRunId,
        stopReason: activeRunAbort?.entry?.abortStopReason ?? "restart",
        attemptId: pendingAttemptId,
      });
    }
    const aborted = context.dedupe.get(`chat:${clientRunId}`);
    respond(aborted?.ok ?? true, aborted?.payload, aborted?.error, {
      cached: true,
      runId: clientRunId,
    });
    return { ok: false as const };
  }
  if (!activeRunAbort) {
    gatewayWorkAdmission.release();
    const aborted = context.dedupe.get(`chat:${clientRunId}`);
    if (aborted) {
      respond(aborted.ok, aborted.payload, aborted.error, {
        cached: true,
        runId: clientRunId,
      });
      return { ok: false as const };
    }
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "chat run admission failed"));
    return { ok: false as const };
  }
  if (!activeRunAbort.registered) {
    gatewayWorkAdmission.release();
    respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
      cached: true,
      runId: clientRunId,
    });
    return { ok: false as const };
  }
  let releaseGatewayRootContinuation = () => {};
  // Until dispatch takes custody, interruption and callback failures own the same three resources.
  const cleanupPreDispatchAdmission = () => {
    activeRunAbort.cleanup({ force: true });
    gatewayWorkAdmission.release();
    releaseGatewayRootContinuation();
  };
  let interruptedActiveRun = false;
  try {
    let interruptionSettled = true;
    if (runInterruptTarget) {
      interruptedActiveRun = true;
      interruptionSettled = (
        await interruptReplyRunTarget(runInterruptTarget, REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS)
      ).settled;
    } else if (p.queueMode === "interrupt") {
      const identities = [sessionKey, backingSessionId, admittedSessionId];
      // The fallback runs inside the new admission so the lifecycle owner excludes itself.
      // A captured reply operation never falls through to this identity-scoped path.
      const fallback = await gatewayWorkAdmission.run(async () => {
        if (!isCompetingSessionWorkAdmissionActive(storePath, identities)) {
          return { interrupted: false, settled: true };
        }
        return {
          interrupted: true,
          settled: await interruptSessionWorkAdmissions({
            scope: storePath,
            identities,
            timeoutMs: REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
          }),
        };
      });
      interruptedActiveRun = fallback.interrupted;
      interruptionSettled = fallback.settled;
    }
    if (!interruptionSettled) {
      cleanupPreDispatchAdmission();
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Previous run is still shutting down. Please try again in a moment.",
          { retryable: true, retryAfterMs: 250 },
        ),
      );
      return { ok: false as const };
    }
    // Reserve while the request root is live: detached dispatch retains it until terminal persistence.
    releaseGatewayRootContinuation = retainGatewayRootWorkAdmissionContinuation() ?? (() => {});
    if (params.onAdmissionOwned && !(await gatewayWorkAdmission.run(params.onAdmissionOwned))) {
      cleanupPreDispatchAdmission();
      return { ok: false as const };
    }
  } catch (error) {
    cleanupPreDispatchAdmission();
    throw error;
  }

  const acquiredGatewayWorkAdmission = gatewayWorkAdmission;
  let gatewayWorkAdmissionRetains = 1;
  const releaseGatewayWorkAdmission = () => {
    if (gatewayWorkAdmissionRetains === 0) {
      return;
    }
    gatewayWorkAdmissionRetains -= 1;
    if (gatewayWorkAdmissionRetains === 0) {
      acquiredGatewayWorkAdmission.release();
    }
  };
  let initialGatewayWorkAdmissionReleased = false;
  const releaseInitialGatewayWorkAdmission = () => {
    if (initialGatewayWorkAdmissionReleased) {
      return;
    }
    initialGatewayWorkAdmissionReleased = true;
    releaseGatewayWorkAdmission();
  };
  const retainGatewayWorkAdmission = () => {
    if (gatewayWorkAdmissionRetains === 0) {
      throw new Error("cannot retain a released chat work admission");
    }
    gatewayWorkAdmissionRetains += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      releaseGatewayWorkAdmission();
    };
  };
  // Prepared inbound media has no transcript reference until the user turn
  // persists; every abandonment exit funnels through cleanupAdmittedRun, so
  // the armed discard here is the single custody owner for that window. The
  // handler disarms it once the media becomes referenced (durable admission
  // or ACK handing ownership to dispatch, which persists on all paths).
  let discardAbandonedPreparedMedia: (() => void) | undefined;
  const cleanupAdmittedRun: typeof activeRunAbort.cleanup = (options) => {
    activeRunAbort.cleanup(options);
    releaseInitialGatewayWorkAdmission();
    releaseGatewayRootContinuation();
    discardAbandonedPreparedMedia?.();
    discardAbandonedPreparedMedia = undefined;
  };
  const rejectSessionRoutingChanged = () => {
    cleanupAdmittedRun({ force: true });
    clearAgentRunContext(clientRunId, lifecycleGeneration);
    respondChatSessionRoutingChanged(respond);
  };
  const finishAbortedChatSend = () => {
    const stopReason = activeRunAbort.entry?.abortStopReason ?? "rpc";
    const endedAt = Date.now();
    const payload = buildAbortedChatSendPayload({ runId: clientRunId, stopReason, endedAt });
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `chat:${clientRunId}`,
      entry: { ts: endedAt, ok: true, payload },
    });
    cleanupAdmittedRun();
    clearAgentRunContext(clientRunId, lifecycleGeneration);
    respond(true, payload, undefined, { runId: clientRunId });
  };
  claimAgentRunContext(clientRunId, {
    sessionKey,
    sessionId: admittedSessionId,
    lifecycleGeneration,
  });

  return {
    ok: true as const,
    value: {
      activeRunAbort,
      admittedSessionId,
      chatSendTraceAttributes,
      cleanupAdmittedRun,
      finishAbortedChatSend,
      gatewayWorkAdmission,
      lifecycleGeneration,
      interruptedActiveRun,
      messageInjectionTarget,
      originatingRoute,
      rejectSessionRoutingChanged,
      retainGatewayWorkAdmission,
      restartSafeAdmission,
      setDiscardAbandonedPreparedMedia: (discard: (() => void) | undefined) => {
        discardAbandonedPreparedMedia = discard;
      },
    },
  };
}

export type AdmittedChatSend = Extract<
  Awaited<ReturnType<typeof admitChatSend>>,
  { ok: true }
>["value"];
