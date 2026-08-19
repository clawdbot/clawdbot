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
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import {
  resolveExactSubagentCompletionEvent,
  type TrustedSubagentCompletionHandoff,
} from "../../agents/subagents/announce/subagent-announce-handoff.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { claimAgentRunContext } from "../../infra/agent-run-registry.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
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
import { loadSessionEntry, resolveSessionModelRef } from "../session-utils.js";
import { consumeSubagentCompletionToolHandoff } from "../subagent-completion-tool-handoff.js";
import { formatForLog } from "../ws-log.js";
import {
  isPreRegistrationAbortedAgentDedupeEntryForSession,
  readGatewayDedupeEntry,
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
  unpersistedOffloadedRefs: OffloadedRef[];
  userTurn: PreparedAgentRunUserTurn;
  restoreAdmittedRestartRecoveryInterrupted?: () => Promise<
    MainSessionRecoveryPendingTarget | undefined
  >;
};

export async function prepareAgentRunDispatch(params: {
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
    activeRunAbort?.cleanup({ force: true });
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
          ? { isControlUiVisible: false, lifecycleGeneration: params.lifecycleGeneration }
          : {
              sessionKey: params.resolvedSessionKey,
              lifecycleGeneration: params.lifecycleGeneration,
            },
      );
    }
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
    } catch (err) {
      params.context.logGateway.warn(
        `failed to register plugin subagent run ${params.runId}; rejecting untracked dispatch: ${formatForLog(err)}`,
      );
      activeRunAbort.cleanup({ force: true });
      activeGatewayWorkAdmission.release();
      params.io.emitAcceptance([
        false,
        undefined,
        errorShapeFromError(
          ErrorCodes.UNAVAILABLE,
          new Error("plugin subagent registry persistence failed; run was not started", {
            cause: err,
          }),
        ),
      ]);
      return undefined;
    }
  }
  let restoreAdmittedRestartRecoveryInterrupted:
    | (() => Promise<MainSessionRecoveryPendingTarget | undefined>)
    | undefined;
  if (params.isRestartRecoveryResumeRun) {
    const recoverySessionKey = params.resolvedSessionKey;
    if (!recoverySessionKey) {
      activeRunAbort.cleanup({ force: true });
      activeGatewayWorkAdmission.release();
      params.io.emitAcceptance([
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "restart recovery session target is unavailable"),
      ]);
      return undefined;
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
      activeRunAbort.cleanup({ force: true });
      activeGatewayWorkAdmission.release();
      params.io.emitAcceptance([
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      ]);
      return undefined;
    }
  }
  let userTurn: PreparedAgentRunUserTurn;
  try {
    userTurn = await prepareAgentRunUserTurn({
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
      // The recorder already persisted the media references, so later admission
      // rejection must preserve the files now owned by durable history.
      params.onUserTurnMediaPersisted();
    }
  } catch (err) {
    activeRunAbort.cleanup({ force: true });
    activeGatewayWorkAdmission.release();
    params.io.emitAcceptance([false, undefined, errorShapeFromError(ErrorCodes.UNAVAILABLE, err)]);
    return undefined;
  }
  try {
    // Transcript persistence can yield. Revalidate the exact live admission
    // before its durable turn is allowed to cross the acceptance boundary.
    params.assertGatewayWorkAdmissionAllowed();
  } catch (err) {
    releasePreparedAgentRunUserTurn(userTurn);
    activeRunAbort.cleanup({ force: true });
    activeGatewayWorkAdmission.release();
    params.io.emitAcceptance([
      false,
      undefined,
      errorShapeFromError(ErrorCodes.INVALID_REQUEST, err),
    ]);
    return undefined;
  }
  if (params.respondToGatewayAdmissionOutcome()) {
    releasePreparedAgentRunUserTurn(userTurn);
    activeRunAbort.cleanup({ force: true });
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
    unpersistedOffloadedRefs: userTurn.recorder ? [] : params.offloadedRefs,
    userTurn,
    restoreAdmittedRestartRecoveryInterrupted,
  };
}
