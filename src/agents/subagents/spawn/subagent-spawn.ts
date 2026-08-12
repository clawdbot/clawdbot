/**
 * Subagent spawn executor.
 *
 * Validates spawn requests, prepares child sessions, stages attachments, binds delivery context, and registers runs.
 */
import { isAcpRuntimeSpawnAvailable } from "../../../acp/runtime/availability.js";
import type { SubagentSpawnPreparation } from "../../../context-engine/types.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
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
import { runFailedLaunchRollback } from "../registry/subagent-failed-launch-rollback.js";
import {
  recordAcceptedRunTermination,
  registerSubagentRun,
  releaseSubagentRun,
  scheduleSubagentRegistrySweep,
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
import { terminateOrRetryFailedAcceptedSubagentLaunch } from "./subagent-spawn-failed-launch-retry.js";
import { callSubagentGateway, requireMatchingGatewayRunId } from "./subagent-spawn-gateway.js";
import { buildSubagentLaunchRequest } from "./subagent-spawn-launch-request.js";
import {
  createSubagentSpawnLifecycleEmitter,
  recordInitialSubagentSpawn,
} from "./subagent-spawn-lifecycle.js";
import { buildSubagentSpawnRegistration } from "./subagent-spawn-registration.js";
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

class AcceptedRunTerminationPendingError extends Error {}
class AcceptedRunTerminationSettledError extends Error {}

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
    admission: { initial: admission, reservation: admissionReservation, childDepth, maxSpawnDepth },
    childIdem,
  } = requestResolution.resolved;
  let [modelApplied, threadBindingReady, hasBoundThreadDeliveryOrigin] = [false, false, false];
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
    if (params.attachments?.length) {
      try {
        attachmentBoundary = await resolveSubagentAttachmentStagingBoundary({
          config: cfg,
          targetAgentId,
          childSessionKey,
          childSandboxed: childRuntimeSandboxed,
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
    let launchCleanupOwnerClaimed = false;
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
      // Registry ownership replaces the anonymous concurrency reservation
      // before potentially slow bridge writes begin.
      admissionReservation?.release();
      launchCleanupOwnerClaimed = true;
    };

    function buildRegistration(
      runId: string,
      launchRequest: ReturnType<typeof buildSubagentLaunchRequest>,
      queued: boolean,
      launchCleanupPending = false,
    ) {
      return buildSubagentSpawnRegistration({
        runId,
        request: params,
        launch: launchRequest,
        queued,
        launchCleanupPending,
        requesterTurnRunId: ctx.requesterTurnRunId,
        childSessionKey,
        controllerSessionKey: ownership.controllerSessionKey,
        requesterSessionKey: ownership.completionRequesterSessionKey,
        requesterOrigin,
        requesterDisplayKey: ownership.completionRequesterDisplayKey,
        task,
        taskName,
        targetAgentId,
        requesterAgentId,
        cleanup,
        label: label || undefined,
        resolvedModel,
        targetAgentDir,
        runTimeoutSeconds,
        spawnMode,
        swarmRequesterSessionKey: requesterInternalKey,
        swarmGroupId,
        swarmLaunchReplayKey,
        attachmentBoundary,
        attachmentAbsDir,
        attachmentRootDir,
        attachmentSandboxDir,
        retainAttachmentsOnKeep: retainOnSessionKeep,
        ...provisionalSessionIdentity,
      });
    }

    const cleanupFailedSpawn = (
      emitLifecycleHooks = threadBindingReady,
      priorSessionCleanup?: "deleted" | "changed",
    ) =>
      cleanupFailedSpawnBeforeAgentStart({
        childSessionKey,
        attachmentAbsDir,
        attachmentRootDir,
        attachmentSandboxFsBridge: attachmentBoundary.sandboxFsBridge,
        attachmentSandboxDir,
        emitLifecycleHooks,
        deleteTranscript: true,
        priorSessionCleanup,
        ...provisionalSessionIdentity,
      });

    const settleFailedLaunchOwner = (runId: string, error: string) => {
      try {
        return settleFailedQueuedSubagentLaunch(runId, error);
      } catch {
        return false;
      }
    };
    const materializedAttachments = await materializeSubagentAttachments({
      config: cfg,
      targetAgentId,
      workspaceDir: attachmentBoundary.workspaceDir,
      attachments: params.attachments,
      mountPathHint,
      sandboxFsBridge: attachmentBoundary.sandboxFsBridge,
      sandboxAttachmentsRootDir: attachmentBoundary.sandboxAttachmentsRootDir,
      claimCleanupOwner: applyAttachmentClaim,
    });
    if (materializedAttachments && materializedAttachments.status !== "ok") {
      if (materializedAttachments.status === "error" && materializedAttachments.ownerClaimed) {
        const ownerSettled = settleFailedLaunchOwner(childIdem, materializedAttachments.error);
        const cleanupResult = await cleanupFailedSpawn();
        if (
          ownerSettled &&
          cleanupResult.attachmentsRemoved &&
          cleanupResult.sessionCleanupComplete
        ) {
          await releaseSubagentRun(childIdem);
        } else {
          scheduleSubagentRegistrySweep({ delayMs: 0 });
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
    if (!launchCleanupOwnerClaimed) {
      registerSubagentRun(buildRegistration(childIdem, resolvedLaunchPlan, true, true));
      admissionReservation?.release();
      launchCleanupOwnerClaimed = true;
    }
    const createDispatchTerminationOwner = () => ({
      kind: "launch" as const,
      phase: "attempted" as const,
      gatewayRunId: childIdem,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      expectedSessionId: provisionalSessionIdentity.expectedSessionId,
      expectedLifecycleRevision: provisionalSessionIdentity.expectedLifecycleRevision,
    });
    let dispatchTerminationOwner: ReturnType<typeof createDispatchTerminationOwner> | undefined;
    const { childLaunch, progressOrigin } = resolvedLaunchPlan;
    let dispatchTerminationRecorded = false;
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
        dispatchTerminationOwner = createDispatchTerminationOwner();
        recordAcceptedRunTermination(childIdem, dispatchTerminationOwner);
        dispatchTerminationRecorded = true;
        const response = await launchChildRun();
        return { runId: requireMatchingGatewayRunId(response, childIdem) };
      },
      async cleanupOnFailure({ phase, state }) {
        let ownerSettled = false;
        let priorSessionCleanup: "deleted" | "changed" | undefined;
        const terminationOwner = dispatchTerminationOwner;
        const terminationAttempted =
          phase !== "initialize" && dispatchTerminationRecorded && terminationOwner !== undefined;
        if (terminationAttempted && terminationOwner) {
          ownerSettled = await terminateOrRetryFailedAcceptedSubagentLaunch({
            childSessionKey,
            cleanupOwnerRunId: childIdem,
            terminationOwner,
            contextEnginePreparation: state?.contextEnginePreparation,
            failureError: `subagent ${phase} failed`,
            onSessionCleanup: (outcome) => {
              priorSessionCleanup = outcome;
            },
          });
        } else if (launchCleanupOwnerClaimed) {
          ownerSettled = settleFailedLaunchOwner(childIdem, `subagent ${phase} failed`);
        }
        if (terminationAttempted && !ownerSettled) {
          return;
        }
        if (phase !== "initialize") {
          if ((await runFailedLaunchRollback(childIdem)) === undefined) {
            await rollbackPreparedContextEngine(state?.contextEnginePreparation);
          }
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
        const cleanupResult = await cleanupFailedSpawn(emitLifecycleHooks, priorSessionCleanup);
        const cleanupComplete =
          cleanupResult.attachmentsRemoved && cleanupResult.sessionCleanupComplete;
        if (launchCleanupOwnerClaimed && ownerSettled && cleanupComplete) {
          await releaseSubagentRun(childIdem);
        } else if (launchCleanupOwnerClaimed) {
          scheduleSubagentRegistrySweep({ delayMs: 0 });
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
      activateClaimedRegistration: (_state, runId) => {
        const terminationOwner = dispatchTerminationOwner;
        if (
          !params.collect &&
          (!terminationOwner || !startQueuedSubagentRun(childIdem, runId, terminationOwner))
        ) {
          throw new Error("provisional subagent run could not transition to running");
        }
      },
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
      activateSwarmRun({
        groupId: swarmSchedulerGroupKey,
        runId: childRunId,
        start: async () => {
          await runWithGatewayIndependentRootWorkContinuation(async () => {
            const collectorTerminationOwner = createDispatchTerminationOwner();
            recordAcceptedRunTermination(childRunId, collectorTerminationOwner);
            try {
              const response = await launchChildRun();
              const gatewayRunId = requireMatchingGatewayRunId(response, childRunId);
              if (!startQueuedSubagentRun(childRunId, gatewayRunId, collectorTerminationOwner)) {
                throw new Error(
                  "collector registry row could not transition from queued to running",
                );
              }
            } catch (error) {
              const terminated = await terminateOrRetryFailedAcceptedSubagentLaunch({
                childSessionKey,
                cleanupOwnerRunId: childRunId,
                terminationOwner: collectorTerminationOwner,
                contextEnginePreparation: pipelineResult.state.contextEnginePreparation,
                failureError: summarizeSpawnError(error),
              });
              if (!terminated) {
                throw new AcceptedRunTerminationPendingError();
              }
              throw new AcceptedRunTerminationSettledError(
                error instanceof Error ? error.message : String(error),
              );
            }
            await emitSpawnLifecycleHooks(childRunId);
          });
        },
        onStartFailure: async (error) => {
          if (error instanceof GatewayDrainingError) {
            return false;
          }
          if (error instanceof AcceptedRunTerminationPendingError) {
            return "held";
          }
          if (error instanceof AcceptedRunTerminationSettledError) {
            scheduleSubagentRegistrySweep({ delayMs: 0 });
            return true;
          }
          const launchError = summarizeSpawnError(error);
          const ownerSettled = settleFailedLaunchOwner(childRunId, launchError);
          if (!ownerSettled) {
            scheduleSubagentRegistrySweep({ delayMs: 0 });
            return "held";
          }
          // Execution authority is closed and the terminal outcome is durable.
          // Artifact cleanup remains row-owned but must not monopolize FIFO capacity.
          scheduleSubagentRegistrySweep({ delayMs: 0 });
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
