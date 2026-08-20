/**
 * Subagent spawn executor.
 *
 * Validates spawn requests, prepares child sessions, stages attachments, binds delivery context, and registers runs.
 */
import { promises as fs } from "node:fs";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isAcpRuntimeSpawnAvailable } from "../../../acp/runtime/availability.js";
import { isExecutionIdentityCollectionEnabled } from "../../../audit/audit-config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import type { SubagentSpawnPreparation } from "../../../context-engine/types.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../../plugins/command-registry-state.js";
import {
  GatewayDrainingError,
  runWithGatewayIndependentRootWorkContinuation,
} from "../../../process/gateway-work-admission.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import {
  recordSessionCreated,
  recordSubagentSpawned,
} from "../../../sessions/session-state-events.js";
import {
  runSpawnPipeline,
  type SpawnBackendAdapter,
  summarizeSpawnError,
} from "../../spawn-pipeline.js";
import { getGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import {
  completeCollectorLaunchCleanup,
  settleFailedQueuedSubagentLaunch,
  startQueuedSubagentRun,
} from "../registry/subagent-registry.js";
import { activateSwarmRun, removeQueuedSwarmRun } from "../swarm/swarm-scheduler.js";
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
  retrySubagentCleanup,
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
  buildSubagentExecutionSessionSpawnContext,
  withSubagentGatewayExecutionIdentity,
} from "./subagent-spawn-execution-identity.js";
import { callNativeSubagentGateway, readGatewayRunId } from "./subagent-spawn-gateway.js";
import { buildSubagentLaunchRequest } from "./subagent-spawn-launch-request.js";
import { createSubagentSpawnLifecycleEmitter } from "./subagent-spawn-lifecycle.js";
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

function sanitizeMountPathHint(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (hasPromptUnsafeControlCharacter(trimmed)) {
    return undefined;
  }
  if (!/^[A-Za-z0-9._\-/:]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function hasPromptUnsafeControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  const task = params.task;
  const label = params.label?.trim() || "";
  const requestThreadBinding = params.thread === true;
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const requesterSessionKey = ctx.agentSessionKey;
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
      requesterAgentId,
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
    const launchChildRun = async () =>
      await callNativeSubagentGateway(
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
          actor: { type: "agent", id: requesterAgentId },
          agentId: targetAgentId,
          sessionKey: childSessionKey,
          source: "agent",
          storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: targetAgentId }),
        });
        return { runId: acceptedChildRunId };
      },
      async cleanupOnFailure({ phase, state }) {
        if (phase === "initialize") {
          await cleanupFailedSpawn();
          return;
        }
        // The gateway skips its fallback CLI task row because this launch claims
        // the run's row, and registration is what delivers it. A register failure
        // means no owner ever recorded the run, so abort the run the gateway
        // already accepted instead of leaving it executing unrecorded.
        if (phase === "register" && acceptedChildRunId && taskRowOwnership === "required") {
          await terminateAcceptedCollectorRun({
            childSessionKey,
            gatewayRunId: acceptedChildRunId,
            ...provisionalSessionIdentity,
          });
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
        await cleanupCreatedSession(emitLifecycleHooks);
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
          taskRowOwnership,
          ...(gatewayContextResolver ? { gatewayContextResolver } : {}),
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
            const launch = await launchChildRun();
            // Queued registration already owns the task row before either dispatch route starts.
            // Out-of-process Gateway tracking finds that exact runId and suppresses its CLI row.
            const gatewayRunId = readGatewayRunId(launch.response) ?? childRunId;
            recordSessionParticipantBestEffort({
              actor: { type: "agent", id: requesterAgentId },
              agentId: targetAgentId,
              sessionKey: childSessionKey,
              source: "agent",
              storePath: resolveSessionStorePathCore(cfg.session?.store, {
                agentId: targetAgentId,
              }),
            });
            try {
              const started = gatewayContextResolver
                ? startQueuedSubagentRun(
                    childRunId,
                    gatewayRunId,
                    undefined,
                    gatewayContextResolver,
                  )
                : startQueuedSubagentRun(childRunId, gatewayRunId);
              if (!started) {
                throw new Error(
                  "collector registry row could not transition from queued to running",
                );
              }
            } catch (error) {
              await terminateAcceptedCollectorRun({
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
            completeCollectorLaunchCleanup(childRunId);
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

const testing = {
  setDepsForTest(overrides?: Parameters<typeof setSubagentSpawnDepsForTest>[0]) {
    setSubagentSpawnDepsForTest(overrides);
  },
};
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.subagentSpawnTestApi")] =
    testing;
}
