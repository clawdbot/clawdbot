import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import { withPreparedModelRuntimePluginGenerationScope } from "../../agents/prepared-model-runtime-generation-scope.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../browser-lifecycle-cleanup.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  claimAgentRunContext,
  consumeCronNextCheckProposal,
  getAgentRunContext,
  releaseAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { createDiagnosticMessageLifecycle } from "../../logging/message-lifecycle.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { isCommandLaneTaskTimeoutError } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { removeCronRunContinuationSessionIfIdle } from "../../tasks/cron-run-continuation-cleanup.js";
import { createCronRunDiagnosticsFromError, mergeCronRunDiagnostics } from "../run-diagnostics.js";
import {
  normalizeCronRunErrorText,
  resolveCronAbortReasonText,
} from "../service/execution-errors.js";
import type {
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronStoredJob,
} from "../types.js";
import { finalizeCronRun } from "./run-finalize.js";
import { prepareCronRunContext } from "./run-prepare.js";
import { CronSessionLifecycleClaimError, type MutableCronSession } from "./run-session-state.js";
import { logWarn } from "./run.runtime.js";
import type { RunCronAgentTurnResult } from "./run.types.js";
import { cleanupCronRunSessionAfterRun } from "./session-cleanup.js";

const cronExecutorRuntimeLoader = createLazyImportLoader(() => import("./run-executor.runtime.js"));

function isCronNestedLaneTaskTimeoutError(err: unknown): boolean {
  return isCommandLaneTaskTimeoutError(err, CommandLane.CronNested);
}

/**
 * Release runtime references held by a completed isolated cron run.
 *
 * After the final durable write and delivery complete, the cron session store
 * and run context are no longer needed in memory.  This shallow disposal prevents
 * the heap-retention pattern described in #85019 where ~113k copies of the skill
 * prompt string accumulated through cron run contexts that were never released.
 *
 * O(1) — nulls known large fields without deep traversal.  MUST run after the
 * final `persistSessionEntry()` and delivery construction, never before.
 */
async function disposeCronRunContext(params: {
  sessionId: string;
  cronSession: MutableCronSession;
  ownsRunContext: boolean;
  runContextOwnerToken?: string;
}): Promise<void> {
  releaseAgentRunContext(params.sessionId, params.runContextOwnerToken);
  if (params.ownsRunContext) {
    await retireSessionMcpRuntime({
      sessionId: params.sessionId,
      reason: "isolated-cron-dispose",
      onError: (error, sid) => {
        logWarn(
          `[cron] Failed to retire MCP runtime during isolated cron dispose ${sid}: ${String(error)}`,
        );
      },
    }).catch(() => {});
  }
  (params.cronSession as { store?: unknown }).store = undefined;
}

/** Runs one isolated cron agent turn, including setup, execution, delivery, and persistence. */
export async function runCronIsolatedAgentTurn(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronStoredJob;
  message: string;
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
  onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
  onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
  onLaneWait?: (info?: { waiting?: boolean }) => void;
  sessionKey: string;
  agentId?: string;
  lane?: string;
  executionIdentity?: import("../service/state.js").CronExecutionIdentityAdmission;
}): Promise<RunCronAgentTurnResult> {
  const admittedLifecycleGeneration = getAgentEventLifecycleGeneration();
  const upstreamAbortSignal = params.abortSignal ?? params.signal;
  const lifecycleAbortController = new AbortController();
  const abortSignal = upstreamAbortSignal
    ? AbortSignal.any([upstreamAbortSignal, lifecycleAbortController.signal])
    : lifecycleAbortController.signal;
  const isAborted = () => abortSignal?.aborted ?? false;
  const abortReason = () =>
    resolveCronAbortReasonText(abortSignal?.reason) ?? "cron: job execution timed out";
  const isFastTestEnv = isFastTestRuntimeEnv();
  let prepared: Awaited<ReturnType<typeof prepareCronRunContext>>;
  try {
    prepared = await prepareCronRunContext({
      input: { ...params, abortSignal },
      isFastTestEnv,
      onLifecycleInterrupt: () => lifecycleAbortController.abort(createAgentRunRestartAbortError()),
    });
  } catch (err) {
    if (err instanceof CronSessionLifecycleClaimError) {
      return {
        status: "error",
        error: err.message,
        admissionDisposition: err.admissionDisposition,
      };
    }
    throw err;
  }
  if (!prepared.ok) {
    return { ...prepared.result, admissionDisposition: "rejected" };
  }
  const preparedRuntimeLease = prepared.context.preparedModelRuntimeLease;
  let runtimeLeaseActive = true;
  const runPrepared = async (): Promise<RunCronAgentTurnResult> => {
    // Capture the stable run id before execution can rotate its persisted session.
    const initialSessionId = prepared.context.cronSession.sessionEntry.sessionId;
    const ownsRunContext = params.job.sessionTarget === "isolated";
    let runContextOwnerToken: string | undefined;
    let runLifecycleGeneration = admittedLifecycleGeneration;
    let executionStarted = false;
    const notifyExecutionStarted = (info?: {
      lifecycleGeneration?: string;
      isFallback?: boolean;
      provider?: string;
      model?: string;
    }) => {
      executionStarted = true;
      if (info?.lifecycleGeneration) {
        runLifecycleGeneration = info.lifecycleGeneration;
      }
      params.onExecutionStarted?.({
        jobId: params.job.id,
        agentId: prepared.context.agentId,
        sessionId: prepared.context.currentRunSessionId(),
        sessionKey: prepared.context.runSessionKey,
        ...(info?.isFallback === true ? { isFallback: true } : {}),
        phase: "runner_entered",
        provider: info?.provider ?? prepared.context.liveSelection.provider,
        model: info?.model ?? prepared.context.liveSelection.model,
      });
    };
    const notifyExecutionPhase = (
      info: Pick<CronAgentExecutionPhaseUpdate, "phase"> &
        Partial<Omit<CronAgentExecutionPhaseUpdate, "jobId" | "phase">>,
    ) => {
      params.onExecutionPhase?.({
        jobId: params.job.id,
        agentId: prepared.context.agentId,
        sessionId: prepared.context.currentRunSessionId(),
        sessionKey: prepared.context.runSessionKey,
        provider: prepared.context.liveSelection.provider,
        model: prepared.context.liveSelection.model,
        ...info,
      });
    };

    const turnStartedAtMs = Date.now();
    const messageLifecycle = (() => {
      try {
        const lifecycle = createDiagnosticMessageLifecycle({
          enabled: isDiagnosticsEnabled(params.cfg),
          sessionId: prepared.context.runSessionId,
          sessionKey: prepared.context.runSessionKey,
          channel: "cron",
          source: "cron-isolated",
          startedAtMs: turnStartedAtMs,
          trackSessionState: true,
        });
        lifecycle.markProcessing();
        return lifecycle;
      } catch (error) {
        prepared.context.sessionWorkAdmission.release();
        throw error;
      }
    })();

    let outcome: "completed" | "error" = "completed";
    let outcomeError: string | undefined;
    let cronRunSessionCleanupHandled = false;
    try {
      assertAgentRunLifecycleGenerationCurrent(runLifecycleGeneration);
      const existingRunContext = getAgentRunContext(initialSessionId);
      runContextOwnerToken = claimAgentRunContext(
        initialSessionId,
        {
          sessionKey:
            ownsRunContext || !existingRunContext?.sessionKey
              ? prepared.context.runSessionKey
              : existingRunContext.sessionKey,
          sessionId: initialSessionId,
          lifecycleGeneration: runLifecycleGeneration,
          cronRunsByJobId: new Map([
            [params.job.id, { pacingEnabled: params.job.pacing !== undefined }],
          ]),
        },
        {
          trackOwner: true,
          ownsContext: ownsRunContext,
        },
      );
      const { executeCronRun } = await cronExecutorRuntimeLoader.load();
      const executionParams: Parameters<typeof executeCronRun>[0] = {
        cfg: preparedRuntimeLease.snapshot.config,
        cfgWithAgentDefaults: prepared.context.cfgWithAgentDefaults,
        job: params.job,
        agentId: prepared.context.agentId,
        agentDir: prepared.context.agentDir,
        agentSessionKey: prepared.context.agentSessionKey,
        runSessionKey: prepared.context.runSessionKey,
        usesDetachedRunSession: prepared.context.usesDetachedRunSession,
        workspaceDir: prepared.context.workspaceDir,
        lane: params.lane,
        resolvedDelivery: {
          channel: prepared.context.resolvedDelivery.channel,
          to: prepared.context.resolvedDelivery.to,
          accountId: prepared.context.resolvedDelivery.accountId,
          threadId: prepared.context.resolvedDelivery.threadId,
        },
        resolvedDeliveryOk: prepared.context.resolvedDelivery.ok,
        deliveryRequested: prepared.context.deliveryRequested,
        sourceDelivery: prepared.context.sourceDelivery,
        skillsSnapshot: prepared.context.skillsSnapshot,
        agentPayload: prepared.context.agentPayload,
        useSubagentFallbacks: prepared.context.useSubagentFallbacks,
        inheritDefaultFallbacksForAgentStringModel:
          prepared.context.inheritDefaultFallbacksForAgentStringModel,
        modelFallbacksOverride: prepared.context.modelFallbacksOverride,
        agentVerboseDefault: prepared.context.agentCfg?.verboseDefault,
        liveSelection: prepared.context.liveSelection,
        cronSession: prepared.context.cronSession,
        commandBody: prepared.context.commandBody,
        persistSessionEntry: prepared.context.persistSessionEntry,
        persistRunContinuationSession: prepared.context.runContinuationSession?.sync,
        setRunContinuationCliExecutionProvider:
          prepared.context.runContinuationSession?.setCliExecutionProvider,
        abortSignal,
        onExecutionStarted: notifyExecutionStarted,
        onExecutionPhase: notifyExecutionPhase,
        onLaneWait: params.onLaneWait,
        abortReason,
        isAborted,
        immutableThinkLevel: prepared.context.thinkingSelection.immutableThinkLevel,
        thinkingCatalog: prepared.context.thinkingSelection.catalog,
        loadThinkingCatalog: prepared.context.thinkingSelection.loadThinkingCatalog,
        timeoutMs: prepared.context.timeoutMs,
        runTimeoutOverrideMs: prepared.context.runTimeoutOverrideMs,
        suppressExecNotifyOnExit: prepared.context.suppressExecNotifyOnExit,
        pluginRegistry: prepared.context.pluginRegistry,
        executionIdentity: params.executionIdentity,
      };
      const runExecutionWithAdmission = () =>
        prepared.context.sessionWorkAdmission.run(() =>
          withAgentRunLifecycleGeneration(runLifecycleGeneration, () =>
            executeCronRun(executionParams),
          ),
        );
      const execution = await runExecutionWithAdmission();
      const finalized = await finalizeCronRun({
        prepared: prepared.context,
        execution,
        abortReason,
        isAborted,
        markCronRunSessionCleanupHandled: () => {
          cronRunSessionCleanupHandled = true;
        },
        // Self-deleting sessions must release before their own lifecycle mutation.
        // Other runs retain admission through delivery and release in finally.
        beforeSessionDelete: prepared.context.sessionWorkAdmission.release,
      });
      if (finalized.status === "error") {
        outcome = "error";
        outcomeError = finalized.error;
      }
      const delayMs = consumeCronNextCheckProposal(initialSessionId, params.job.id);
      return finalized.status !== "ok" || delayMs === undefined
        ? finalized
        : { ...finalized, nextCheck: { delayMs } };
    } catch (err) {
      consumeCronNextCheckProposal(initialSessionId, params.job.id);
      const isCronLaneTimeout = isAborted() || isCronNestedLaneTaskTimeoutError(err);
      const error = isCronLaneTimeout ? abortReason() : normalizeCronRunErrorText(err);
      outcome = "error";
      outcomeError = error;
      return prepared.context.withRunSession({
        status: "error",
        error,
        executionStarted,
        ...(!executionStarted
          ? {
              admissionDisposition:
                err instanceof CronSessionLifecycleClaimError
                  ? err.admissionDisposition
                  : ("rejected" as const),
            }
          : {}),
        // Carry the already-resolved run model into the error/timeout row so
        // Task-run history keeps provider/model attribution instead of looking like
        // an un-attributed cron timeout. finalizeCronRun does the same via
        // telemetry on the aborted path; this catch never reaches it.
        provider: prepared.context.liveSelection.provider,
        model: prepared.context.liveSelection.model,
        diagnostics: mergeCronRunDiagnostics(
          prepared.context.preflightDiagnostics,
          createCronRunDiagnosticsFromError(
            isCronLaneTimeout ? "cron-setup" : "agent-run",
            isCronLaneTimeout ? error : err,
          ),
        ),
      });
    } finally {
      try {
        await prepared.context.runContinuationSession?.seal();
      } catch (sealError) {
        logWarn(
          `[cron:${params.job.id}] Failed to seal run continuation during cleanup: ${String(sealError)}`,
        );
      }
      // Final lifecycle events use the adopted run session when the agent persisted one.
      const finalSessionRef = {
        sessionId: prepared.context.currentRunSessionId(),
        sessionKey: prepared.context.runSessionKey,
      };
      try {
        messageLifecycle.markIdle(undefined, finalSessionRef);
        messageLifecycle.markProcessed(outcome, {
          ...finalSessionRef,
          error: outcomeError,
        });
      } finally {
        try {
          if (!cronRunSessionCleanupHandled) {
            await cleanupCronRunSessionAfterRun({
              job: params.job,
              agentSessionKey: prepared.context.agentSessionKey,
              sessionId: prepared.context.currentRunSessionId(),
              lifecycleRevision: prepared.context.cronSession.lifecycleRevision,
              sessionUpdatedAt: prepared.context.cronSession.sessionEntry.updatedAt,
              beforeDelete: prepared.context.sessionWorkAdmission.release,
              reason: "cron-delete-after-run-finally",
            });
          }
        } finally {
          // Release runtime references after the run completes (success or failure).
          // The session entry has already been persisted to disk by this point,
          // so the in-memory store and run context can be safely dropped.
          try {
            if (prepared.context.runContinuationSession) {
              try {
                await removeCronRunContinuationSessionIfIdle(prepared.context.runSessionKey);
              } catch (error) {
                logWarn(
                  `[cron:${params.job.id}] Failed to remove unused run continuation: ${String(error)}`,
                );
              }
            }
            await disposeCronRunContext({
              sessionId: initialSessionId,
              cronSession: prepared.context.cronSession,
              ownsRunContext,
              runContextOwnerToken,
            });
          } finally {
            prepared.context.sessionWorkAdmission.release();
            // Only run-scoped browser identities end with this invocation.
            // Persistent cron targets keep the session and its tracked tabs alive.
            if (prepared.context.runSessionKey !== prepared.context.agentSessionKey) {
              await cleanupBrowserSessionsForLifecycleEnd({
                cfg: prepared.context.cfgWithAgentDefaults,
                sessionKeys: [prepared.context.runSessionKey],
                onWarn: (message) => logWarn(`[cron:${params.job.id}] ${message}`),
              });
            }
          }
        }
      }
    }
  };
  try {
    return await withPreparedModelRuntimePluginGenerationScope(
      preparedRuntimeLease.pluginGeneration,
      () => withPluginRuntimeGenerationScope(preparedRuntimeLease.snapshot, runPrepared),
      () => (runtimeLeaseActive ? preparedRuntimeLease.snapshot : undefined),
    );
  } finally {
    // Delivery and cleanup retain the selected generation. Close borrowing before
    // releasing either lease so callbacks retained past this run cannot reuse it.
    runtimeLeaseActive = false;
    preparedRuntimeLease.release();
    prepared.context.modelOwnerLease.release();
  }
}
