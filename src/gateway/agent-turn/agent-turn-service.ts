import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, type AgentWaitParams } from "../../../packages/gateway-protocol/src/index.js";
import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import {
  releaseMainSessionRecoveryOwner,
  type MainSessionRecoveryOwnerLease,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { mergeSessionEntry, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import { discardPreparedInboundMedia, type OffloadedRef } from "../chat-attachments.js";
import { errorShapeFromError } from "../error-shape.js";
import { createCronContinuationController } from "../server-methods/agent-cron-continuation.js";
import { runAgentResetPhase } from "../server-methods/agent-reset-phase.js";
import { buildAgentSessionPatch } from "../server-methods/agent-session-patch.js";
import { prepareAgentSession } from "../server-methods/agent-session-prepare.js";
import { handleChatAbortRequest } from "../server-methods/chat-abort-handler.js";
import { resolveAgentRunSessionCreation } from "../server-methods/session-creation-provenance.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "../server-methods/shared-types.js";
import { authorizeResolvedSessionMutation } from "../session-sharing.js";
import { createAgentAdmissionController } from "./agent-admission-controller.js";
import { prepareAgentContentPhase } from "./agent-content-phase.js";
import { createAgentDedupeLifecycle } from "./agent-dedupe-lifecycle.js";
import { isAcceptedAgentDedupePayload, readGatewayDedupeEntry } from "./agent-dedupe.js";
import { resolveAgentDeliveryPhase } from "./agent-delivery-phase.js";
import type { RestoredCronContinuation } from "./agent-handler-helpers.js";
import { waitForAgentJob } from "./agent-job.js";
import type { AgentRequestPreflight } from "./agent-request-preflight.js";
import { prepareAgentRequestRouting } from "./agent-request-routing.js";
import { prepareAgentRunDispatch } from "./agent-run-admission-phase.js";
import { startAgentRunExecution } from "./agent-run-execution-phase.js";
import { persistAgentSessionPhase } from "./agent-session-persist.js";
import type { AgentTurnIo, AgentTurnPrincipal } from "./types.js";

type AgentTurnStartRequest = {
  preflight: AgentRequestPreflight;
  principal: AgentTurnPrincipal | null;
  io: AgentTurnIo;
  onRunObserved?: (runId: string) => void;
};

function createAcceptanceRespond(io: AgentTurnIo): RespondFn {
  return (ok, payload, error, meta) => io.emitAcceptance([ok, payload, error], meta);
}

function replayAgentTurnIfCached(params: {
  preflight: AgentRequestPreflight;
  context: GatewayRequestHandlerOptions["context"];
  io: AgentTurnIo;
}): boolean {
  const { agentDedupeKeys, runId } = params.preflight;
  const cached = readGatewayDedupeEntry({
    dedupe: params.context.dedupe,
    keys: agentDedupeKeys,
  });
  if (!cached) {
    return false;
  }
  if (cached.ok && isAcceptedAgentDedupePayload(cached.payload)) {
    const cachedRunId =
      typeof cached.payload.runId === "string" && cached.payload.runId.trim()
        ? cached.payload.runId.trim()
        : runId;
    const cachedSessionKey =
      typeof cached.payload.sessionKey === "string" && cached.payload.sessionKey.trim()
        ? cached.payload.sessionKey.trim()
        : undefined;
    const cachedAgentId =
      typeof cached.payload.agentId === "string" && cached.payload.agentId.trim()
        ? cached.payload.agentId.trim()
        : undefined;
    params.io.emitAcceptance(
      [
        true,
        {
          runId: cachedRunId,
          status: "in_flight" as const,
          ...(cachedSessionKey ? { sessionKey: cachedSessionKey } : {}),
          ...(cachedAgentId ? { agentId: cachedAgentId } : {}),
        },
        undefined,
      ],
      { cached: true, runId: cachedRunId },
    );
  } else {
    params.io.emitAcceptance([cached.ok, cached.payload, cached.error], { cached: true });
  }
  return true;
}

export function createAgentTurnService({
  context,
  isWebchatConnect,
}: Pick<GatewayRequestHandlerOptions, "context" | "isWebchatConnect">) {
  const startTurn = async ({
    preflight,
    principal,
    io,
    onRunObserved,
  }: AgentTurnStartRequest): Promise<void> => {
    if (replayAgentTurnIfCached({ preflight, context, io })) {
      return;
    }
    const respond = createAcceptanceRespond(io);
    const {
      request,
      cfg,
      runId,
      allowModelOverride,
      canUseInternalRuntimeHandoff,
      canUseCronRunContinuation,
      expectedSession,
      expectedExistingSessionId,
      providerOverride,
      modelOverride,
      execApprovalFollowupApprovalId,
      normalizedSpawned,
      inputProvenance,
      isRestartRecoveryResumeRun,
      preserveUserFacingSessionModelState,
      sessionEffects,
      suppressVisibleSessionEffects,
      requestedPromptPersistenceSuppression,
      isOneShotModelRun,
      isRawModelRun,
      agentDedupeKeys,
    } = preflight;
    // Cached replay returns before a new lifecycle generation is observed, matching
    // the idempotency path that preceded this service extraction.
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    let resolvedGroupId: string | undefined = normalizedSpawned.groupId;
    let resolvedGroupChannel: string | undefined = normalizedSpawned.groupChannel;
    let resolvedGroupSpace: string | undefined = normalizedSpawned.groupSpace;
    let spawnedByValue: string | undefined;
    const ownerConnId = typeof principal?.connId === "string" ? principal.connId : undefined;
    const ownerDeviceId =
      typeof principal?.connect?.device?.id === "string" ? principal.connect.device.id : undefined;
    const dedupeLifecycle = createAgentDedupeLifecycle({
      cfg,
      request,
      runId,
      lifecycleGeneration,
      agentDedupeKeys,
      suppressVisibleSessionEffects,
      ownerConnId,
      ownerDeviceId,
      context,
      io,
    });
    const reservePreAcceptedAgentDedupe = dedupeLifecycle.reserve;
    const clearUnacceptedAgentDedupe = dedupeLifecycle.clearUnaccepted;
    const abortForLifecycleRotation = dedupeLifecycle.abortForLifecycleRotation;
    const routing = await prepareAgentRequestRouting({
      request,
      cfg,
      expectedSession,
      isRawModelRun,
      execApprovalFollowupApprovalId,
      runId,
      agentDedupeKeys,
      context,
      respond,
      reserveDedupe: reservePreAcceptedAgentDedupe,
      clearDedupe: clearUnacceptedAgentDedupe,
    });
    if (!routing) {
      return;
    }
    const {
      normalizedAttachments,
      requestedBestEffortDeliver,
      knownAgents,
      requestedSessionId,
      requestedToRaw,
      sessionKeyFromTo,
      requestedSessionKeyRaw,
      explicitRecipientSession,
      preAcceptedReservedSessionKey,
      preAttachmentSession,
    } = routing;
    let agentId = routing.agentId;
    let requestedSessionKey = routing.requestedSessionKey;
    let gatewayAdmissionTransferred = false;
    let preparedOffloadedRefs: OffloadedRef[] = [];
    let mainRestartRecoveryOwnerLease: MainSessionRecoveryOwnerLease | undefined;
    let releaseGatewayAdmission = () => {};
    const cronContinuation = createCronContinuationController({
      runId,
      lifecycleGeneration,
      context,
    });
    const releaseCronContinuationClaimWithRecovery = cronContinuation.releaseWithRecovery;
    try {
      const content = await prepareAgentContentPhase({
        request,
        cfg,
        context,
        respond,
        isRawModelRun,
        inputProvenance,
        normalizedAttachments,
        requestedSessionKeyRaw,
        requestedSessionKey,
        requestedSessionId,
        requestedToRaw,
        sessionKeyFromTo,
        agentId,
        providerOverride,
        modelOverride,
        explicitRecipientSession,
        knownAgents,
      });
      if (!content) {
        return;
      }
      preparedOffloadedRefs = content.offloadedRefs;
      agentId = content.agentId;
      requestedSessionKey = content.requestedSessionKey;
      // Participation is authorized below against the canonical session the run
      // actually targets (see prepareAgentSession). A keyless request resolves its
      // default/effective session there, so authorizing only an explicit key here
      // would let a non-member drive a restricted default session.
      let effectiveTranscriptInputText = content.effectiveTranscriptInputText;
      let message = content.message;
      const {
        images,
        imageOrder,
        media,
        offloadedRefs,
        replyTo,
        recipientChannel,
        recipientAccountId,
        recipientThreadId,
        to,
      } = content;
      let resolvedSessionId = requestedSessionId;
      let sessionEntry: SessionEntry | undefined;
      let effectiveBootstrapContextRunKind = request.bootstrapContextRunKind;
      let restoredCronContinuation: RestoredCronContinuation | undefined;
      let restoredCronContinuationIdentity:
        | Pick<RestoredCronContinuation, "lifecycleRevision" | "sessionId">
        | undefined;
      let sessionPersistedBeforeGatewayAdmission = false;
      let bestEffortDeliver = requestedBestEffortDeliver ?? false;
      let cfgForAgent: OpenClawConfig | undefined;
      let resolvedSessionKey = requestedSessionKey;
      let resolvedSessionAgentId: string | undefined;
      let isNewSession = false;
      let supersededSessionId: string | undefined;
      let skipAgentInitialSessionTouch = false;
      let pendingChatRun: { sessionKey: string; agentId?: string } | undefined;
      let resolvedStorePath: string | undefined;
      let admittedSessionId = resolvedSessionId ?? runId;
      const admissionController = createAgentAdmissionController({
        cfg,
        runId,
        lifecycleGeneration,
        agentDedupeKeys,
        preAcceptedReservedSessionKey,
        expectedSession,
        context,
        io,
        dedupeLifecycle,
        getRequestedSessionKey: () => requestedSessionKey,
        getResolvedSessionKey: () => resolvedSessionKey,
        getResolvedSessionId: () => resolvedSessionId,
        getResolvedSessionAgentId: () => resolvedSessionAgentId,
        getAgentId: () => agentId,
        getCfgForAgent: () => cfgForAgent,
        getSessionPersisted: () => sessionPersistedBeforeGatewayAdmission,
        getSupersededSessionId: () => supersededSessionId,
        setAdmittedSessionId: (sessionId) => {
          admittedSessionId = sessionId;
        },
      });
      const admissionAgentId = admissionController.admissionAgentId;
      const assertGatewayWorkAdmissionAllowed = admissionController.assertAllowed;
      const acquireGatewayWorkAdmission = admissionController.acquire;
      const respondToGatewayAdmissionOutcome = admissionController.respondToOutcome;
      releaseGatewayAdmission = admissionController.release;
      const resetPhase = await runAgentResetPhase({
        request,
        cfg,
        requestedSessionKey,
        resolvedSessionId,
        effectiveTranscriptInputText,
        message,
        agentId,
        sessionKeyFromTo,
        lifecycleGeneration,
        runId,
        agentDedupeKeys,
        client: principal,
        context,
        respond,
        abortForLifecycleRotation,
        setCommittedResetCompletion: dedupeLifecycle.setCommittedResetCompletion,
      });
      requestedSessionKey = resetPhase.requestedSessionKey;
      resolvedSessionId = resetPhase.resolvedSessionId;
      effectiveTranscriptInputText = resetPhase.effectiveTranscriptInputText;
      message = resetPhase.message;
      if (resetPhase.accepted) {
        dedupeLifecycle.markAccepted(true);
      }
      if (resetPhase.stop) {
        return;
      }

      if (requestedSessionKey) {
        const preparedSession = prepareAgentSession({
          cfg,
          requestedSessionKey,
          requestedSessionId,
          expectedExistingSessionId,
          agentId,
          recipientChannel,
          request,
          canUseCronRunContinuation,
          lifecycleGeneration,
          effectiveBootstrapContextRunKind,
          preAttachmentSession,
          respond,
        });
        if (!preparedSession) {
          return;
        }
        const {
          cfg: cfgLocal,
          storePath,
          entry,
          canonicalKey,
          storeKeys,
          maintenanceConfig: sessionMaintenanceConfig,
          canonicalSessionAgentId,
          resetPolicy,
          now,
          visibleRequest,
          mainSessionKey: mainSessionKeyForRequest,
          isSystemGatewayRun,
          sessionId,
          touchInteraction,
          failedSessionTranscriptMissing: resolveFailedSessionTranscriptMissingForEntry,
        } = preparedSession;
        cfgForAgent = cfgLocal;
        resolvedStorePath = storePath;
        // Authorize the canonical session the run will actually target — covering
        // keyless requests whose default/effective session is resolved only here —
        // before any run side effects (admission, dispatch).
        const sharingError = authorizeResolvedSessionMutation({
          cfg: cfgLocal,
          client: principal,
          sessionKey: canonicalKey,
          agentId: canonicalSessionAgentId,
        });
        if (sharingError) {
          io.emitAcceptance([false, undefined, sharingError]);
          return;
        }
        effectiveBootstrapContextRunKind = preparedSession.effectiveBootstrapContextRunKind;
        restoredCronContinuationIdentity = preparedSession.restoredCronContinuationIdentity;
        sessionPersistedBeforeGatewayAdmission =
          preparedSession.sessionPersistedBeforeGatewayAdmission;
        isNewSession = preparedSession.isNewSession;
        const sessionAgent = canonicalSessionAgentId;
        const requestDeliveryHint = normalizeDeliveryContext({
          channel: recipientChannel?.trim(),
          to,
          accountId: recipientAccountId?.trim(),
          // Pass threadId directly — normalizeDeliveryContext handles both
          // string and numeric threadIds (e.g., Matrix uses integers).
          threadId: recipientThreadId,
        });
        const explicitSessionKey = normalizeOptionalString(request.sessionKey);
        const buildSessionPatch = (freshEntry: SessionEntry | undefined) =>
          buildAgentSessionPatch({
            freshEntry,
            initialEntry: entry,
            cfg: cfgLocal,
            sessionAgentId: sessionAgent,
            canonicalSessionKey: canonicalKey,
            storePath,
            normalizedSpawned,
            requestDeliveryHint,
            requestLabel: request.label,
            ...(explicitSessionKey ? { explicitSessionKey } : {}),
            pluginOwnerId:
              freshEntry === undefined
                ? normalizeOptionalString(principal?.internal?.pluginRuntimeOwnerId)
                : undefined,
            expectedExistingSessionId,
            hasRestoredCronContinuation: restoredCronContinuationIdentity !== undefined,
            resetPolicy,
            now,
            requestedSessionId,
            isSystemGatewayRun,
            visibleRequest,
            fallbackSessionId: sessionId,
            touchInteraction,
            failedSessionTranscriptMissing: resolveFailedSessionTranscriptMissingForEntry,
          });
        const patchBuild = buildSessionPatch(entry);
        isNewSession = patchBuild.isNewSession;
        sessionEntry = mergeSessionEntry(entry, patchBuild.patch);
        resolvedSessionId = sessionEntry?.sessionId ?? sessionId;
        admittedSessionId = resolvedSessionId ?? runId;
        const canonicalSessionKey = canonicalKey;
        resolvedSessionKey = canonicalSessionKey;
        const sessionAgentId = canonicalSessionAgentId;
        resolvedSessionAgentId = sessionAgentId;
        const mainSessionKey = mainSessionKeyForRequest;
        try {
          await acquireGatewayWorkAdmission(storePath ?? `agent:${sessionAgentId}`);
        } catch (err) {
          io.emitAcceptance([
            false,
            undefined,
            errorShapeFromError(ErrorCodes.INVALID_REQUEST, err),
          ]);
          return;
        }
        if (respondToGatewayAdmissionOutcome()) {
          return;
        }
        const persistedSession = await persistAgentSessionPhase({
          request,
          cfg: cfgLocal,
          storePath,
          storeKeys,
          entry,
          canonicalSessionKey,
          sessionAgentId,
          mainSessionKey,
          creation: resolveAgentRunSessionCreation(principal),
          lifecycleGeneration,
          isRestartRecoveryResumeRun,
          runId,
          agentId,
          suppressVisibleSessionEffects,
          restoredCronContinuationIdentity,
          initialPatchBuild: patchBuild,
          buildSessionPatch,
          initialSessionEntry: sessionEntry,
          initialResolvedSessionId: resolvedSessionId,
          initialSessionPersistedBeforeGatewayAdmission: sessionPersistedBeforeGatewayAdmission,
          initialSupersededSessionId: supersededSessionId,
          touchInteraction,
          requestedBestEffortDeliver,
          bestEffortDeliver,
          expectedSession,
          maintenanceConfig: sessionMaintenanceConfig,
          abortForLifecycleRotation,
          assertGatewayWorkAdmissionAllowed,
          respondToGatewayAdmissionOutcome,
          updateAdmissionState: (state) => {
            resolvedSessionId = state.resolvedSessionId;
            admittedSessionId = state.admittedSessionId;
            supersededSessionId = state.supersededSessionId;
            sessionPersistedBeforeGatewayAdmission = state.sessionPersistedBeforeGatewayAdmission;
          },
          getAdmittedSessionId: () => admittedSessionId,
          setCronContinuationClaim: cronContinuation.setClaim,
          setMainRestartRecoveryOwnerLease: (lease) => {
            mainRestartRecoveryOwnerLease = lease;
          },
          respond,
        });
        if (!persistedSession) {
          return;
        }
        sessionEntry = persistedSession.sessionEntry;
        resolvedSessionId = persistedSession.resolvedSessionId;
        sessionPersistedBeforeGatewayAdmission =
          persistedSession.sessionPersistedBeforeGatewayAdmission;
        supersededSessionId = persistedSession.supersededSessionId;
        admittedSessionId = persistedSession.admittedSessionId;
        skipAgentInitialSessionTouch = persistedSession.skipAgentInitialSessionTouch;
        isNewSession = persistedSession.isNewSession;
        spawnedByValue = persistedSession.spawnedBy;
        resolvedGroupId = persistedSession.groupId;
        resolvedGroupChannel = persistedSession.groupChannel;
        resolvedGroupSpace = persistedSession.groupSpace;
        pendingChatRun = persistedSession.pendingChatRun;
        bestEffortDeliver = persistedSession.bestEffortDeliver;
        restoredCronContinuation = persistedSession.restoredCronContinuation;
      }

      const delivery = await resolveAgentDeliveryPhase({
        request,
        cfg,
        cfgForAgent,
        sessionEntry,
        resolvedSessionKey,
        resolvedSessionAgentId,
        agentId,
        replyTo,
        to,
        recipientChannel,
        recipientAccountId,
        recipientThreadId,
        bestEffortDeliver,
        runId,
        client: principal,
        context,
        respond,
        isWebchatConnect,
        onRunObserved,
      });
      if (!delivery) {
        return;
      }
      const { activeSessionAgentId } = delivery;

      const preparedDispatch = await prepareAgentRunDispatch({
        request,
        cfg,
        cfgForAgent,
        sessionEntry,
        resolvedSessionKey,
        requestedSessionKeyRaw,
        requestedSessionKey,
        preAcceptedReservedSessionKey,
        activeSessionAgentId,
        delivery,
        restoredCronContinuationIdentity,
        restoredCronContinuation,
        providerOverride,
        modelOverride,
        allowModelOverride,
        lifecycleGeneration,
        getAdmittedSessionId: () => admittedSessionId,
        ownerConnId,
        ownerDeviceId,
        suppressVisibleSessionEffects,
        pendingChatRun,
        inputProvenance,
        isOneShotModelRun,
        isRestartRecoveryResumeRun,
        canUseInternalRuntimeHandoff,
        execApprovalFollowupApprovalId,
        message,
        effectiveTranscriptInputText,
        images,
        offloadedRefs,
        onUserTurnMediaPersisted: () => {
          preparedOffloadedRefs = [];
        },
        requestedPromptPersistenceSuppression,
        runId,
        agentDedupeKeys,
        context,
        client: principal,
        io,
        abortForLifecycleRotation,
        acquireGatewayWorkAdmission,
        assertGatewayWorkAdmissionAllowed,
        hasGatewayAdmissionOutcome: admissionController.hasOutcome,
        respondToGatewayAdmissionOutcome,
        admissionAgentId,
        getGatewayWorkAdmission: admissionController.getAdmission,
        setAdmittedRunAbort: admissionController.setAdmittedRunAbort,
        getAdmittedRunAbort: admissionController.getAdmittedRunAbort,
        markAgentRunAccepted: dedupeLifecycle.markAccepted,
      });
      if (!preparedDispatch) {
        return;
      }
      resolvedSessionId = admittedSessionId;
      // The prepared dispatch now owns either transcript-persisted media or its
      // closed unpersisted ref set; admission must not retain a second owner.
      preparedOffloadedRefs = [];
      gatewayAdmissionTransferred = true;
      // This captures ambient root admission synchronously, then settles the final
      // frame on the existing detached chain after the router returns its acceptance.
      startAgentRunExecution({
        prepared: preparedDispatch,
        mainRestartRecoveryOwnerLease,
        request,
        cfg,
        cfgForAgent,
        sessionEntry,
        resolvedSessionKey,
        requestedSessionKey,
        resolvedSessionId,
        storePath: resolvedStorePath,
        agentId,
        activeSessionAgentId,
        delivery,
        isNewSession,
        isRawModelRun,
        isOneShotModelRun,
        isRestartRecoveryResumeRun,
        suppressVisibleSessionEffects,
        images,
        imageOrder,
        media,
        inputProvenance,
        runId,
        agentDedupeKeys,
        spawnedBy: spawnedByValue,
        groupId: resolvedGroupId,
        groupChannel: resolvedGroupChannel,
        groupSpace: resolvedGroupSpace,
        bestEffortDeliver,
        lifecycleGeneration,
        effectiveBootstrapContextRunKind,
        preserveUserFacingSessionModelState,
        sessionEffects,
        skipAgentInitialSessionTouch,
        restoredCronContinuation,
        canUseInternalRuntimeHandoff,
        client: principal,
        context,
        io,
        releaseCronContinuationClaimWithRecovery,
      });
      mainRestartRecoveryOwnerLease = undefined;
    } finally {
      try {
        if (!gatewayAdmissionTransferred) {
          let pendingRecovery: Awaited<ReturnType<typeof releaseMainSessionRecoveryOwner>> =
            undefined;
          try {
            pendingRecovery = await releaseMainSessionRecoveryOwner(mainRestartRecoveryOwnerLease);
          } finally {
            try {
              releaseGatewayAdmission();
            } finally {
              try {
                await releaseCronContinuationClaimWithRecovery();
              } finally {
                scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
              }
            }
          }
        }
      } finally {
        await discardPreparedInboundMedia(preparedOffloadedRefs);
        clearUnacceptedAgentDedupe();
      }
    }
  };

  const waitForTurn = async (params: AgentWaitParams) => {
    const runId = (params.runId ?? "").trim();
    const timeoutMs =
      typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
        ? Math.max(0, Math.floor(params.timeoutMs))
        : 30_000;
    // Keep the captured entry across the wait so timeout attribution uses the
    // same owner snapshot that selected the chat-vs-agent observation source.
    const activeChatEntry = context.chatAbortControllers.get(runId);
    const hasActiveChatRun = activeChatEntry !== undefined && activeChatEntry.kind !== "agent";
    const queuedResult = () =>
      context.chatQueuedTurns.has(runId)
        ? {
            runId,
            status: "pending" as const,
            timeoutPhase: "queue" as const,
            providerStarted: false,
          }
        : undefined;
    const queuedBeforeWait = queuedResult();
    if (queuedBeforeWait) {
      return queuedBeforeWait;
    }
    const snapshot = await waitForAgentJob({
      runId,
      timeoutMs,
      ...(hasActiveChatRun ? { source: "chat" } : {}),
    });
    const queuedAfterWait = queuedResult();
    if (queuedAfterWait) {
      return queuedAfterWait;
    }
    if (!snapshot) {
      const activeRunRegistered = activeChatEntry !== undefined;
      return {
        runId,
        status: "timeout" as const,
        timeoutPhase: activeRunRegistered ? ("gateway_draining" as const) : ("queue" as const),
        ...(activeRunRegistered ? {} : { providerStarted: false }),
      };
    }
    return {
      runId,
      status: snapshot.status,
      startedAt: snapshot.startedAt,
      endedAt: snapshot.endedAt,
      error: snapshot.error,
      stopReason: snapshot.stopReason,
      livenessState: snapshot.livenessState,
      yielded: snapshot.yielded,
      pendingError: snapshot.pendingError,
      timeoutPhase: snapshot.timeoutPhase,
      providerStarted: snapshot.providerStarted,
      ...(snapshot.terminalDelivery ? { terminalDelivery: snapshot.terminalDelivery } : {}),
      terminalReceipt: snapshot.terminalReceipt,
      terminalReply: snapshot.terminalReply,
    };
  };

  const abortTurn = async (options: GatewayRequestHandlerOptions): Promise<void> => {
    await handleChatAbortRequest({ ...options, context, isWebchatConnect });
  };

  return { startTurn, waitForTurn, abortTurn };
}
