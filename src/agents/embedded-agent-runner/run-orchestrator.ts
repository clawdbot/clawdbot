/**
 * Embedded-agent run orchestration implementation.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { getRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { revokeMessageActionTurnCapability } from "../../gateway/message-action-turn-capability.js";
import {
  captureAgentRunLifecycleGeneration,
  getAgentEventLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  buildHandledBeforeAgentReplyPayloads,
  runBeforeAgentReplyForTurn,
} from "../../plugins/before-agent-reply.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveUserPath } from "../../utils.js";
import { isMarkdownCapableMessageChannel } from "../../utils/message-channel.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
} from "../agent-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquireReadOnlyPreparedModelRuntime,
} from "../prepared-model-runtime.js";
import {
  applyAgentRunSessionTargetIdentity,
  resolveAgentRunSessionTarget,
} from "../run-session-target.js";
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
import {
  resolveSessionSuspensionTarget,
  suspendSession,
  type SessionSuspensionParams,
} from "../session-suspension.js";
import { resolveSystemPromptRepoRoot } from "../system-prompt-params.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import { runEmbeddedAgentViaCliBackendIfEligible } from "./cli-backend-dispatch.js";
import { waitForDeferredTurnMaintenanceForSession } from "./context-engine-maintenance.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { executePreparedEmbeddedRun } from "./run-execution.js";
import {
  createEmbeddedRunStageSummaryEmitter,
  createEmbeddedRunStageTracker,
} from "./run/attempt-stage-timing.js";
import { withExecutionPhaseDiagnostics } from "./run/execution-phase-diagnostics.js";
import { hasEmbeddedRunConfiguredModelFallbacks } from "./run/fallbacks.js";
import type {
  RunEmbeddedAgentInternalParams,
  RunEmbeddedAgentParamsWithSessionFile,
} from "./run/internal-params.js";
import { createEmbeddedRunLaneController } from "./run/lane-controller.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";
import { bindRunToPreparedModelRuntime } from "./run/prepared-runtime-context.js";
import { createEmbeddedRunProgressController } from "./run/progress-controller.js";
import { createRecoveryMessageActionTurnCapability } from "./run/recovery-message-action-capability.js";
import { resolveInitialEmbeddedRunModel } from "./run/runtime-resolution.js";
import { assertAgentHarnessRunAdmission, backfillSessionKey } from "./run/session-bootstrap.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const EMPTY_EMBEDDED_AGENT_CONFIG: OpenClawConfig = Object.freeze({});

export function runEmbeddedAgent(
  paramsInput: RunEmbeddedAgentParams,
): Promise<EmbeddedAgentRunResult> {
  const internalParamsInput = paramsInput as RunEmbeddedAgentInternalParams;
  const requestedProvider = normalizeOptionalString(internalParamsInput.provider);
  const requestedModel = normalizeOptionalString(internalParamsInput.model);
  const needsConfiguredDefault =
    !internalParamsInput.config && !requestedProvider && !requestedModel;
  const config =
    internalParamsInput.config ??
    (needsConfiguredDefault ? (getRuntimeConfigSnapshot() ?? undefined) : undefined);
  const lifecycleGeneration =
    internalParamsInput.lifecycleGeneration ??
    captureAgentRunLifecycleGeneration(internalParamsInput.runId);
  return withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
    runEmbeddedAgentInternal({
      ...internalParamsInput,
      config,
      lifecycleGeneration,
    }),
  );
}

async function runEmbeddedAgentInternal(
  paramsInput: RunEmbeddedAgentInternalParams,
): Promise<EmbeddedAgentRunResult> {
  const paramsBase = applyAgentRunSessionTargetIdentity(paramsInput);
  const skillWorkshopProposalMutationBudget = paramsBase.skillWorkshopProposalOnly
    ? (paramsBase.skillWorkshopProposalMutationBudget ?? { remaining: 1 })
    : undefined;
  let lifecycleGeneration = paramsBase.lifecycleGeneration!;
  const queuedLifecycleGeneration = getAgentEventLifecycleGeneration();
  // Resolve sessionKey early so all downstream consumers (hooks, LCM, compaction)
  // receive a non-null key even when callers omit it. See #60552.
  const effectiveSessionKey = backfillSessionKey({
    config: paramsBase.config,
    sessionId: paramsBase.sessionId,
    sessionKey: paramsBase.sessionKey,
    agentId: paramsBase.agentId,
  });
  assertAgentHarnessRunAdmission({ ...paramsBase, sessionKey: effectiveSessionKey });
  const runSessionTarget = await resolveAgentRunSessionTarget({
    ...paramsBase,
    sessionKey: effectiveSessionKey,
  });
  let params: RunEmbeddedAgentParamsWithSessionFile = withExecutionPhaseDiagnostics({
    ...paramsBase,
    agentId: paramsBase.agentId ?? runSessionTarget.agentId,
    sessionId: runSessionTarget.sessionId,
    sessionKey: normalizeOptionalString(effectiveSessionKey ?? runSessionTarget.sessionKey),
    sessionFile: runSessionTarget.sessionFile,
    skillWorkshopProposalMutationBudget,
  });
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  // Outer fallback attempts defer session suspension only while another
  // candidate remains. Direct and final-candidate runs suspend normally.
  const failureSuspension = resolveSessionSuspensionTarget();
  const suspendForFailure = (suspensionParams: Omit<SessionSuspensionParams, "laneId">) => {
    const suspension = { ...suspensionParams, laneId: globalLane };
    if (failureSuspension.mode === "defer") {
      failureSuspension.defer(suspension);
      return;
    }
    void suspendSession(suspension);
  };
  const laneController = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => params,
    globalLane,
    initialQueuedLifecycleGeneration: queuedLifecycleGeneration,
    sessionLane,
    setLifecycleGeneration: (generation) => {
      lifecycleGeneration = generation;
    },
    setParams: (nextParams) => {
      params = nextParams;
    },
  });
  const { enqueueGlobal, enqueueSession, noteLaneTaskProgress, throwIfAborted } = laneController;
  const channelHint = params.messageChannel ?? params.messageProvider;
  const resolvedToolResultFormat =
    params.toolResultFormat ??
    (channelHint
      ? isMarkdownCapableMessageChannel(channelHint)
        ? "markdown"
        : "plain"
      : "markdown");
  const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;
  throwIfAborted();

  const recoveryMessageActionTurnCapability = createRecoveryMessageActionTurnCapability(params);
  if (recoveryMessageActionTurnCapability) {
    // A recovered run reconstructs this capability from the exact durable
    // source claim; revocation below keeps it scoped to this run lifetime.
    params = { ...params, messageActionTurnCapability: recoveryMessageActionTurnCapability };
  }

  return enqueueSession(async () => {
    throwIfAborted();
    // Same-session reads below must see any prior deferred transcript rewrite.
    // Checkpoint before the global lane so unrelated sessions can still start
    // while this session waits on its own maintenance lane.
    params.replyOperation?.markWaitingForDeferredMaintenance();
    try {
      await waitForDeferredTurnMaintenanceForSession(params.sessionKey);
    } finally {
      params.replyOperation?.markDeferredMaintenanceWaitEnded();
    }
    throwIfAborted();
    return enqueueGlobal(async () => {
      throwIfAborted();
      // Subscription-scoped claude-cli auth executes via the CLI backend;
      // resolved post-admission so dispatched runs obey the same lifecycle,
      // placement, and concurrency gates as native embedded runs.
      const cliDispatched = await runEmbeddedAgentViaCliBackendIfEligible(params);
      if (cliDispatched) {
        return cliDispatched;
      }
      const started = Date.now();
      const startupStages = createEmbeddedRunStageTracker();
      const requestedWorkspaceResolution = resolveRunWorkspaceDir({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        config: params.config,
      });
      const config = params.config ?? EMPTY_EMBEDDED_AGENT_CONFIG;
      const requestedAgentDir =
        params.agentDir ?? resolveAgentDir(config, requestedWorkspaceResolution.agentId);
      const retainIdleRunOwner = params.config === undefined;
      const preparedInput = {
        config,
        agentId: requestedWorkspaceResolution.agentId,
        agentDir: requestedAgentDir,
        inheritedAuthDir: resolveDefaultAgentDir(config),
        workspaceDir: requestedWorkspaceResolution.workspaceDir,
        preserveWorkspaceDirOnRefresh: !requestedWorkspaceResolution.isCanonicalWorkspace,
      };
      // Configless direct hosts reuse one bounded idle generation. Gateway and explicitly
      // configured runs release dynamic workspaces so one-off paths cannot accumulate owners.
      const preparedModelRuntimeLease =
        params.preparedModelRuntimeMode === "isolated-read-only"
          ? await acquireReadOnlyPreparedModelRuntime(preparedInput)
          : await acquireAgentRunPreparedModelRuntime(preparedInput, { retainIdleRunOwner });
      const preparedModelRuntimeOwnerSnapshot = preparedModelRuntimeLease.snapshot;
      try {
        // A reload may complete while admission waits. The committed generation owns config,
        // directories, model selection, hooks, fallbacks, and every later run projection.
        const rebound = bindRunToPreparedModelRuntime({
          runParams: params,
          requestedWorkspaceResolution,
          preparedModelRuntime: preparedModelRuntimeOwnerSnapshot,
        });
        params = rebound.runParams;
        const workspaceResolution = rebound.workspaceResolution;
        const preparedModelRuntime = Object.freeze({
          ...preparedModelRuntimeOwnerSnapshot,
          repoRoot:
            resolveSystemPromptRepoRoot({
              config: rebound.runParams.config,
              workspaceDir: workspaceResolution.workspaceDir,
              cwd: rebound.runParams.cwd,
            }) ?? null,
        });
        const preparedAgentId = workspaceResolution.agentId;
        const resolvedWorkspace = workspaceResolution.workspaceDir;
        const agentDir = preparedModelRuntime.agentDir;
        const progressController = createEmbeddedRunProgressController({
          attempt: params,
          noteLaneTaskProgress,
          startedAtMs: started,
        });
        const { notifyExecutionPhase } = progressController;
        const emitStartupStageSummary = createEmbeddedRunStageSummaryEmitter({
          label: "startup stages",
          log,
          runId: params.runId,
          sessionId: params.sessionId,
          tracker: startupStages,
        });
        params.onExecutionStarted?.({ lifecycleGeneration });
        notifyExecutionPhase("runner_entered");
        const canonicalWorkspace = resolveUserPath(
          resolveAgentWorkspaceDir(preparedModelRuntime.config, preparedAgentId),
        );
        const isCanonicalWorkspace = canonicalWorkspace === resolvedWorkspace;
        const redactedSessionId = redactRunIdentifier(params.sessionId);
        const redactedSessionKey = redactRunIdentifier(params.sessionKey);
        const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
        if (requestedWorkspaceResolution.usedFallback) {
          log.warn(
            `[workspace-fallback] caller=runEmbeddedAgent reason=${requestedWorkspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${preparedAgentId} workspace=${redactedWorkspace}`,
          );
        }
        startupStages.mark("workspace");
        notifyExecutionPhase("workspace");
        ensureRuntimePluginsLoaded({
          config: preparedModelRuntime.config,
          workspaceDir: resolvedWorkspace,
          ...(params.allowGatewaySubagentBinding !== undefined
            ? { allowGatewaySubagentBinding: params.allowGatewaySubagentBinding }
            : {}),
        });
        startupStages.mark("runtime-plugins");
        notifyExecutionPhase("runtime_plugins");

        const { provider, modelId } = resolveInitialEmbeddedRunModel({
          config: params.config,
          agentId: workspaceResolution.agentId,
          provider: params.provider,
          model: params.model,
        });
        const normalizedSessionKey = params.sessionKey?.trim();
        const fallbackConfigured = hasEmbeddedRunConfiguredModelFallbacks({
          cfg: params.config,
          agentId: params.agentId,
          sessionKey: normalizedSessionKey,
          modelFallbacksOverride: params.modelFallbacksOverride,
        });
        const resolvedSessionKey =
          normalizedSessionKey ?? params.sessionTarget?.sessionKey ?? params.sessionId;
        const hookRunner = getGlobalHookRunner();
        const hookCtx = {
          runId: params.runId,
          jobId: params.jobId,
          agentId: workspaceResolution.agentId,
          sessionKey: resolvedSessionKey,
          sessionId: params.sessionId,
          workspaceDir: resolvedWorkspace,
          modelProviderId: provider,
          modelId,
          trigger: params.trigger,
          ...buildAgentHookContextChannelFields(params),
          ...buildAgentHookContextIdentityFields({
            trigger: params.trigger,
            senderId: params.senderId,
            chatId: params.chatId,
            channelContext: params.channelContext,
          }),
        };
        const hookResult = await runBeforeAgentReplyForTurn({
          runId: params.runId,
          trigger: params.trigger,
          event: { cleanedBody: params.prompt },
          context: hookCtx,
          onDispatch: () =>
            notifyExecutionPhase("before_agent_reply", { provider, model: modelId }),
          onDeclined: () => notifyExecutionPhase("runtime_plugins", { provider, model: modelId }),
        });
        if (hookResult?.handled) {
          return {
            payloads: buildHandledBeforeAgentReplyPayloads(hookResult.reply),
            meta: {
              durationMs: Date.now() - started,
              agentMeta: {
                sessionId: params.sessionId,
                provider,
                model: modelId,
              },
              finalAssistantVisibleText: hookResult.reply?.text ?? SILENT_REPLY_TOKEN,
              finalAssistantRawText: hookResult.reply?.text ?? SILENT_REPLY_TOKEN,
            },
          };
        }

        return await executePreparedEmbeddedRun({
          runParams: params,
          provider,
          modelId,
          agentDir,
          workspaceResolution,
          workspaceDir: resolvedWorkspace,
          isCanonicalWorkspace,
          globalLane,
          hookRunner,
          hookContext: hookCtx,
          fallbackConfigured,
          isProbeSession,
          resolvedSessionKey,
          resolvedToolResultFormat,
          startedAtMs: started,
          startupStages,
          emitStartupStageSummary,
          progressController,
          laneController,
          lifecycleGeneration,
          suspendForFailure,
          preparedModelRuntime,
        });
      } finally {
        preparedModelRuntimeLease.release();
      }
    });
  }).finally(() => {
    revokeMessageActionTurnCapability(recoveryMessageActionTurnCapability);
  });
}
