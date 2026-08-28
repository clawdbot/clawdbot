/**
 * Subagent spawn executor.
 *
 * Validates spawn requests, prepares child sessions, stages attachments, binds delivery context, and registers runs.
 */
import { isAcpRuntimeSpawnAvailable } from "../../../acp/runtime/availability.js";
import { isExecutionIdentityCollectionEnabled } from "../../../audit/audit-config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import type { SubagentSpawnPreparation } from "../../../context-engine/types.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../../plugins/command-registry-state.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import {
  recordSessionCreated,
  recordSubagentSpawned,
} from "../../../sessions/session-state-events.js";
import { parseInlineAttachmentMountPath } from "../../../shared/inline-attachments.js";
import {
  runSpawnPipeline,
  type SpawnBackendAdapter,
  summarizeSpawnError,
} from "../../spawn-pipeline.js";
import {
  deriveContinuationDelegateChildRunId,
  deriveContinuationDelegateChildSessionKey,
} from "../../subagent-continuation-ids.js";
import { registerSubagentTraceparentHandoff } from "../../subagent-traceparent-handoff.js";
import { getGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import {
  buildContinuationSessionPatch,
  persistInitialChildRuntimeState,
  type ContinuationSpawnParams,
} from "../announce/subagent-announce.runtime.js";
import {
  recordAcceptedSubagentSpawnRollback,
  rollbackSubagentRunRegistration,
} from "../registry/subagent-registry.js";
import { removeQueuedSwarmRun } from "../swarm/swarm-scheduler.js";
import { readParentExecutionIdentity } from "./execution-identity-spawn-context.js";
import {
  materializeSubagentAttachments,
  type SubagentAttachmentReceiptFile,
} from "./subagent-attachments.js";
import { resolveSubagentSpawnAcceptedNote } from "./subagent-spawn-accepted-note.js";
import { resolveSubagentChildPlan } from "./subagent-spawn-child-plan.js";
import {
  cleanupFailedSpawnBeforeAgentStart,
  cleanupProvisionalSession,
} from "./subagent-spawn-cleanup.js";
import { activateCollectorSubagentRun } from "./subagent-spawn-collector.js";
import {
  prepareContextEngineSubagentSpawn,
  prepareSubagentSessionContext,
  rollbackPreparedContextEngine,
} from "./subagent-spawn-context.js";
import type {
  SpawnSubagentContext as BaseSpawnSubagentContext,
  SpawnSubagentParams as BaseSpawnSubagentParams,
  SpawnSubagentResult as BaseSpawnSubagentResult,
} from "./subagent-spawn-contract.js";
import { isSpawnSubagentAdmissionCancelledError } from "./subagent-spawn-contract.js";
import {
  buildSubagentExecutionSessionSpawnContext,
  withSubagentGatewayExecutionIdentity,
} from "./subagent-spawn-execution-identity.js";
import { callNativeSubagentGateway, readGatewayRunId } from "./subagent-spawn-gateway.js";
import { buildSubagentLaunchRequest } from "./subagent-spawn-launch-request.js";
import { createSubagentSpawnLifecycleEmitter } from "./subagent-spawn-lifecycle.js";
import { resolveSubagentSpawnRequest } from "./subagent-spawn-request.js";
import { cleanupAcceptedSubagentSpawnFailure } from "./subagent-spawn-rollback.js";
import { createInitialSubagentSession } from "./subagent-spawn-session-patch.js";
import {
  bindThreadForSubagentSpawn,
  hasRoutableDeliveryOrigin,
} from "./subagent-spawn-thread-binding.js";
import {
  buildSubagentSystemPrompt,
  emitSessionLifecycleEvent,
  mergeDeliveryContext,
} from "./subagent-spawn.runtime.js";

export { SUBAGENT_SPAWN_CONTEXT_MODES, SUBAGENT_SPAWN_MODES } from "./subagent-spawn.types.js";

export type SpawnSubagentParams = BaseSpawnSubagentParams & ContinuationSpawnParams;
export type SpawnSubagentContext = BaseSpawnSubagentContext;
export type SpawnSubagentResult = BaseSpawnSubagentResult;

export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  const promptedAt = Date.now();
  const label = params.label?.trim() || "";
  const requestThreadBinding = params.thread === true;
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const requesterSessionKey = ctx.agentSessionKey;
  if (params.drainsContinuationDelegateQueue && !params.continuationChainState) {
    return {
      status: "error",
      error: "continuationChainState is required when drainsContinuationDelegateQueue is true",
    };
  }
  const gatewayContextResolver = getGatewayToolCallerIdentity()?.gatewayContextResolver;
  let requestedAgentId = params.agentId?.trim();
  const requestResolution = resolveSubagentSpawnRequest(params, ctx, {
    initial: requestedAgentId,
    applyDefault(agentId) {
      requestedAgentId = agentId;
      return requestedAgentId;
    },
  });
  if (!requestResolution.ok) {
    return requestResolution.result;
  }
  const {
    request: { taskName, spawnMode, cleanup, expectsCompletionMessage },
    runtime: {
      hookRunner,
      cfg,
      runTimeoutSeconds,
      contextMode,
      requesterInternalKey,
      ownership,
      requesterAgentId,
      targetAgentId,
    },
    swarm: {
      config: swarmConfig,
      groupId: swarmGroupId,
      schedulerGroupKey: swarmSchedulerGroupKey,
      launchReplayKey: swarmLaunchReplayKey,
      reservationPending,
    },
    admission: {
      resolve: resolveAdmission,
      initial: admission,
      reservation: admissionReservation,
      childDepth,
      maxSpawnDepth,
      continuationTargetSessionKeys,
      continuationRecipientAuthorityBinding,
    },
    childIdem: resolvedChildIdem,
  } = requestResolution.resolved;
  const childIdem = params.continuationDelegateFlowId
    ? deriveContinuationDelegateChildRunId(params.continuationDelegateFlowId)
    : resolvedChildIdem;
  let modelApplied = false;
  let threadBindingReady = false;
  let hasBoundThreadDeliveryOrigin = false;
  let childRunId: string = childIdem;
  let swarmReservationPending = reservationPending;
  try {
    const childPlan = await resolveSubagentChildPlan({
      request: params,
      ctx,
      cfg,
      requesterInternalKey,
      requesterAgentId,
      targetAgentId,
      sandboxMode,
      swarmEnabled: swarmConfig.enabled,
    });
    if (!childPlan.ok) {
      return childPlan.result;
    }
    const {
      spawnedCwd,
      toolSpawnMetadata,
      spawnedWorkspaceDir,
      requesterOrigin,
      incognito,
      childSessionKey: resolvedChildSessionKey,
      childRuntimeSandboxed,
      creationPolicy,
      targetAgentDir,
      modelPlan: plan,
      launchAuthorization,
      resolvedModelMetadata,
    } = childPlan.resolved;
    const childSessionKey = params.continuationDelegateFlowId
      ? deriveContinuationDelegateChildSessionKey(targetAgentId, params.continuationDelegateFlowId)
      : resolvedChildSessionKey;
    let { childSessionOrigin } = childPlan.resolved;
    const spawnedByKey = requesterInternalKey;
    const { resolvedModel, thinkingOverride } = plan;
    const initialSession = await createInitialSubagentSession({
      cfg,
      targetAgentId,
      childSessionKey,
      incognito,
      requesterInternalKey,
      creationPolicy,
      completionOwnerSessionKey: ownership.completionRequesterSessionKey,
      spawnedWorkspaceDir,
      spawnedCwd,
      sessionPermissionPolicy: ctx.sessionPermissionPolicy,
      admissionPatch: admission.childSessionPatch,
      inheritedToolAllowlist: ctx.inheritedToolAllowlist,
      inheritedToolDenylist: ctx.inheritedToolDenylist,
      modelPatch: plan.initialSessionPatch,
      swarmGroupId,
      collect: params.collect === true,
      outputSchema: params.outputSchema,
      continuationDelegateAdmission: ctx.continuationDelegateAdmission,
    });
    if (initialSession.status === "error") {
      return {
        status: "error",
        error: initialSession.error,
        childSessionKey,
      };
    }
    const provisionalSessionIdentity = {
      expectedSessionId: initialSession.entry?.sessionId,
      expectedLifecycleRevision: initialSession.entry?.lifecycleRevision,
    };
    const cleanupCreatedSession = (emitLifecycleHooks = false) =>
      cleanupProvisionalSession(childSessionKey, {
        emitLifecycleHooks,
        deleteTranscript: true,
        ...provisionalSessionIdentity,
      });
    const preparedSpawnContext = await prepareSubagentSessionContext({
      cfg,
      contextMode,
      requesterAgentId,
      targetAgentId,
      requesterInternalKey,
      childSessionKey,
    });
    if (preparedSpawnContext.status === "error") {
      await cleanupCreatedSession();
      return {
        status: "error",
        error: preparedSpawnContext.error,
        childSessionKey,
      };
    }
    const runtimeStatePersistError = await persistInitialChildRuntimeState({
      cfg,
      childSessionKey,
      resolvedModel,
      continuationPatch: buildContinuationSessionPatch(params),
    });
    if (runtimeStatePersistError) {
      await cleanupCreatedSession();
      return {
        status: "error",
        error: runtimeStatePersistError,
        childSessionKey,
      };
    }
    if (resolvedModel) {
      modelApplied = true;
    }
    if (requestThreadBinding) {
      const bindResult = await bindThreadForSubagentSpawn({
        cfg,
        childSessionKey,
        agentId: targetAgentId,
        label: label || undefined,
        mode: spawnMode,
        requesterSessionKey: ownership.threadBindingRequesterSessionKey,
        requester: {
          channel: childSessionOrigin?.channel,
          accountId: childSessionOrigin?.accountId,
          to: childSessionOrigin?.to,
          threadId: childSessionOrigin?.threadId,
        },
      });
      if (bindResult.status === "error") {
        await cleanupCreatedSession();
        return {
          status: "error",
          error: bindResult.error,
          childSessionKey,
        };
      }
      threadBindingReady = true;
      hasBoundThreadDeliveryOrigin = hasRoutableDeliveryOrigin(bindResult.deliveryOrigin);
      childSessionOrigin =
        mergeDeliveryContext(bindResult.deliveryOrigin, childSessionOrigin) ?? childSessionOrigin;
    }
    const parsedMountPath = parseInlineAttachmentMountPath(params.attachMountPath);
    const mountPathHint =
      parsedMountPath.status === "valid" ? parsedMountPath.mountPath : undefined;

    let childSystemPrompt = buildSubagentSystemPrompt({
      requesterSessionKey,
      requesterOrigin: childSessionOrigin,
      childSessionKey,
      label: label || undefined,
      task: params.task,
      acpEnabled: isAcpRuntimeSpawnAvailable({
        config: cfg,
        sandboxed: childRuntimeSandboxed,
      }),
      nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance({
        surface: "subagent",
      }),
      childDepth,
      maxSpawnDepth,
      toolNames: [
        ...(cfg.agents?.defaults?.continuation?.enabled === true ? ["continue_work"] : []),
        ...(params.drainsContinuationDelegateQueue === true &&
        childDepth < maxSpawnDepth &&
        !cfg.tools?.subagents?.tools?.deny?.includes("continue_delegate")
          ? ["continue_delegate"]
          : []),
      ],
      continuationEnabled: cfg.agents?.defaults?.continuation?.enabled === true,
    });
    if (params.outputSchema) {
      childSystemPrompt = `${childSystemPrompt}\n\nCall structured_output with {"result": <your final result>} until one payload is accepted, with at most one retry after a rejected attempt. The result value must match the requested JSON Schema. Do not call structured_output again after acceptance.`;
    }

    let retainOnSessionKeep = false;
    let attachmentsReceipt:
      | {
          count: number;
          totalBytes: number;
          files: SubagentAttachmentReceiptFile[];
          relDir: string;
        }
      | undefined;
    let attachmentAbsDir: string | undefined;
    let attachmentRootDir: string | undefined;

    const materializedAttachments = await materializeSubagentAttachments({
      config: cfg,
      targetAgentId,
      workspaceDir: spawnedCwd ?? spawnedWorkspaceDir,
      attachments: params.attachments,
      mountPathHint,
      redactContinuationErrorDetails: params.drainsContinuationDelegateQueue === true,
    });
    if (materializedAttachments && materializedAttachments.status !== "ok") {
      await cleanupCreatedSession(threadBindingReady);
      return {
        status: materializedAttachments.status,
        error: materializedAttachments.error,
      };
    }
    if (materializedAttachments?.status === "ok") {
      retainOnSessionKeep = materializedAttachments.retainOnSessionKeep;
      attachmentsReceipt = materializedAttachments.receipt;
      attachmentAbsDir = materializedAttachments.absDir;
      attachmentRootDir = materializedAttachments.rootDir;
      childSystemPrompt = `${childSystemPrompt}\n\n${materializedAttachments.systemPromptSuffix}`;
    }

    const deliverInitialChildRunDirectly =
      requestThreadBinding && spawnMode === "session" && hasBoundThreadDeliveryOrigin;
    const { childLaunch, queuedLaunch, progressOrigin, shouldAnnounceCompletion, spawnedMetadata } =
      buildSubagentLaunchRequest({
        childDepth,
        maxSpawnDepth,
        spawnMode,
        task: params.task,
        spawnedByKey,
        toolSpawnMetadata,
        spawnedWorkspaceDir,
        childSessionKey,
        collect: params.collect === true,
        childSessionOrigin,
        childIdem,
        deliverInitialChildRunDirectly,
        outputSchema: params.outputSchema,
        childSystemPrompt,
        thinkingOverride,
        runTimeoutSeconds,
        label: label || undefined,
        lightContext: params.lightContext === true,
        expectsCompletionMessage,
        requesterOrigin,
        currentMessagingTarget: ctx.currentMessagingTarget,
        currentChannelId: ctx.currentChannelId,
        currentMessageId: ctx.currentMessageId,
        launchAuthorization,
        swarmSchedulerGroupKey,
        swarmMaxConcurrent: swarmConfig.maxConcurrent,
      });
    if (params.drainsContinuationDelegateQueue) {
      childLaunch.request.drainsContinuationDelegateQueue = true;
    }
    if (params.traceparent) {
      childLaunch.request.traceparent = params.traceparent;
    }
    const launchChildRun = async () => {
      ctx.continuationDelegateAdmission?.assertCurrent("gateway-dispatch");
      registerSubagentTraceparentHandoff({
        idempotencyKey: childIdem,
        sessionKey: childSessionKey,
        traceparent: params.traceparent,
      });
      return await callNativeSubagentGateway(
        withSubagentGatewayExecutionIdentity(
          {
            method: "agent",
            params: childLaunch.request,
            timeoutMs: childLaunch.timeoutMs,
          },
          {
            sessionSpawnContext: buildSubagentExecutionSessionSpawnContext({
              enabled: isExecutionIdentityCollectionEnabled(cfg),
              backend: "subagent",
              parentAgentId: requesterAgentId,
              requesterRef: requesterInternalKey,
              controllerRef: ownership.controllerSessionKey,
              depth: childDepth,
              maxDepth: maxSpawnDepth,
              targetAgentId,
              sandbox: sandboxMode,
              inheritedToolAllowlist: ctx.inheritedToolAllowlist,
              inheritedToolDenylist: ctx.inheritedToolDenylist,
            }),
            parentExecutionIdentityToken: readParentExecutionIdentity(ctx),
          },
        ),
        childLaunch.authorization,
      );
    };

    const emitSpawnLifecycleHooks = createSubagentSpawnLifecycleEmitter({
      hookRunner,
      childSessionKey,
      requesterInternalKey,
      progressOrigin,
      targetAgentId,
      label: label || undefined,
      requesterOrigin,
      requestThreadBinding,
      spawnMode,
      resolvedModelMetadata,
    });
    const cleanupFailedSpawn = (waitForSessionDeletion?: boolean) =>
      cleanupFailedSpawnBeforeAgentStart({
        childSessionKey,
        attachmentAbsDir,
        emitLifecycleHooks: threadBindingReady,
        deleteTranscript: true,
        ...provisionalSessionIdentity,
        waitForSessionDeletion,
      });
    type SubagentBackendState = { contextEnginePreparation?: SubagentSpawnPreparation };
    // Set once the gateway accepts the child run, so a later failure can tell an
    // accepted run apart from one that never started.
    let acceptedChildRunId: string | undefined;
    let taskRowOwnership: "required" | "gateway_best_effort" = "required";
    const adapter: SpawnBackendAdapter<SubagentBackendState> = {
      async initialize() {
        const result =
          params.lightContext && preparedSpawnContext.mode === "isolated"
            ? ({ status: "ok", preparation: undefined } as const)
            : await prepareContextEngineSubagentSpawn({
                cfg,
                context: preparedSpawnContext,
                requesterInternalKey,
                childSessionKey,
                runTimeoutSeconds,
              });
        if (result.status === "error") {
          throw new Error(result.error);
        }
        return { contextEnginePreparation: result.preparation };
      },
      async dispatchTurn() {
        if (params.collect) {
          return { runId: childIdem };
        }
        const launch = await launchChildRun();
        taskRowOwnership = launch.taskRowOwnership;
        acceptedChildRunId = readGatewayRunId(launch.response) ?? childIdem;
        recordSessionParticipantBestEffort({
          promptedAt,
          identity: { type: "agent", id: requesterAgentId },
          agentId: targetAgentId,
          sessionKey: childSessionKey,
          storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: targetAgentId }),
        });
        return { runId: acceptedChildRunId };
      },
      async cleanupOnFailure({ phase, state, error }) {
        if (phase === "initialize") {
          await cleanupFailedSpawn();
          return;
        }
        // Registration claims the fallback task row. If no row survives, abort
        // the accepted Gateway run instead of leaving it executing unrecorded.
        let emitLifecycleHooks = threadBindingReady;
        if (phase === "dispatch" && threadBindingReady) {
          let endedHookEmitted = false;
          if (hookRunner?.hasHooks("subagent_ended")) {
            try {
              await hookRunner.runSubagentEnded(
                {
                  targetSessionKey: childSessionKey,
                  targetKind: "subagent",
                  reason: "spawn-failed",
                  sendFarewell: true,
                  accountId: childSessionOrigin?.accountId,
                  runId: childIdem,
                  outcome: "error",
                  error: "Session failed to start",
                },
                {
                  runId: childIdem,
                  childSessionKey,
                  requesterSessionKey: requesterInternalKey,
                },
              );
              endedHookEmitted = true;
            } catch {
              // Spawn cleanup continues even when presentation hooks fail.
            }
          }
          emitLifecycleHooks = !endedHookEmitted;
        }
        await cleanupAcceptedSubagentSpawnFailure({
          phase,
          error,
          runId: childIdem,
          childSessionKey,
          acceptedChildRunId,
          taskRowOwnership,
          contextEnginePreparation: state?.contextEnginePreparation,
          attachmentAbsDir,
          ...provisionalSessionIdentity,
          emitLifecycleHooks,
          cleanupCreatedSession,
        });
      },
    };
    const pipelineResult = await runSpawnPipeline({
      adapter,
      admissionReservation,
      progressOrigin,
      progressSessionKey: requesterInternalKey,
      buildRegistration: (_state, runId) => {
        if (params.collect) {
          const latestAdmission = resolveAdmission();
          if (!latestAdmission.ok) {
            throw Object.assign(new Error(latestAdmission.error), {
              spawnStatus: "forbidden" as const,
            });
          }
        }
        return {
          runId,
          requesterTurnRunId: ctx.requesterTurnRunId,
          childSessionKey,
          controllerSessionKey: ownership.controllerSessionKey,
          requesterSessionKey: ownership.completionRequesterSessionKey,
          requesterOrigin,
          progressOrigin,
          requesterDisplayKey: ownership.completionRequesterDisplayKey,
          task: params.task,
          taskName,
          agentId: targetAgentId,
          requesterAgentId,
          cleanup,
          label: label || undefined,
          model: resolvedModel,
          agentDir: targetAgentDir,
          workspaceDir: spawnedMetadata.workspaceDir,
          runTimeoutSeconds,
          expectsCompletionMessage: shouldAnnounceCompletion,
          spawnMode,
          collect: params.collect === true,
          swarmRequesterSessionKey: params.collect ? requesterInternalKey : undefined,
          swarmLaunchIdempotencyKey: params.collect ? childIdem : undefined,
          swarmLaunchReplayKey: params.collect ? swarmLaunchReplayKey : undefined,
          swarmLaunchRequestFingerprint: params.collect
            ? params.swarmLaunchRequestFingerprint
            : undefined,
          outputSchema: params.outputSchema,
          groupId: swarmGroupId,
          queuedLaunch,
          queued: params.collect === true,
          taskRowOwnership,
          ...(gatewayContextResolver ? { gatewayContextResolver } : {}),
          attachmentsDir: attachmentAbsDir,
          attachmentsRootDir: attachmentRootDir,
          retainAttachmentsOnKeep: retainOnSessionKeep,
          ...(params.silentAnnounce ? { silentAnnounce: true } : {}),
          ...(params.wakeOnReturn ? { wakeOnReturn: true } : {}),
          ...(params.drainsContinuationDelegateQueue
            ? { drainsContinuationDelegateQueue: true }
            : {}),
          ...(params.continuationTargetSessionKey
            ? { continuationTargetSessionKey: params.continuationTargetSessionKey }
            : {}),
          ...(continuationTargetSessionKeys?.length ? { continuationTargetSessionKeys } : {}),
          ...(params.continuationFanoutMode
            ? { continuationFanoutMode: params.continuationFanoutMode }
            : {}),
          ...(continuationRecipientAuthorityBinding
            ? { continuationRecipientAuthorityBinding }
            : {}),
          ...(params.traceparent ? { traceparent: params.traceparent } : {}),
        };
      },
      assertRegistrationAdmission: () =>
        ctx.continuationDelegateAdmission?.assertCurrent("registry-acceptance"),
      assertPostPublicationAdmission: () =>
        ctx.continuationDelegateAdmission?.assertCurrent("final-acceptance"),
      publishRegistration: () => {
        ctx.continuationDelegateAdmission?.assertCurrent("lifecycle-publication");
        if (initialSession.entry) {
          recordSessionCreated({
            sessionKey: childSessionKey,
            agentId: targetAgentId,
            entry: initialSession.entry,
          });
        }
        recordSubagentSpawned({
          childSessionKey,
          childRunId,
          requesterSessionKey: requesterInternalKey,
          agentId: targetAgentId,
        });
        emitSessionLifecycleEvent({
          sessionKey: childSessionKey,
          reason: "create",
          parentSessionKey: requesterInternalKey,
          label: label || undefined,
        });
      },
      afterRegistration: params.collect
        ? undefined
        : (_state, runId) => emitSpawnLifecycleHooks(runId),
      rollbackRegistration: rollbackSubagentRunRegistration,
      recordAcceptedRollback: (registration, error) =>
        recordAcceptedSubagentSpawnRollback({
          ...registration,
          gatewayRunId: acceptedChildRunId ?? registration.runId,
          reason: error instanceof Error ? error.message : String(error),
          expectedRegistration: registration.expectedRegistration,
          ...provisionalSessionIdentity,
        }),
    });
    if (!pipelineResult.ok) {
      const runId = pipelineResult.runId ?? childIdem;
      const spawnStatus =
        pipelineResult.error && typeof pipelineResult.error === "object"
          ? (pipelineResult.error as { spawnStatus?: unknown }).spawnStatus
          : undefined;
      return {
        status: isSpawnSubagentAdmissionCancelledError(pipelineResult.error)
          ? "cancelled"
          : spawnStatus === "forbidden"
            ? "forbidden"
            : "error",
        error:
          pipelineResult.phase === "register" && spawnStatus !== "forbidden"
            ? `Failed to register subagent run: ${summarizeSpawnError(pipelineResult.error)}`
            : summarizeSpawnError(pipelineResult.error),
        childSessionKey,
        ...(pipelineResult.phase === "initialize" ? {} : { runId }),
      };
    }
    childRunId = pipelineResult.runId;
    let collectorSessionKey: string | undefined;
    if (params.collect && swarmGroupId && swarmSchedulerGroupKey) {
      activateCollectorSubagentRun({
        swarmSchedulerGroupKey,
        childRunId,
        promptedAt,
        requesterAgentId,
        targetAgentId,
        childSessionKey,
        requesterInternalKey,
        cfg,
        provisionalSessionIdentity,
        launchChildRun,
        emitSpawnLifecycleHooks,
        rollbackPreparedContext: () =>
          rollbackPreparedContextEngine(pipelineResult.state.contextEnginePreparation),
        cleanupFailedSpawn,
        gatewayContextResolver,
      });
      swarmReservationPending = false;
      collectorSessionKey = childSessionKey;
    }

    const acceptedNote = resolveSubagentSpawnAcceptedNote({
      spawnMode,
      agentSessionKey: ctx.agentSessionKey,
    });
    return {
      status: "accepted",
      childSessionKey,
      ...(collectorSessionKey ? { sessionKey: collectorSessionKey } : {}),
      runId: childRunId,
      mode: spawnMode,
      taskName,
      note: preparedSpawnContext.forkFallbackNote
        ? `${acceptedNote} ${preparedSpawnContext.forkFallbackNote}`
        : acceptedNote,
      ...resolvedModelMetadata,
      modelApplied: resolvedModel ? modelApplied : undefined,
      rollbackAccepted: pipelineResult.rollbackAccepted,
      attachments: attachmentsReceipt,
    };
  } catch (error) {
    if (isSpawnSubagentAdmissionCancelledError(error)) {
      return { status: "cancelled", error: error.message };
    }
    throw error;
  } finally {
    admissionReservation?.release();
    if (swarmReservationPending) {
      removeQueuedSwarmRun(childRunId);
    }
  }
}
