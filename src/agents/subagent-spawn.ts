import { promises as fs } from "node:fs";
import { isAcpRuntimeSpawnAvailable } from "../acp/runtime/availability.js";
import type { SubagentSpawnPreparation } from "../context-engine/types.js";
import { listRegisteredPluginAgentPromptGuidance } from "../plugins/command-registry-state.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
import { recordSessionCreated, recordSubagentSpawned } from "../sessions/session-state-events.js";
import {
  runSpawnPipeline,
  type SpawnBackendAdapter,
  summarizeSpawnError,
} from "./spawn-pipeline.js";
import {
  materializeSubagentAttachments,
  type SubagentAttachmentReceiptFile,
} from "./subagent-attachments.js";
import { handleCollectorLaunchStartFailure } from "./subagent-collector-launch-failure.js";
import { startQueuedSubagentRun } from "./subagent-registry.js";
import { resolveSubagentSpawnAcceptedNote } from "./subagent-spawn-accepted-note.js";
import { resolveSubagentChildPlan } from "./subagent-spawn-child-plan.js";
import {
  captureProvisionalSessionCleanupIdentity as captureCleanupIdentity,
  cleanupFailedSpawnBeforeAgentStart,
  cleanupIdentityOption,
  failedSpawnCleanupIdentity,
  applyReservedCleanupState,
  refreshProvisionalSessionCleanupIdentity,
  type ProvisionalSessionDeletionOutcome,
  terminateAcceptedCollectorRun,
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
import {
  hasDurableReservedSubagentIdentity,
  recordIndeterminateFailedSubagentSpawn,
} from "./subagent-spawn-failure-quarantine.js";
import { callSubagentGateway, readGatewayRunId } from "./subagent-spawn-gateway.js";
import { buildSubagentLaunchRequest } from "./subagent-spawn-launch-request.js";
import { createSubagentSpawnLifecycleEmitter } from "./subagent-spawn-lifecycle.js";
import { sanitizeMountPathHint } from "./subagent-spawn-mount-path.js";
import { resolveSubagentSpawnRequest } from "./subagent-spawn-request.js";
import {
  claimReservedDirectSpawnInFlight,
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
import { activateSwarmRun, removeQueuedSwarmRun } from "./swarm-scheduler.js";
export { SUBAGENT_SPAWN_CONTEXT_MODES, SUBAGENT_SPAWN_MODES } from "./subagent-spawn.types.js";

export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  let releaseReservedDirectSpawnInFlight: (() => void) | undefined;
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
      slot: admissionSlot,
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
  let retainAdmissionSlotAfterReturn = false;
  const releaseAdmissionSlot = () => admissionSlot?.release();
  try {
    releaseReservedDirectSpawnInFlight = claimReservedDirectSpawnInFlight({
      preallocatedRunId: ctx.preallocatedRunId,
      preallocatedChildSessionKey: ctx.preallocatedChildSessionKey,
    });
  } catch (error) {
    releaseAdmissionSlot();
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
    if (
      ctx.preallocatedRunId &&
      hasDurableReservedSubagentIdentity({
        runId: ctx.preallocatedRunId,
        childSessionKey,
      })
    ) {
      return {
        status: "error",
        error: "reserved subagent identities already have durable registry state.",
        childSessionKey,
        runId: ctx.preallocatedRunId,
      };
    }
    let reservedFailureCleanupOutcome: ProvisionalSessionDeletionOutcome | undefined;
    let failureCleanupOutcome: ProvisionalSessionDeletionOutcome | undefined;
    const recordReservedCleanupOutcome = (outcome: ProvisionalSessionDeletionOutcome) => {
      failureCleanupOutcome = outcome;
      if (ctx.preallocatedRunId) {
        reservedFailureCleanupOutcome = outcome;
      }
    };
    const initialSession = await createInitialSubagentSession({
      cfg,
      targetAgentId,
      childSessionKey,
      requireFreshIdentity: Boolean(ctx.preallocatedChildSessionKey),
      incognito,
      requesterInternalKey,
      completionOwnerSessionKey: ownership.completionRequesterSessionKey,
      ...(ctx.pluginOwnerId ? { pluginOwnerId: ctx.pluginOwnerId } : {}),
      spawnedWorkspaceDir,
      spawnedCwd,
      admissionPatch: admission.childSessionPatch,
      inheritedToolAllowlist: ctx.inheritedToolAllowlist,
      inheritedToolDenylist: ctx.inheritedToolDenylist,
      modelPatch: plan.initialSessionPatch,
      ...(ctx.preallocatedRunId ? { reservedSubagentRunId: ctx.preallocatedRunId } : {}),
      ...(ctx.requesterSessionId
        ? { reservedSubagentRequesterSessionId: ctx.requesterSessionId }
        : {}),
      ...(ctx.reservedSubagentClaimToken
        ? { reservedSubagentClaimToken: ctx.reservedSubagentClaimToken }
        : {}),
      swarmGroupId,
      collect: params.collect === true,
      outputSchema: params.outputSchema,
    });
    if (initialSession.status === "error") {
      return { status: "error", error: initialSession.error, childSessionKey };
    }
    let provisionalSessionCleanupIdentity = captureCleanupIdentity(initialSession.entry);
    const cleanupProvisionedSessionForFailedSpawn = async (
      options?: Partial<Parameters<typeof cleanupFailedSpawnBeforeAgentStart>[0]>,
    ) => {
      const cleanupResult = await cleanupFailedSpawnBeforeAgentStart({
        childSessionKey,
        ...(options?.attachmentAbsDir ? { attachmentAbsDir: options.attachmentAbsDir } : {}),
        emitLifecycleHooks: options?.emitLifecycleHooks,
        deleteTranscript: options?.deleteTranscript,
        ...cleanupIdentityOption(provisionalSessionCleanupIdentity),
        waitForSessionDeletion: Boolean(admissionSlot),
      });
      recordReservedCleanupOutcome(cleanupResult.sessionDeletion);
      return cleanupResult;
    };
    const withReservedCleanupResult = (result: SpawnSubagentResult): SpawnSubagentResult =>
      applyReservedCleanupState(
        result,
        reservedFailureCleanupOutcome,
        provisionalSessionCleanupIdentity,
      );
    const preparedSpawnContext = await prepareSubagentSessionContext({
      cfg,
      contextMode,
      requesterAgentId,
      targetAgentId,
      requesterInternalKey,
      childSessionKey,
    });
    provisionalSessionCleanupIdentity = refreshProvisionalSessionCleanupIdentity(
      provisionalSessionCleanupIdentity,
      preparedSpawnContext.status === "ok" ? preparedSpawnContext.childEntry : undefined,
    );
    if (preparedSpawnContext.status === "error") {
      await cleanupProvisionedSessionForFailedSpawn({
        emitLifecycleHooks: false,
        deleteTranscript: true,
      });
      return withReservedCleanupResult({
        status: "error",
        error: preparedSpawnContext.error,
        childSessionKey,
      });
    }
    if (resolvedModel) {
      const runtimeModelPersistError = await persistInitialChildSessionRuntimeModel({
        cfg,
        childSessionKey,
        resolvedModel,
      });
      if (runtimeModelPersistError) {
        await cleanupProvisionedSessionForFailedSpawn({
          emitLifecycleHooks: false,
          deleteTranscript: true,
        });
        return withReservedCleanupResult({
          status: "error",
          error: runtimeModelPersistError,
          childSessionKey,
        });
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
        await cleanupProvisionedSessionForFailedSpawn({
          emitLifecycleHooks: false,
          deleteTranscript: true,
        });
        return withReservedCleanupResult({
          status: "error",
          error: bindResult.error,
          childSessionKey,
        });
      }
      threadBindingReady = true;
      hasBoundThreadDeliveryOrigin = hasRoutableDeliveryOrigin(bindResult.deliveryOrigin);
      childSessionOrigin =
        mergeDeliveryContext(bindResult.deliveryOrigin, childSessionOrigin) ?? childSessionOrigin;
    }
    const mountPathHint = sanitizeMountPathHint(params.attachMountPath);

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
    });
    if (materializedAttachments && materializedAttachments.status !== "ok") {
      await cleanupProvisionedSessionForFailedSpawn({
        emitLifecycleHooks: threadBindingReady,
        deleteTranscript: true,
      });
      return withReservedCleanupResult({
        status: materializedAttachments.status,
        error: materializedAttachments.error,
        childSessionKey,
      });
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
    const launchChildRun = async () => {
      return await callSubagentGateway(
        {
          method: "agent",
          params: childLaunch.request,
          timeoutMs: childLaunch.timeoutMs,
        },
        childLaunch.authorization,
        {
          ...(ctx.pluginOwnerId ? { pluginRuntimeOwnerId: ctx.pluginOwnerId } : {}),
          ...(ctx.reservedSubagentClaimToken
            ? { reservedSubagentClaimToken: ctx.reservedSubagentClaimToken }
            : {}),
        },
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
      async cleanupOnFailure({ phase, state }) {
        if (phase === "initialize") {
          await cleanupProvisionedSessionForFailedSpawn({
            attachmentAbsDir,
            emitLifecycleHooks: threadBindingReady,
            deleteTranscript: true,
          });
          return;
        }
        await rollbackPreparedContextEngine(state?.contextEnginePreparation);
        if (attachmentAbsDir) {
          try {
            await fs.rm(attachmentAbsDir, { recursive: true, force: true });
          } catch {
            // Best-effort cleanup only.
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
        const cleanupResult = await cleanupFailedSpawnBeforeAgentStart({
          childSessionKey,
          emitLifecycleHooks,
          deleteTranscript: true,
          ...cleanupIdentityOption(provisionalSessionCleanupIdentity),
          // A timed-out in-process dispatch keeps running. Reserved identities
          // cannot be released until deletion proves no accepted child survives.
          waitForSessionDeletion: Boolean(admissionSlot),
        });
        recordReservedCleanupOutcome(cleanupResult.sessionDeletion);
      },
    };
    const pipelineResult = await runSpawnPipeline({
      adapter,
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
          task,
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
          rejectIdentityReuse: Boolean(ctx.preallocatedRunId),
          attachmentsDir: attachmentAbsDir,
          attachmentsRootDir: attachmentRootDir,
          retainAttachmentsOnKeep: retainOnSessionKeep,
        };
      },
    });
    if (!pipelineResult.ok) {
      const runId = pipelineResult.runId ?? childIdem;
      const spawnStatus =
        pipelineResult.error && typeof pipelineResult.error === "object"
          ? (pipelineResult.error as { spawnStatus?: unknown }).spawnStatus
          : undefined;
      retainAdmissionSlotAfterReturn =
        admissionSlot !== undefined &&
        failureCleanupOutcome === "indeterminate" &&
        !recordIndeterminateFailedSubagentSpawn(admissionSlot, {
          runId,
          childSessionKey,
          ...(ownership.controllerSessionKey
            ? { controllerSessionKey: ownership.controllerSessionKey }
            : {}),
          requesterSessionKey: ownership.completionRequesterSessionKey,
          ...(requesterOrigin ? { requesterOrigin } : {}),
          ...(progressOrigin ? { progressOrigin } : {}),
          requesterDisplayKey: ownership.completionRequesterDisplayKey,
          requesterAgentId,
          task,
          ...(taskName ? { taskName } : {}),
          agentId: targetAgentId,
          cleanup,
          ...(label ? { label } : {}),
          ...(resolvedModel ? { model: resolvedModel } : {}),
          ...(targetAgentDir ? { agentDir: targetAgentDir } : {}),
          ...(spawnedMetadata.workspaceDir ? { workspaceDir: spawnedMetadata.workspaceDir } : {}),
          runTimeoutSeconds,
          spawnMode,
          reason: summarizeSpawnError(pipelineResult.error),
          ...failedSpawnCleanupIdentity(provisionalSessionCleanupIdentity),
        });
      return withReservedCleanupResult({
        status: spawnStatus === "forbidden" ? "forbidden" : "error",
        error:
          pipelineResult.phase === "register" && spawnStatus !== "forbidden"
            ? `Failed to register subagent run: ${summarizeSpawnError(pipelineResult.error)}`
            : summarizeSpawnError(pipelineResult.error),
        childSessionKey,
        ...(pipelineResult.phase === "initialize" ? {} : { runId }),
      });
    }
    childRunId = pipelineResult.runId;
    releaseAdmissionSlot();
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
              await terminateAcceptedCollectorRun({ childSessionKey, gatewayRunId });
              launchTerminationConfirmed = true;
              throw error;
            }
            await emitSpawnLifecycleHooks(gatewayRunId);
          });
        },
        onStartFailure: async (error) => {
          return await handleCollectorLaunchStartFailure({
            error,
            ...(pipelineResult.state.contextEnginePreparation
              ? { contextEnginePreparation: pipelineResult.state.contextEnginePreparation }
              : {}),
            childSessionKey,
            childRunId,
            ...(attachmentAbsDir ? { attachmentAbsDir } : {}),
            threadBindingReady,
            launchTerminationConfirmed,
            requesterInternalKey,
          });
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
    releaseReservedDirectSpawnInFlight?.();
    if (!retainAdmissionSlotAfterReturn) {
      releaseAdmissionSlot();
    }
    if (swarmReservationPending) {
      removeQueuedSwarmRun(childRunId);
    }
  }
}

const testing = {
  setDepsForTest(overrides?: Parameters<typeof setSubagentSpawnDepsForTest>[0]) {
    setSubagentSpawnDepsForTest(overrides);
  },
};
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.subagentSpawnTestApi")] =
    testing;
}
