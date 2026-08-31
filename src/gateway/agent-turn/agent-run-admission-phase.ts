import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  createOperationalRunInstanceRef,
  type OperationalRunInstanceRef,
} from "../../agents/admitted-run-context.js";
import {
  clearEmbeddedAgentRunAbortabilityForRunId,
  isEmbeddedAgentRunAbortableForRunId,
  retainEmbeddedAgentRunAbortabilityForRunId,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  commitMainSessionRecovery,
  type MainSessionRecoveryPendingTarget,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { resolvePersistedOverrideModelRef } from "../../agents/model-selection.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  type PreparedModelRuntimeLease,
  type PreparedReplyDispatchRuntime,
} from "../../agents/prepared-model-runtime.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import {
  resolveExactSubagentCompletionEvent,
  type TrustedSubagentCompletionHandoff,
} from "../../agents/subagents/announce/subagent-announce-handoff.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { claimAgentRunContext } from "../../infra/agent-run-registry.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import { recordSessionParticipantBestEffort } from "../../sessions/session-participant-recording.js";
import { registerChatAbortController, resolveAgentRunExpiresAtMs } from "../chat-abort.js";
import type { ChatImageContent, OffloadedRef } from "../chat-attachments.js";
import { errorShapeFromError } from "../error-shape.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import {
  isConfirmedAcpManualSpawnTaskOwner,
  registerPluginSubagentRunFromGateway,
  resolveGatewayAgentTaskTrackingMode,
  type GatewayAgentTaskTrackingMode,
} from "../server-methods/agent-task-tracking.js";
import {
  resolveGatewayCronCreatorAuthorityAdmission,
  type GatewayCronCreatorAuthorityAdmission,
} from "../server-methods/cron-creator-authority-admission.js";
import { resolveGatewayInputParticipant } from "../session-input-participant.js";
import { loadSessionEntry, resolveSessionModelRef } from "../session-utils.js";
import { consumeSubagentCompletionToolHandoff } from "../subagent-completion-tool-handoff.js";
import { formatForLog } from "../ws-log.js";
import {
  isPreRegistrationAbortedAgentDedupeEntryForSession,
  readGatewayDedupeEntry,
  setAbortedAgentDedupeEntries,
  setGatewayDedupeEntries,
} from "./agent-dedupe.js";
import type { AgentDeliveryPhaseResult } from "./agent-delivery-phase.js";
import type { RestoredCronContinuation } from "./agent-handler-helpers.js";
import {
  prepareAgentRunUserTurn,
  releasePreparedAgentRunUserTurn,
  type PreparedAgentRunUserTurn,
} from "./agent-run-user-turn.js";
import type { AgentTurnContext, AgentTurnIo, AgentTurnPrincipal } from "./types.js";

export type PreparedAgentRunDispatch = {
  activeGatewayWorkAdmission: SessionWorkAdmissionLease;
  activeRunAbort: ReturnType<typeof registerChatAbortController>;
  cronCreatorAuthority?: GatewayCronCreatorAuthorityAdmission;
  operationalRunInstance: OperationalRunInstanceRef;
  effectiveProviderOverride?: string;
  effectiveModelOverride?: string;
  effectiveThinking?: string;
  effectiveAllowModelOverride: boolean;
  trustedInternalHandoff?: TrustedSubagentCompletionHandoff;
  restoredCronContinuationLifecycleRevision?: string;
  lifecycleStorePath: string;
  resolvedThreadId?: string | number;
  dispatchTaskTrackingMode: Exclude<GatewayAgentTaskTrackingMode, "plugin_subagent">;
  preparedModelRuntimeLease: PreparedModelRuntimeLease;
  replyDispatchRuntime: PreparedReplyDispatchRuntime;
  unpersistedOffloadedRefs: OffloadedRef[];
  userTurn: PreparedAgentRunUserTurn;
  workspaceOverride?: string;
  restoreAdmittedRestartRecoveryInterrupted?: () => Promise<
    MainSessionRecoveryPendingTarget | undefined
  >;
};

export async function prepareAgentRunDispatch(params: {
  promptedAt: number;
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  cfgForAgent?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  resolvedSessionKey?: string;
  requestedSessionKeyRaw?: string;
  requestedSessionKey?: string;
  preAcceptedReservedSessionKey?: string;
  activeSessionAgentId: string;
  delivery: AgentDeliveryPhaseResult;
  restoredCronContinuationIdentity?: Pick<
    RestoredCronContinuation,
    "lifecycleRevision" | "sessionId"
  >;
  restoredCronContinuation?: RestoredCronContinuation;
  providerOverride?: string;
  modelOverride?: string;
  allowModelOverride: boolean;
  lifecycleGeneration: string;
  getAdmittedSessionId: () => string;
  ownerConnId?: string;
  ownerDeviceId?: string;
  suppressVisibleSessionEffects: boolean;
  pendingChatRun?: { sessionKey: string; agentId?: string };
  inputProvenance?: InputProvenance;
  isOneShotModelRun: boolean;
  isRestartRecoveryResumeRun: boolean;
  canUseInternalRuntimeHandoff: boolean;
  execApprovalFollowupApprovalId?: string;
  message: string;
  effectiveTranscriptInputText: string;
  images: ChatImageContent[];
  offloadedRefs: OffloadedRef[];
  onUserTurnMediaPersisted: () => void;
  requestedPromptPersistenceSuppression: boolean;
  runId: string;
  agentDedupeKeys: readonly string[];
  context: AgentTurnContext;
  client: AgentTurnPrincipal | null;
  io: AgentTurnIo;
  abortForLifecycleRotation: (target?: { sessionKey?: string; agentId?: string }) => boolean;
  acquireGatewayWorkAdmission: (scope: string) => Promise<void>;
  assertGatewayWorkAdmissionAllowed: () => void;
  hasGatewayAdmissionOutcome: () => boolean;
  respondToGatewayAdmissionOutcome: () => boolean;
  admissionAgentId: () => string | undefined;
  getGatewayWorkAdmission: () => SessionWorkAdmissionLease | undefined;
  setAdmittedRunAbort: (value: ReturnType<typeof registerChatAbortController>) => void;
  getAdmittedRunAbort: () => ReturnType<typeof registerChatAbortController> | undefined;
  markAgentRunAccepted: (accepted: boolean) => void;
}): Promise<PreparedAgentRunDispatch | undefined> {
  const preRegistrationAbort = readGatewayDedupeEntry({
    dedupe: params.context.dedupe,
    keys: params.agentDedupeKeys,
  });
  if (
    isPreRegistrationAbortedAgentDedupeEntryForSession({
      entry: preRegistrationAbort,
      runId: params.runId,
      sessionKey: params.resolvedSessionKey,
      alternateSessionKeys: [params.preAcceptedReservedSessionKey, params.requestedSessionKey],
      agentId: params.activeSessionAgentId,
    })
  ) {
    params.markAgentRunAccepted(true);
    params.io.emitAcceptance([true, preRegistrationAbort?.payload, undefined], {
      cached: true,
      runId: params.runId,
    });
    return undefined;
  }
  if (
    params.abortForLifecycleRotation({
      sessionKey: params.resolvedSessionKey,
      agentId: params.activeSessionAgentId,
    })
  ) {
    return undefined;
  }
  if (params.restoredCronContinuationIdentity && !params.restoredCronContinuation) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "cron run continuation could not be restored"),
    ]);
    return undefined;
  }

  const timeoutMs = resolveAgentTimeoutMs({
    cfg: params.cfgForAgent ?? params.cfg,
    overrideSeconds:
      typeof params.request.timeout === "number" ? params.request.timeout : undefined,
  });
  const effectiveProviderOverride =
    params.restoredCronContinuation?.provider ?? params.providerOverride;
  const effectiveModelOverride = params.restoredCronContinuation?.model ?? params.modelOverride;
  const effectiveThinking = params.restoredCronContinuation
    ? params.restoredCronContinuation.thinking
    : params.request.thinking;
  const effectiveAllowModelOverride =
    params.allowModelOverride || params.restoredCronContinuation !== undefined;
  const runtimeConfig = params.cfgForAgent ?? params.cfg;
  const sessionModel = resolveSessionModelRef(
    runtimeConfig,
    params.sessionEntry,
    params.activeSessionAgentId,
  );
  const activeModel = effectiveModelOverride
    ? (resolvePersistedOverrideModelRef({
        defaultProvider: effectiveProviderOverride ?? sessionModel.provider,
        overrideProvider: effectiveProviderOverride,
        overrideModel: effectiveModelOverride,
      }) ?? sessionModel)
    : {
        provider: effectiveProviderOverride ?? sessionModel.provider,
        model: sessionModel.model,
      };
  const resolvedRuntime = {
    harness: resolveEffectiveAgentRuntime({
      cfg: runtimeConfig,
      provider: activeModel.provider,
      modelId: activeModel.model,
      agentId: params.activeSessionAgentId,
      sessionKey: params.resolvedSessionKey,
      sessionEntry: params.sessionEntry,
    }),
    provider: activeModel.provider,
    model: activeModel.model,
  };
  const activeModelProvider = activeModel.provider;
  const lifecycleStorePath = params.resolvedSessionKey
    ? loadSessionEntry(params.resolvedSessionKey, {
        ...(params.activeSessionAgentId ? { agentId: params.activeSessionAgentId } : {}),
        clone: false,
      }).storePath
    : `agent:${params.activeSessionAgentId}`;
  let operationalRunInstance: OperationalRunInstanceRef | undefined;
  try {
    await params.acquireGatewayWorkAdmission(lifecycleStorePath);
    params.assertGatewayWorkAdmissionAllowed();
    if (!params.hasGatewayAdmissionOutcome()) {
      operationalRunInstance = createOperationalRunInstanceRef(params.runId);
      const now = Date.now();
      params.setAdmittedRunAbort(
        registerChatAbortController({
          chatAbortControllers: params.context.chatAbortControllers,
          runId: params.runId,
          // Revalidation above may adopt a rotated session id while admission waits.
          sessionId: params.getAdmittedSessionId(),
          sessionKey: params.resolvedSessionKey,
          agentId: params.admissionAgentId(),
          timeoutMs,
          now,
          expiresAtMs: resolveAgentRunExpiresAtMs({ now, timeoutMs }),
          ownerConnId: params.ownerConnId,
          ownerDeviceId: params.ownerDeviceId,
          providerId: activeModelProvider,
          authProviderId: resolveProviderIdForAuth(activeModelProvider, {
            config: params.cfgForAgent ?? params.cfg,
          }),
          isAbortable: () => isEmbeddedAgentRunAbortableForRunId(params.runId),
          onRemoved: () => clearEmbeddedAgentRunAbortabilityForRunId(params.runId),
          controlUiVisible: !params.suppressVisibleSessionEffects,
          kind: "agent",
          lifecycleGeneration: params.lifecycleGeneration,
          operationalRunInstance,
        }),
      );
    }
  } catch (err) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)),
    ]);
    return undefined;
  }
  if (params.respondToGatewayAdmissionOutcome()) {
    return undefined;
  }
  const activeGatewayWorkAdmission = params.getGatewayWorkAdmission();
  if (!activeGatewayWorkAdmission) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "agent run admission failed"),
    ]);
    return undefined;
  }
  const activeRunAbort = params.getAdmittedRunAbort();
  if (!activeRunAbort || !operationalRunInstance) {
    activeRunAbort?.cleanup();
    activeGatewayWorkAdmission.release();
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "agent run admission failed"),
    ]);
    return undefined;
  }
  const existingRunAbort = params.context.chatAbortControllers.get(params.runId);
  if (!activeRunAbort.registered && existingRunAbort) {
    activeGatewayWorkAdmission.release();
    params.markAgentRunAccepted(existingRunAbort.kind === "agent");
    params.io.emitAcceptance(
      [true, { runId: params.runId, status: "in_flight" as const }, undefined],
      {
        cached: true,
        runId: params.runId,
      },
    );
    return undefined;
  }
  if (!activeRunAbort.registered) {
    activeGatewayWorkAdmission.release();
  } else {
    retainEmbeddedAgentRunAbortabilityForRunId(params.runId);
    if (params.pendingChatRun) {
      params.context.addChatRun(params.runId, {
        ...params.pendingChatRun,
        clientRunId: params.runId,
      });
    }
    if (params.resolvedSessionKey) {
      claimAgentRunContext(
        params.runId,
        params.suppressVisibleSessionEffects
          ? {
              isControlUiVisible: false,
              lifecycleGeneration: params.lifecycleGeneration,
              mainSessionRestartRecovery: params.isRestartRecoveryResumeRun ? true : undefined,
            }
          : {
              sessionKey: params.resolvedSessionKey,
              lifecycleGeneration: params.lifecycleGeneration,
              mainSessionRestartRecovery: params.isRestartRecoveryResumeRun ? true : undefined,
            },
      );
    }
  }

  const workspaceOverride = resolveIngressWorkspaceOverrideForSessionRun({
    spawnedBy: params.sessionEntry?.spawnedBy,
    workspaceDir: params.sessionEntry?.spawnedWorkspaceDir,
    cwd: params.sessionEntry?.spawnedCwd,
  });
  let preparedModelRuntimeLease: PreparedModelRuntimeLease | undefined;
  const cleanupPreaccept = (admissionReleased = false) => {
    preparedModelRuntimeLease?.release();
    preparedModelRuntimeLease = undefined;
    activeRunAbort.cleanup();
    if (!admissionReleased) {
      activeGatewayWorkAdmission.release();
    }
  };
  const rejectPreaccept = (error: ReturnType<typeof errorShape>) => {
    cleanupPreaccept();
    params.io.emitAcceptance([false, undefined, error]);
    return undefined;
  };
  const revalidateAdmission = () => {
    if (activeRunAbort.controller.signal.aborted) {
      setAbortedAgentDedupeEntries({
        dedupe: params.context.dedupe,
        keys: params.agentDedupeKeys,
        agentId: params.admissionAgentId(),
        runId: params.runId,
        stopReason: activeRunAbort.entry?.abortStopReason ?? "rpc",
      });
    }
    try {
      params.assertGatewayWorkAdmissionAllowed();
    } catch (err) {
      rejectPreaccept(errorShapeFromError(ErrorCodes.INVALID_REQUEST, err));
      return false;
    }
    if (!params.respondToGatewayAdmissionOutcome()) {
      return true;
    }
    cleanupPreaccept(true);
    return false;
  };
  let replyDispatchRuntime: PreparedReplyDispatchRuntime;
  try {
    const publishedRuntime = await loadPublishedGatewayReplyDispatchRuntime({
      agentId: params.activeSessionAgentId,
      abortSignal: activeRunAbort.controller.signal,
    });
    if (!revalidateAdmission()) {
      return undefined;
    }
    if (!publishedRuntime) {
      throw new Error(`published reply runtime missing for ${params.activeSessionAgentId}`);
    }
    replyDispatchRuntime = publishedRuntime;
    preparedModelRuntimeLease = await acquireAgentRunPreparedModelRuntime(
      {
        config: replyDispatchRuntime.config,
        agentId: replyDispatchRuntime.agentId,
        agentDir: replyDispatchRuntime.agentDir,
        allowGatewaySubagentBinding: true,
        workspaceDir: workspaceOverride ?? replyDispatchRuntime.workspaceDir,
        runtimePluginSelections: [
          {
            provider: resolvedRuntime.provider,
            modelId: resolvedRuntime.model,
            runtime: resolvedRuntime.harness,
          },
        ],
      },
      {
        catalogMode: "static",
        pluginGeneration: replyDispatchRuntime.pluginGeneration,
        abortSignal: activeRunAbort.controller.signal,
      },
    );
    if (!revalidateAdmission()) {
      return undefined;
    }
    replyDispatchRuntime = Object.freeze({
      ...replyDispatchRuntime,
      pluginGeneration: preparedModelRuntimeLease.pluginGeneration,
    });
  } catch (err) {
    if (!revalidateAdmission()) {
      return undefined;
    }
    return rejectPreaccept(errorShapeFromError(ErrorCodes.UNAVAILABLE, err));
  }

  const resolvedThreadId =
    params.delivery.explicitThreadId ?? params.delivery.deliveryPlan.resolvedThreadId;
  const completionEvent = resolveExactSubagentCompletionEvent({
    inputProvenance: params.inputProvenance,
    internalEvents: params.request.internalEvents,
  });
  const trustedInternalHandoff =
    params.providerOverride === undefined &&
    params.modelOverride === undefined &&
    params.restoredCronContinuation === undefined
      ? consumeSubagentCompletionToolHandoff({
          handoffId: params.client?.internal?.delegatedToolPolicyHandoffId,
          sourceSessionKey: completionEvent?.childSessionKey,
          sourceSessionId: completionEvent?.childSessionId,
          targetSessionKey: params.resolvedSessionKey,
          targetSessionId: params.getAdmittedSessionId(),
          idempotencyKey: params.request.idempotencyKey,
          provider: activeModel.provider,
          model: activeModel.model,
        })
      : undefined;
  const taskTrackingMode = resolveGatewayAgentTaskTrackingMode({
    client: params.client,
    sessionKey: params.resolvedSessionKey,
    inputProvenance: params.inputProvenance,
    confirmedAcpManualSpawn: isConfirmedAcpManualSpawnTaskOwner({
      acpTurnSource: params.request.acpTurnSource,
      sessionKey: params.resolvedSessionKey,
      client: params.client,
      logGateway: params.context.logGateway,
    }),
    modelRun: params.isOneShotModelRun,
    runId: params.runId,
  });
  const dispatchTaskTrackingMode: PreparedAgentRunDispatch["dispatchTaskTrackingMode"] =
    taskTrackingMode === "cli" ? "cli" : "none";
  if (taskTrackingMode === "plugin_subagent" && params.resolvedSessionKey) {
    try {
      await registerPluginSubagentRunFromGateway({
        cfg: params.cfg,
        runId: params.runId,
        childSessionKey: params.resolvedSessionKey,
        task: params.request.message.trim(),
        requester: params.client?.internal?.pluginSubagentRequester,
        pluginId: normalizeOptionalString(params.client?.internal?.pluginRuntimeOwnerId),
        gatewayContextResolver: params.context.resolveGatewayContext,
      });
      if (!revalidateAdmission()) {
        return undefined;
      }
    } catch (err) {
      params.context.logGateway.warn(
        `failed to register plugin subagent run ${params.runId}; rejecting untracked dispatch: ${formatForLog(err)}`,
      );
      return rejectPreaccept(
        errorShapeFromError(
          ErrorCodes.UNAVAILABLE,
          new Error("plugin subagent registry persistence failed; run was not started", {
            cause: err,
          }),
        ),
      );
    }
  }
  let restoreAdmittedRestartRecoveryInterrupted:
    | (() => Promise<MainSessionRecoveryPendingTarget | undefined>)
    | undefined;
  if (params.isRestartRecoveryResumeRun) {
    const recoverySessionKey = params.resolvedSessionKey;
    if (!recoverySessionKey) {
      return rejectPreaccept(
        errorShape(ErrorCodes.UNAVAILABLE, "restart recovery session target is unavailable"),
      );
    }
    try {
      const recoveryAdmission = await commitMainSessionRecovery({
        command: {
          kind: "admit_recovery",
          lifecycleGeneration: params.lifecycleGeneration,
          now: Date.now(),
          runId: params.runId,
          sessionId: params.request.expectedExistingSessionId ?? params.getAdmittedSessionId(),
        },
        requireWriteSuccess: true,
        target: { sessionKey: recoverySessionKey, storePath: lifecycleStorePath },
      });
      if (!revalidateAdmission()) {
        return undefined;
      }
      if (recoveryAdmission.transition.kind !== "admitted_recovery") {
        throw new Error(
          `Session "${recoverySessionKey}" restart recovery reservation is stale; recovery was skipped.`,
        );
      }
      const admittedRecoverySessionKey = recoveryAdmission.sessionKey ?? recoverySessionKey;
      let restored = false;
      restoreAdmittedRestartRecoveryInterrupted = async () => {
        if (restored) {
          return undefined;
        }
        const recovery = await commitMainSessionRecovery({
          command: {
            kind: "mark_admitted_recovery_interrupted",
            lifecycleGeneration: params.lifecycleGeneration,
            now: Date.now(),
            runId: params.runId,
            sessionId: params.request.expectedExistingSessionId ?? params.getAdmittedSessionId(),
          },
          requireWriteSuccess: true,
          target: { sessionKey: admittedRecoverySessionKey, storePath: lifecycleStorePath },
        });
        restored = true;
        const expectedSessionId =
          params.request.expectedExistingSessionId ?? params.getAdmittedSessionId();
        return recovery.transition.kind === "applied" &&
          recovery.entry?.sessionId === expectedSessionId &&
          recovery.sessionKey
          ? {
              sessionId: recovery.entry.sessionId,
              sessionKey: recovery.sessionKey,
              storePath: lifecycleStorePath,
            }
          : undefined;
      };
    } catch (err) {
      return rejectPreaccept(errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  }
  let userTurn: PreparedAgentRunUserTurn;
  try {
    userTurn = await prepareAgentRunUserTurn({
      assertCurrent: () => {
        assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
        activeRunAbort.controller.signal.throwIfAborted();
        const entry = params.context.chatAbortControllers.get(params.runId);
        if (
          !entry ||
          entry !== activeRunAbort.entry ||
          entry.operationalRunInstance !== operationalRunInstance ||
          entry.registrationCleanupRequested
        ) {
          throw new Error("agent input admission no longer owns this run");
        }
      },
      request: params.request,
      cfg: params.cfg,
      cfgForAgent: params.cfgForAgent,
      sessionEntry: params.sessionEntry,
      resolvedSessionKey: params.resolvedSessionKey,
      requestedSessionKeyRaw: params.requestedSessionKeyRaw,
      admittedSessionId: params.getAdmittedSessionId(),
      activeSessionAgentId: params.activeSessionAgentId,
      resolvedThreadId,
      suppressVisibleSessionEffects: params.suppressVisibleSessionEffects,
      requestedPromptPersistenceSuppression: params.requestedPromptPersistenceSuppression,
      restoredCronContinuation: params.restoredCronContinuation,
      canUseInternalRuntimeHandoff: params.canUseInternalRuntimeHandoff,
      execApprovalFollowupApprovalId: params.execApprovalFollowupApprovalId,
      message: params.message,
      effectiveTranscriptInputText: params.effectiveTranscriptInputText,
      images: params.images,
      offloadedRefs: params.offloadedRefs,
      inputProvenance: params.inputProvenance,
      runId: params.runId,
      client: params.client,
      context: params.context,
    });
    if (userTurn.recorder) {
      // Accepted input owns these media references before it enters the transcript.
      // Later admission rejection must preserve the files retained by that custody.
      params.onUserTurnMediaPersisted();
    }
  } catch (err) {
    return rejectPreaccept(errorShapeFromError(ErrorCodes.UNAVAILABLE, err));
  }
  if (!revalidateAdmission()) {
    releasePreparedAgentRunUserTurn(userTurn);
    return undefined;
  }
  const accepted = {
    runId: params.runId,
    sessionKey: params.resolvedSessionKey,
    agentId: params.activeSessionAgentId,
    status: "accepted" as const,
    acceptedAt: Date.now(),
    ...(taskTrackingMode === "plugin_subagent" ? { runtime: resolvedRuntime } : {}),
  };
  params.markAgentRunAccepted(true);
  setGatewayDedupeEntries({
    dedupe: params.context.dedupe,
    keys: params.agentDedupeKeys,
    entry: {
      ts: Date.now(),
      ok: true,
      payload: {
        ...accepted,
        controlUiVisible: !params.suppressVisibleSessionEffects,
        dedupeKeys: params.agentDedupeKeys,
        ownerConnId: params.ownerConnId,
        ownerDeviceId: params.ownerDeviceId,
      },
    },
  });
  params.io.emitAcceptance([true, accepted, undefined], { runId: params.runId });
  const participant = resolveGatewayInputParticipant(params.client, params.inputProvenance);
  if (
    participant &&
    params.resolvedSessionKey &&
    !params.suppressVisibleSessionEffects &&
    !userTurn.suppressPromptPersistence
  ) {
    recordSessionParticipantBestEffort({
      identity: participant,
      promptedAt: params.promptedAt,
      agentId: params.activeSessionAgentId,
      sessionKey: params.resolvedSessionKey,
      storePath: lifecycleStorePath,
      onError: (error) =>
        params.context.logGateway.warn(
          `agent participant persistence failed: ${formatForLog(error)}`,
        ),
    });
  }
  const cronCreatorAuthority = resolveGatewayCronCreatorAuthorityAdmission({
    runId: params.runId,
    resolvedSessionKey: params.resolvedSessionKey,
    spawnedBy: params.sessionEntry?.spawnedBy,
    client: params.client,
    request: params.request,
    inputProvenance: params.inputProvenance,
    hasRestoredCronContinuation: params.restoredCronContinuation !== undefined,
    isOneShotModelRun: params.isOneShotModelRun,
    isRestartRecoveryResumeRun: params.isRestartRecoveryResumeRun,
  });
  return {
    activeGatewayWorkAdmission,
    activeRunAbort,
    ...(cronCreatorAuthority ? { cronCreatorAuthority } : {}),
    operationalRunInstance,
    effectiveProviderOverride,
    effectiveModelOverride,
    effectiveThinking,
    effectiveAllowModelOverride,
    trustedInternalHandoff,
    restoredCronContinuationLifecycleRevision: params.restoredCronContinuation?.lifecycleRevision,
    lifecycleStorePath,
    resolvedThreadId,
    dispatchTaskTrackingMode,
    preparedModelRuntimeLease,
    replyDispatchRuntime,
    unpersistedOffloadedRefs: userTurn.recorder ? [] : params.offloadedRefs,
    userTurn,
    workspaceOverride,
    restoreAdmittedRestartRecoveryInterrupted,
  };
}
