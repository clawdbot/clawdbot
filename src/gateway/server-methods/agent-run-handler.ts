import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { mergeSessionEntry, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import { formatForLog } from "../ws-log.js";
import { createAgentAdmissionController } from "./agent-admission-controller.js";
import { prepareAgentContentPhase } from "./agent-content-phase.js";
import { createCronContinuationController } from "./agent-cron-continuation.js";
import { createAgentDedupeLifecycle } from "./agent-dedupe-lifecycle.js";
import { resolveAgentDeliveryPhase } from "./agent-delivery-phase.js";
import type { RestoredCronContinuation } from "./agent-handler-helpers.js";
import { prepareAgentRequestPreflight } from "./agent-request-preflight.js";
import { prepareAgentRequestRouting } from "./agent-request-routing.js";
import { runAgentResetPhase } from "./agent-reset-phase.js";
import { prepareAgentRunDispatch } from "./agent-run-admission-phase.js";
import { startAgentRunExecution } from "./agent-run-execution-phase.js";
import { buildAgentSessionPatch } from "./agent-session-patch.js";
import { persistAgentSessionPhase } from "./agent-session-persist.js";
import { prepareAgentSession } from "./agent-session-prepare.js";
import type { GatewayRequestHandlers } from "./types.js";

export const agentRunHandler: GatewayRequestHandlers["agent"] = async ({
  params,
  respond,
  context,
  client,
  isWebchatConnect,
}) => {
  const preflight = prepareAgentRequestPreflight({ params, respond, context, client });
  if (!preflight) {
    return;
  }
  const {
    request,
    cfg,
    runId,
    lifecycleGeneration,
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
    preserveUserFacingSessionModelState,
    sessionEffects,
    suppressVisibleSessionEffects,
    requestedPromptPersistenceSuppression,
    isOneShotModelRun,
    isRawModelRun,
    agentDedupeKeys,
  } = preflight;
  const idem = runId;
  let resolvedGroupId: string | undefined = normalizedSpawned.groupId;
  let resolvedGroupChannel: string | undefined = normalizedSpawned.groupChannel;
  let resolvedGroupSpace: string | undefined = normalizedSpawned.groupSpace;
  let spawnedByValue: string | undefined;
  const ownerConnId = typeof client?.connId === "string" ? client.connId : undefined;
  const ownerDeviceId =
    typeof client?.connect?.device?.id === "string" ? client.connect.device.id : undefined;
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
    respond,
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
    agentId = content.agentId;
    requestedSessionKey = content.requestedSessionKey;
    let effectiveTranscriptInputText = content.effectiveTranscriptInputText;
    let message = content.message;
    const {
      images,
      imageOrder,
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
    let admittedSessionId = resolvedSessionId ?? runId;
    const admissionController = createAgentAdmissionController({
      cfg,
      runId,
      lifecycleGeneration,
      agentDedupeKeys,
      preAcceptedReservedSessionKey,
      expectedSession,
      context,
      respond,
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
      client,
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
          recipientChannel,
          pluginOwnerId:
            freshEntry === undefined
              ? normalizeOptionalString(client?.internal?.pluginRuntimeOwnerId)
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
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
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
        lifecycleGeneration,
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
      client,
      context,
      respond,
      isWebchatConnect,
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
      runId,
      agentDedupeKeys,
      context,
      client,
      respond,
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
    gatewayAdmissionTransferred = true;
    startAgentRunExecution({
      prepared: preparedDispatch,
      request,
      cfg,
      cfgForAgent,
      sessionEntry,
      resolvedSessionKey,
      requestedSessionKey,
      requestedSessionKeyRaw,
      resolvedSessionId,
      agentId,
      activeSessionAgentId,
      delivery,
      isNewSession,
      isRawModelRun,
      isOneShotModelRun,
      suppressVisibleSessionEffects,
      message,
      images,
      imageOrder,
      effectiveTranscriptInputText,
      inputProvenance,
      runId,
      idempotencyKey: idem,
      agentDedupeKeys,
      spawnedBy: spawnedByValue,
      groupId: resolvedGroupId,
      groupChannel: resolvedGroupChannel,
      groupSpace: resolvedGroupSpace,
      bestEffortDeliver,
      lifecycleGeneration,
      effectiveBootstrapContextRunKind,
      requestedPromptPersistenceSuppression,
      preserveUserFacingSessionModelState,
      sessionEffects,
      skipAgentInitialSessionTouch,
      restoredCronContinuation,
      canUseInternalRuntimeHandoff,
      execApprovalFollowupApprovalId,
      client,
      context,
      respond,
      releaseCronContinuationClaimWithRecovery,
    });
  } finally {
    if (!gatewayAdmissionTransferred) {
      releaseGatewayAdmission();
      await releaseCronContinuationClaimWithRecovery();
    }
    clearUnacceptedAgentDedupe();
  }
};
