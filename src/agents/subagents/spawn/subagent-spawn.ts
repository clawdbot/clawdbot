/**
 * Subagent spawn executor.
 *
 * Validates spawn requests, prepares child sessions, stages attachments, binds delivery context, and registers runs.
 */
import { isAcpRuntimeSpawnAvailable } from "../../../acp/runtime/availability.js";
import type { SubagentSpawnPreparation } from "../../../context-engine/types.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../../plugins/command-registry-state.js";
import {
  GatewayDrainingError,
  runWithGatewayIndependentRootWorkContinuation,
} from "../../../process/gateway-work-admission.js";
import {
  runSpawnPipeline,
  type SpawnBackendAdapter,
  summarizeSpawnError,
} from "../../spawn-pipeline.js";
import {
  completeFailedLaunchCleanup,
  registerSubagentRun,
  releaseSubagentRun,
  settleFailedQueuedSubagentLaunch,
  startQueuedSubagentRun,
} from "../registry/subagent-registry.js";
import { activateSwarmRun, removeQueuedSwarmRun } from "../swarm/swarm-scheduler.js";
import {
  materializeSubagentAttachments,
  type SubagentAttachmentCleanupClaim,
} from "./subagent-attachments.js";
import { resolveSubagentSpawnAcceptedNote } from "./subagent-spawn-accepted-note.js";
import {
  resolveSubagentAttachmentStagingBoundary,
  sanitizeSubagentAttachmentMountPathHint,
  type SubagentAttachmentStagingBoundary,
} from "./subagent-spawn-attachment-boundary.js";
import { resolveSubagentChildPlan } from "./subagent-spawn-child-plan.js";
import {
  cleanupFailedSpawnBeforeAgentStart,
  cleanupProvisionalSession,
  retrySubagentCleanup,
  terminateAcceptedSubagentRun,
} from "./subagent-spawn-cleanup.js";
import {
  prepareContextEngineSubagentSpawn,
  prepareSubagentSessionContext,
  rollbackPreparedContextEngine,
} from "./subagent-spawn-context.js";
import type {
  SpawnSubagentContext,
  SpawnSubagentParams,
  SpawnSubagentResult,
} from "./subagent-spawn-contract.js";
import { setSubagentSpawnDepsForTest } from "./subagent-spawn-deps.js";
import { callSubagentGateway, readGatewayRunId } from "./subagent-spawn-gateway.js";
import { buildSubagentLaunchRequest } from "./subagent-spawn-launch-request.js";
import {
  createSubagentSpawnLifecycleEmitter,
  recordInitialSubagentSpawn,
} from "./subagent-spawn-lifecycle.js";
import { resolveSubagentSpawnRequest } from "./subagent-spawn-request.js";
import {
  createInitialSubagentSession,
  persistInitialChildSessionRuntimeModel,
} from "./subagent-spawn-session-patch.js";
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

export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  const task = params.task;
  const label = params.label?.trim() || "";
  const requestThreadBinding = params.thread === true;
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const requesterSessionKey = ctx.agentSessionKey;
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
    },
    childIdem,
  } = requestResolution.resolved;
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
      childSessionKey,
      childRuntimeSandboxed,
      targetAgentDir,
      modelPlan: plan,
      launchAuthorization,
      resolvedModelMetadata,
    } = childPlan.resolved;
    let { childSessionOrigin } = childPlan.resolved;
    const spawnedByKey = requesterInternalKey;
    const { resolvedModel, thinkingOverride } = plan;
    const initialSession = await createInitialSubagentSession({
      cfg,
      targetAgentId,
      childSessionKey,
      incognito,
      requesterInternalKey,
      completionOwnerSessionKey: ownership.completionRequesterSessionKey,
      spawnedWorkspaceDir,
      spawnedCwd,
      admissionPatch: admission.childSessionPatch,
      inheritedToolAllowlist: ctx.inheritedToolAllowlist,
      inheritedToolDenylist: ctx.inheritedToolDenylist,
      modelPatch: plan.initialSessionPatch,
      swarmGroupId,
      collect: params.collect === true,
      outputSchema: params.outputSchema,
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
    if (resolvedModel) {
      const runtimeModelPersistError = await persistInitialChildSessionRuntimeModel({
        cfg,
        childSessionKey,
        resolvedModel,
      });
      if (runtimeModelPersistError) {
        await cleanupCreatedSession();
        return {
          status: "error",
          error: runtimeModelPersistError,
          childSessionKey,
        };
      }
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
    const mountPathHint = sanitizeSubagentAttachmentMountPathHint(params.attachMountPath);

    let childSystemPrompt = buildSubagentSystemPrompt({
      requesterSessionKey,
      requesterOrigin: childSessionOrigin,
      childSessionKey,
      label: label || undefined,
      task,
      acpEnabled: isAcpRuntimeSpawnAvailable({
        config: cfg,
        sandboxed: childRuntimeSandboxed,
      }),
      nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance({
        surface: "subagent",
      }),
      childDepth,
      maxSpawnDepth,
    });
    if (params.outputSchema) {
      childSystemPrompt = `${childSystemPrompt}\n\nCall structured_output with {"result": <your final result>} until one payload is accepted, with at most one retry after a rejected attempt. The result value must match the requested JSON Schema. Do not call structured_output again after acceptance.`;
    }

    let retainOnSessionKeep = false;
    let attachmentsReceipt: SubagentAttachmentCleanupClaim["receipt"] | undefined;
    let attachmentAbsDir: string | undefined;
    let attachmentRootDir: string | undefined;
    let attachmentSandboxDir: string | undefined;
    let attachmentBoundary: SubagentAttachmentStagingBoundary = {
      workspaceDir: spawnedCwd ?? spawnedWorkspaceDir,
    };
    if (params.attachments?.length && childRuntimeSandboxed) {
      try {
        attachmentBoundary = await resolveSubagentAttachmentStagingBoundary({
          config: cfg,
          targetAgentId,
          childSessionKey,
          workspaceDir: attachmentBoundary.workspaceDir,
        });
      } catch (error) {
        await cleanupCreatedSession(threadBindingReady);
        return {
          status: "error",
          error: `attachments_sandbox_boundary_unavailable: ${summarizeSpawnError(error)}`,
          childSessionKey,
        };
      }
    }

    const attachmentSandboxTargetDir = attachmentBoundary.sandboxFsBridge?.resolvePath({
      filePath: attachmentBoundary.workspaceDir ?? attachmentBoundary.sandboxWorkspaceDir ?? "",
    }).containerPath;

    const deliverInitialChildRunDirectly =
      requestThreadBinding && spawnMode === "session" && hasBoundThreadDeliveryOrigin;
    const createLaunchPlan = (systemPrompt: string) =>
      buildSubagentLaunchRequest({
        childDepth,
        maxSpawnDepth,
        spawnMode,
        task,
        spawnedByKey,
        toolSpawnMetadata,
        spawnedWorkspaceDir,
        childSessionKey,
        collect: params.collect === true,
        childSessionOrigin,
        childIdem,
        deliverInitialChildRunDirectly,
        outputSchema: params.outputSchema,
        childSystemPrompt: systemPrompt,
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
    let launchPlan: ReturnType<typeof buildSubagentLaunchRequest> | undefined;
    let attachmentCleanupOwnerClaimed = false;
    const applyAttachmentClaim = (claim: SubagentAttachmentCleanupClaim) => {
      retainOnSessionKeep = claim.retainOnSessionKeep;
      attachmentsReceipt = claim.receipt;
      attachmentAbsDir = claim.absDir;
      attachmentRootDir = claim.rootDir;
      attachmentSandboxDir = claim.sandboxDir;
      childSystemPrompt = `${childSystemPrompt}\n\n${claim.systemPromptSuffix}`;
      launchPlan = createLaunchPlan(childSystemPrompt);
      const registration = buildRegistration(childIdem, launchPlan, true, true);
      registerSubagentRun(registration);
      attachmentCleanupOwnerClaimed = true;
    };

    function buildRegistration(
      runId: string,
      launchRequest: ReturnType<typeof buildSubagentLaunchRequest>,
      queued: boolean,
      launchCleanupPending = false,
    ) {
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
        progressOrigin: launchRequest.progressOrigin,
        requesterDisplayKey: ownership.completionRequesterDisplayKey,
        task,
        taskName,
        agentId: targetAgentId,
        requesterAgentId,
        cleanup,
        label: label || undefined,
        model: resolvedModel,
        agentDir: targetAgentDir,
        workspaceDir: launchRequest.spawnedMetadata.workspaceDir,
        runTimeoutSeconds,
        expectsCompletionMessage: launchRequest.shouldAnnounceCompletion,
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
        queuedLaunch: launchRequest.queuedLaunch,
        queued,
        launchCleanupPending,
        launchCleanupSessionIdentity:
          launchCleanupPending &&
          provisionalSessionIdentity.expectedSessionId &&
          provisionalSessionIdentity.expectedLifecycleRevision
            ? {
                sessionId: provisionalSessionIdentity.expectedSessionId,
                lifecycleRevision: provisionalSessionIdentity.expectedLifecycleRevision,
              }
            : undefined,
        attachmentsDir: attachmentAbsDir,
        attachmentsRootDir: attachmentRootDir,
        attachmentsSandboxSessionKey: attachmentBoundary.sandboxFsBridge
          ? childSessionKey
          : undefined,
        attachmentsSandboxAgentId: attachmentBoundary.sandboxFsBridge ? targetAgentId : undefined,
        attachmentsSandboxWorkspaceDir: attachmentBoundary.sandboxFsBridge
          ? attachmentBoundary.sandboxWorkspaceDir
          : undefined,
        attachmentsSandboxDir: attachmentBoundary.sandboxFsBridge
          ? attachmentSandboxDir
          : undefined,
        retainAttachmentsOnKeep: retainOnSessionKeep,
      };
    }

    const cleanupFailedSpawn = (
      waitForSessionDeletion?: boolean,
      emitLifecycleHooks = threadBindingReady,
    ) =>
      cleanupFailedSpawnBeforeAgentStart({
        childSessionKey,
        attachmentAbsDir,
        attachmentRootDir,
        attachmentSandboxFsBridge: attachmentBoundary.sandboxFsBridge,
        attachmentSandboxDir,
        emitLifecycleHooks,
        deleteTranscript: true,
        ...provisionalSessionIdentity,
        waitForSessionDeletion,
      });

    const materializedAttachments = await materializeSubagentAttachments({
      config: cfg,
      targetAgentId,
      workspaceDir: attachmentBoundary.workspaceDir,
      attachments: params.attachments,
      mountPathHint,
      sandboxFsBridge: attachmentBoundary.sandboxFsBridge,
      sandboxWorkspaceDir: attachmentSandboxTargetDir,
      claimCleanupOwner: applyAttachmentClaim,
    });
    if (materializedAttachments && materializedAttachments.status !== "ok") {
      if (materializedAttachments.status === "error" && materializedAttachments.ownerClaimed) {
        await retrySubagentCleanup(() =>
          settleFailedQueuedSubagentLaunch(childIdem, materializedAttachments.error),
        );
        const cleanupResult = await cleanupFailedSpawn(true);
        if (cleanupResult.attachmentsRemoved) {
          await releaseSubagentRun(childIdem);
        }
      } else {
        await cleanupCreatedSession(threadBindingReady);
      }
      return {
        status: materializedAttachments.status,
        error: materializedAttachments.error,
      };
    }
    const resolvedLaunchPlan = launchPlan ?? createLaunchPlan(childSystemPrompt);
    const { childLaunch, progressOrigin } = resolvedLaunchPlan;
    recordInitialSubagentSpawn({
      childSessionKey,
      childRunId,
      requesterSessionKey: requesterInternalKey,
      targetAgentId,
      initialSessionEntry: initialSession.entry,
    });
    const launchChildRun = async () =>
      await callSubagentGateway(
        {
          method: "agent",
          params: childLaunch.request,
          timeoutMs: childLaunch.timeoutMs,
        },
        childLaunch.authorization,
      );

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
    type SubagentBackendState = { contextEnginePreparation?: SubagentSpawnPreparation };
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
        const response = await launchChildRun();
        return { runId: readGatewayRunId(response) ?? childIdem };
      },
      async cleanupOnFailure({ phase, state, runId: acceptedRunId }) {
        if (
          phase === "register" &&
          attachmentCleanupOwnerClaimed &&
          acceptedRunId &&
          acceptedRunId !== childIdem
        ) {
          await terminateAcceptedSubagentRun({
            childSessionKey,
            gatewayRunId: acceptedRunId,
            ...provisionalSessionIdentity,
          });
        }
        if (attachmentCleanupOwnerClaimed) {
          await retrySubagentCleanup(() =>
            settleFailedQueuedSubagentLaunch(childIdem, `subagent ${phase} failed`),
          );
        }
        if (phase !== "initialize") {
          await rollbackPreparedContextEngine(state?.contextEnginePreparation);
        }
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
        const cleanupResult = await cleanupFailedSpawn(
          attachmentCleanupOwnerClaimed,
          emitLifecycleHooks,
        );
        if (attachmentCleanupOwnerClaimed && cleanupResult.attachmentsRemoved) {
          await releaseSubagentRun(childIdem);
        }
      },
    };
    const pipelineResult = await runSpawnPipeline({
      adapter,
      admissionReservation,
      progressOrigin,
      progressSessionKey: requesterInternalKey,
      buildRegistration: (_state, runId) =>
        buildRegistration(runId, resolvedLaunchPlan, params.collect === true),
      activateClaimedRegistration: attachmentCleanupOwnerClaimed
        ? (_state, runId) => {
            if (!params.collect && !startQueuedSubagentRun(childIdem, runId)) {
              throw new Error("provisional subagent run could not transition to running");
            }
          }
        : undefined,
    });
    if (!pipelineResult.ok) {
      const runId = pipelineResult.runId ?? childIdem;
      const spawnStatus =
        pipelineResult.error && typeof pipelineResult.error === "object"
          ? (pipelineResult.error as { spawnStatus?: unknown }).spawnStatus
          : undefined;
      return {
        status: spawnStatus === "forbidden" ? "forbidden" : "error",
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
      let launchTerminationConfirmed = false;
      activateSwarmRun({
        groupId: swarmSchedulerGroupKey,
        runId: childRunId,
        start: async () => {
          await runWithGatewayIndependentRootWorkContinuation(async () => {
            const response = await launchChildRun();
            const gatewayRunId = readGatewayRunId(response) ?? childRunId;
            try {
              if (!startQueuedSubagentRun(childRunId, gatewayRunId)) {
                throw new Error(
                  "collector registry row could not transition from queued to running",
                );
              }
            } catch (error) {
              await terminateAcceptedSubagentRun({
                childSessionKey,
                gatewayRunId,
                ...provisionalSessionIdentity,
              });
              launchTerminationConfirmed = true;
              throw error;
            }
            await emitSpawnLifecycleHooks(gatewayRunId);
          });
        },
        onStartFailure: async (error) => {
          if (error instanceof GatewayDrainingError) {
            return false;
          }
          const launchError = summarizeSpawnError(error);
          const [contextRollback, sessionCleanup] = await Promise.allSettled([
            rollbackPreparedContextEngine(pipelineResult.state.contextEnginePreparation),
            cleanupFailedSpawn(
              // A launch RPC can fail after acceptance. Keep the FIFO slot until
              // deleting the child session proves no accepted run remains active.
              !launchTerminationConfirmed,
            ),
          ]);
          await retrySubagentCleanup(async () => {
            settleFailedQueuedSubagentLaunch(childRunId, launchError);
            return true;
          });
          const cleanupComplete =
            contextRollback.status === "fulfilled" &&
            contextRollback.value &&
            sessionCleanup.status === "fulfilled" &&
            sessionCleanup.value.attachmentsRemoved &&
            sessionCleanup.value.sessionDeleted;
          if (cleanupComplete) {
            emitSessionLifecycleEvent({
              sessionKey: childSessionKey,
              reason: "delete",
              parentSessionKey: requesterInternalKey,
            });
            completeFailedLaunchCleanup(childRunId);
          }
          return true;
        },
      });
      swarmReservationPending = false;
      collectorSessionKey = childSessionKey;
    } else {
      await emitSpawnLifecycleHooks(childRunId);
    }

    // Emit lifecycle event so the gateway can broadcast sessions.changed to SSE subscribers.
    emitSessionLifecycleEvent({
      sessionKey: childSessionKey,
      reason: "create",
      parentSessionKey: requesterInternalKey,
      label: label || undefined,
    });

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
      attachments: attachmentsReceipt,
    };
  } finally {
    admissionReservation?.release();
    if (swarmReservationPending) {
      removeQueuedSwarmRun(childRunId);
    }
  }
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.subagentSpawnTestApi")] =
    { setDepsForTest: setSubagentSpawnDepsForTest };
}
