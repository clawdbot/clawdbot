/** Final persistence, telemetry, and delivery for an isolated cron run. */
import {
  asNonNegativeFiniteNumber,
  asPositiveFiniteNumber as resolvePositiveContextTokens,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasAcceptedSessionSpawn } from "../../agents/accepted-session-spawn.js";
import { resolveAuthoredModelContextTokens } from "../../agents/context-resolution.js";
import { hasCommittedMessagingToolDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { hasIntentionalTerminalCompletion } from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
import {
  CODE_MODE_MCP_CATALOG_MISS_MESSAGE,
  isEmbeddedRunTerminalToolFailure,
} from "../../agents/embedded-agent-runner/terminal-tool-failure.js";
import { deriveContextPromptTokens } from "../../agents/usage.js";
import { isSilentReplyPayloadText } from "../../auto-reply/tokens.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions.js";
import {
  resolveProjectedSessionContextTokens,
  resolveTrustedSessionContextTokens,
} from "../../config/sessions/context-token-provenance.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { resolveSourceDeliveryOutcome } from "../../infra/outbound/source-delivery-plan.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  createCronRunDiagnosticsFromAgentResult,
  createCronRunDiagnosticsFromError,
  mergeCronRunDiagnostics,
} from "../run-diagnostics.js";
import type { CronDeliveryTrace, CronRunTelemetry } from "../types.js";
import { resolveCronChannelOutputPolicy } from "./channel-output-policy.js";
import { resolveCronPayloadOutcome } from "./helpers.js";
import { buildCronDeliveryTrace, loadCronDeliveryRuntime } from "./run-delivery-trace.js";
import type { PreparedCronRunContext } from "./run-prepare.js";
import {
  adoptCronRunSessionMetadata,
  setCronSessionAgentHarnessId,
  setCronSessionRuntimeModel,
} from "./run-session-state.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  deriveSessionTotalTokens,
  hasNonzeroUsage,
  isCliProvider,
} from "./run.runtime.js";
import type { RunCronAgentTurnResult } from "./run.types.js";
import { cleanupCronRunSessionAfterRun } from "./session-cleanup.js";

type CronExecutionRuntime = typeof import("./run-executor.runtime.js");
type CronExecutionResult = Awaited<ReturnType<CronExecutionRuntime["executeCronRun"]>>;

const cronContextRuntimeLoader = createLazyImportLoader(() => import("./run-context.runtime.js"));

export async function finalizeCronRun(params: {
  prepared: PreparedCronRunContext;
  execution: CronExecutionResult;
  abortReason: () => string;
  isAborted: () => boolean;
  markCronRunSessionCleanupAttempted: () => void;
  beforeSessionDelete: () => void;
}): Promise<RunCronAgentTurnResult> {
  const { prepared, execution } = params;
  const finalRunResult = execution.runResult;
  const payloads = finalRunResult.payloads ?? [];
  let telemetry: CronRunTelemetry | undefined;
  const cleanupRunSession = async (reason: string) => {
    await cleanupCronRunSessionAfterRun({
      job: prepared.input.job,
      agentSessionKey: prepared.agentSessionKey,
      sessionId: prepared.currentRunSessionId(),
      lifecycleRevision: prepared.cronSession.lifecycleRevision,
      sessionUpdatedAt: prepared.cronSession.sessionEntry.updatedAt,
      beforeDelete: params.beforeSessionDelete,
      reason,
    });
    params.markCronRunSessionCleanupAttempted();
  };

  // Late aborted results may still contain billable usage. Recheck before each
  // metadata mutation because lazy runtime loads below can yield to the timeout.
  if (!params.isAborted()) {
    if (finalRunResult.meta?.systemPromptReport) {
      prepared.cronSession.sessionEntry.systemPromptReport = finalRunResult.meta.systemPromptReport;
    }
    adoptCronRunSessionMetadata({
      entry: prepared.cronSession.sessionEntry,
      sessionKey: prepared.agentSessionKey,
      runMeta: finalRunResult.meta?.agentMeta,
    });
  }
  const usage = finalRunResult.meta?.agentMeta?.usage;
  const diagnosticUsage = finalRunResult.meta?.agentMeta?.diagnosticUsage ?? usage;
  const lastCallUsage = finalRunResult.meta?.agentMeta?.lastCallUsage;
  const promptTokens = finalRunResult.meta?.agentMeta?.promptTokens;
  const modelUsed =
    finalRunResult.meta?.agentMeta?.model ??
    execution.fallbackModel ??
    execution.liveSelection.model;
  const providerUsed =
    finalRunResult.meta?.agentMeta?.provider ??
    execution.fallbackProvider ??
    execution.liveSelection.provider;
  const runtimeContextTokens = resolvePositiveContextTokens(
    finalRunResult.meta?.agentMeta?.contextTokens,
  );
  const modelContextTokens = (await cronContextRuntimeLoader.load()).resolveContextTokensForModel({
    cfg: prepared.cfgWithAgentDefaults,
    provider: providerUsed,
    model: modelUsed,
    allowAsyncLoad: false,
  });
  const agentHarnessId = normalizeOptionalString(finalRunResult.meta?.agentMeta?.agentHarnessId);
  const authoredContextTokens = resolveAuthoredModelContextTokens({
    cfg: prepared.cfgWithAgentDefaults,
    provider: providerUsed,
    model: modelUsed,
  });
  const retainedRuntimeContextTokens = resolveTrustedSessionContextTokens({
    entry: prepared.cronSession.sessionEntry,
    provider: providerUsed,
    model: modelUsed,
    agentHarnessId,
  });
  const projectedContextTokens = resolveProjectedSessionContextTokens({
    entry: prepared.cronSession.sessionEntry,
    provider: providerUsed,
    model: modelUsed,
    agentHarnessId,
    resolvedContextTokens: modelContextTokens,
    authoredContextTokens,
  });
  const contextTokens = runtimeContextTokens ?? projectedContextTokens ?? DEFAULT_CONTEXT_TOKENS;
  // Preserve persisted provenance only when the projector selected that owner;
  // a current/authored clamp stays resolved so removed caps cannot stick.
  const projectedUsesPersistedContext =
    retainedRuntimeContextTokens !== undefined &&
    (prepared.cronSession.sessionEntry.modelSelectionLocked === true ||
      (authoredContextTokens === undefined &&
        projectedContextTokens === retainedRuntimeContextTokens));
  const contextTokensSource =
    runtimeContextTokens !== undefined
      ? (finalRunResult.meta?.agentMeta?.contextTokensSource ?? "resolved")
      : projectedUsesPersistedContext
        ? prepared.cronSession.sessionEntry.contextTokensSource
        : "resolved";

  if (!params.isAborted()) {
    setCronSessionRuntimeModel({
      entry: prepared.cronSession.sessionEntry,
      provider: providerUsed,
      model: modelUsed,
    });
    setCronSessionAgentHarnessId({
      entry: prepared.cronSession.sessionEntry,
      agentHarnessId,
    });
    prepared.cronSession.sessionEntry.contextTokens = contextTokens;
    prepared.cronSession.sessionEntry.contextTokensSource = contextTokensSource;
    if (isCliProvider(providerUsed, prepared.cfgWithAgentDefaults)) {
      const cliSessionBinding = finalRunResult.meta?.agentMeta?.cliSessionBinding;
      const cliSessionId = finalRunResult.meta?.agentMeta?.sessionId?.trim();
      if (finalRunResult.meta?.agentMeta?.clearCliSessionBinding === true) {
        const { clearCliSession } = await import("../../agents/cli-runner.runtime.js");
        clearCliSession(prepared.cronSession.sessionEntry, providerUsed);
      } else if (cliSessionBinding?.sessionId?.trim()) {
        const { setCliSessionBinding } = await import("../../agents/cli-runner.runtime.js");
        setCliSessionBinding(prepared.cronSession.sessionEntry, providerUsed, cliSessionBinding);
      } else if (cliSessionId) {
        const { setCliSessionId } = await import("../../agents/cli-runner.runtime.js");
        setCliSessionId(prepared.cronSession.sessionEntry, providerUsed, cliSessionId);
      }
    }
  }
  if (hasNonzeroUsage(usage)) {
    const { estimateUsageCost, resolveModelCostConfig } =
      await import("../../utils/usage-format.js");
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const lastCallTotalTokens = deriveSessionTotalTokens({
      usage: lastCallUsage,
      contextTokens,
      promptTokens,
    });
    const totalTokens =
      typeof lastCallTotalTokens === "number" && lastCallTotalTokens > 0
        ? lastCallTotalTokens
        : undefined;
    const costConfig = resolveModelCostConfig({
      provider: providerUsed,
      model: modelUsed,
      config: prepared.cfgWithAgentDefaults,
    });
    const runEstimatedCostUsd = asNonNegativeFiniteNumber(
      estimateUsageCost({ usage, cost: costConfig }),
    );
    prepared.cronSession.sessionEntry.inputTokens = input;
    prepared.cronSession.sessionEntry.outputTokens = output;
    const bucketTotalTokens = input + output + cacheRead + cacheWrite;
    // Keep telemetry totals consistent when a provider reports only a partial
    // aggregate alongside the normalized billing buckets.
    const aggregateTotalTokens =
      typeof usage.total === "number" && Number.isFinite(usage.total)
        ? Math.max(bucketTotalTokens, usage.total)
        : bucketTotalTokens;
    const telemetryUsage: NonNullable<CronRunTelemetry["usage"]> = {
      input_tokens: input,
      output_tokens: output,
      ...(aggregateTotalTokens > 0 ? { total_tokens: aggregateTotalTokens } : {}),
      ...(cacheRead > 0 ? { cache_read_tokens: cacheRead } : {}),
      ...(cacheWrite > 0 ? { cache_write_tokens: cacheWrite } : {}),
    };
    if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
      prepared.cronSession.sessionEntry.totalTokens = totalTokens;
      prepared.cronSession.sessionEntry.totalTokensFresh = true;
      prepared.cronSession.sessionEntry.totalTokensVersion = SESSION_TOTAL_TOKENS_VERSION;
    } else {
      prepared.cronSession.sessionEntry.totalTokens = undefined;
      prepared.cronSession.sessionEntry.totalTokensFresh = false;
      prepared.cronSession.sessionEntry.totalTokensVersion = undefined;
    }
    prepared.cronSession.sessionEntry.cacheRead = cacheRead;
    prepared.cronSession.sessionEntry.cacheWrite = cacheWrite;
    // Snapshot cost like tokens (runEstimatedCostUsd is already computed from
    // cumulative run usage, so assign directly instead of accumulating).
    // Fixes #69347: cost was inflated 1x-72x by accumulating on every persist.
    if (runEstimatedCostUsd !== undefined) {
      prepared.cronSession.sessionEntry.estimatedCostUsd = runEstimatedCostUsd;
    }
    telemetry = {
      model: modelUsed,
      provider: providerUsed,
      usage: telemetryUsage,
    };
    if (isDiagnosticsEnabled(prepared.cfgWithAgentDefaults)) {
      const diagnosticInput = diagnosticUsage?.input ?? 0;
      const diagnosticOutput = diagnosticUsage?.output ?? 0;
      const diagnosticCacheRead = diagnosticUsage?.cacheRead ?? 0;
      const diagnosticCacheWrite = diagnosticUsage?.cacheWrite ?? 0;
      const usagePromptTokens = diagnosticInput + diagnosticCacheRead + diagnosticCacheWrite;
      const diagnosticBucketTotalTokens = usagePromptTokens + diagnosticOutput;
      const diagnosticTotalTokens =
        typeof diagnosticUsage?.total === "number" && Number.isFinite(diagnosticUsage.total)
          ? Math.max(diagnosticBucketTotalTokens, diagnosticUsage.total)
          : diagnosticBucketTotalTokens;
      const hasDiagnosticBillableUsageBuckets =
        diagnosticUsage?.input !== undefined ||
        diagnosticUsage?.output !== undefined ||
        diagnosticUsage?.cacheRead !== undefined ||
        diagnosticUsage?.cacheWrite !== undefined;
      const diagnosticEstimatedCostUsd = asNonNegativeFiniteNumber(
        estimateUsageCost({ usage: diagnosticUsage, cost: costConfig }),
      );
      const contextUsedTokens = deriveContextPromptTokens({
        lastCallUsage,
        promptTokens,
        usage,
      });
      emitTrustedDiagnosticEvent({
        type: "model.usage",
        ...(finalRunResult.diagnosticTrace
          ? {
              trace: freezeDiagnosticTraceContext(
                createChildDiagnosticTraceContext(finalRunResult.diagnosticTrace),
              ),
            }
          : {}),
        sessionKey: prepared.runSessionKey,
        sessionId: prepared.currentRunSessionId(),
        channel: "cron",
        agentId: prepared.agentId,
        provider: providerUsed,
        model: modelUsed,
        usage: {
          input: diagnosticInput,
          output: diagnosticOutput,
          cacheRead: diagnosticCacheRead,
          cacheWrite: diagnosticCacheWrite,
          promptTokens: usagePromptTokens,
          total: diagnosticTotalTokens,
        },
        lastCallUsage,
        context: {
          limit: contextTokens,
          ...(contextUsedTokens !== undefined ? { used: contextUsedTokens } : {}),
        },
        ...(hasDiagnosticBillableUsageBuckets && diagnosticEstimatedCostUsd !== undefined
          ? { costUsd: diagnosticEstimatedCostUsd }
          : {}),
        durationMs: execution.runEndedAt - execution.runStartedAt,
      });
    }
  } else {
    telemetry = { model: modelUsed, provider: providerUsed };
  }
  await prepared.persistSessionEntry();
  await prepared.runContinuationSession?.seal({ basePersisted: true });

  if (params.isAborted()) {
    return prepared.withRunSession({
      status: "error",
      error: params.abortReason(),
      diagnostics: mergeCronRunDiagnostics(
        prepared.preflightDiagnostics,
        createCronRunDiagnosticsFromAgentResult(finalRunResult, { finalStatus: "error" }),
        createCronRunDiagnosticsFromError("cron-setup", params.abortReason()),
      ),
      ...telemetry,
    });
  }
  const cronPayloadOutcome = resolveCronPayloadOutcome({
    payloads,
    runLevelError: finalRunResult.meta?.error,
    failureSignal: finalRunResult.meta?.failureSignal,
    finalAssistantVisibleText: finalRunResult.meta?.finalAssistantVisibleText,
    preferFinalAssistantVisibleText: (
      await resolveCronChannelOutputPolicy(prepared.resolvedDelivery.channel, {
        deliveryRequested: prepared.deliveryRequested,
      })
    ).preferFinalAssistantVisibleText,
  });
  if (finalRunResult.meta?.aborted === true && !cronPayloadOutcome.hasFatalErrorPayload) {
    const metaErrorMessage = normalizeOptionalString(finalRunResult.meta.error?.message);
    const error = metaErrorMessage ?? "cron isolated agent run aborted";
    await cleanupRunSession("cron-delete-after-run-aborted");
    return prepared.withRunSession({
      status: "error",
      error,
      diagnostics: mergeCronRunDiagnostics(
        prepared.preflightDiagnostics,
        createCronRunDiagnosticsFromAgentResult(finalRunResult, { finalStatus: "error" }),
        createCronRunDiagnosticsFromError("agent-run", error),
      ),
      ...telemetry,
    });
  }
  const {
    deliveryDisposition,
    deliveryPayloadHasStructuredContent,
    hasFatalStructuredErrorPayload,
    pendingPresentationWarningError,
  } = cronPayloadOutcome;
  let {
    synthesizedText,
    deliveryPayloads,
    summary,
    outputText,
    hasFatalErrorPayload,
    embeddedRunError,
  } = cronPayloadOutcome;
  const terminalToolFailure = finalRunResult.meta?.terminalToolFailure;
  const hasTerminalToolFailure = isEmbeddedRunTerminalToolFailure(terminalToolFailure);
  if (hasFatalErrorPayload && hasTerminalToolFailure) {
    summary = CODE_MODE_MCP_CATALOG_MISS_MESSAGE;
  }
  const agentDiagnostics = createCronRunDiagnosticsFromAgentResult(finalRunResult, {
    finalStatus: hasFatalErrorPayload ? "error" : "ok",
  });
  const runDiagnostics = mergeCronRunDiagnostics(prepared.preflightDiagnostics, agentDiagnostics);
  const resolveRunOutcome = (result?: {
    delivered?: boolean;
    deliveryAttempted?: boolean;
    deliveryError?: string;
    delivery?: CronDeliveryTrace;
  }) =>
    prepared.withRunSession({
      status: hasFatalErrorPayload ? "error" : "ok",
      ...(hasFatalErrorPayload
        ? { error: embeddedRunError ?? "cron isolated run returned an error payload" }
        : {}),
      summary,
      outputText,
      delivered: result?.delivered,
      deliveryAttempted: result?.deliveryAttempted,
      deliveryError: result?.deliveryError,
      delivery: result?.delivery,
      diagnostics: mergeCronRunDiagnostics(
        runDiagnostics,
        hasFatalErrorPayload && !hasTerminalToolFailure
          ? createCronRunDiagnosticsFromError(
              "agent-run",
              embeddedRunError ?? "cron isolated run returned an error payload",
            )
          : undefined,
        result?.deliveryError
          ? createCronRunDiagnosticsFromError("delivery", result.deliveryError)
          : undefined,
      ),
      ...telemetry,
    });
  const failPendingPresentationWarningUnlessDelivered = (delivered?: boolean) => {
    if (pendingPresentationWarningError && delivered !== true) {
      hasFatalErrorPayload = true;
      embeddedRunError = pendingPresentationWarningError;
    }
  };

  const acceptedSessionSpawn = hasAcceptedSessionSpawn(finalRunResult.acceptedSessionSpawns);
  const heartbeatOnlyResponse =
    prepared.deliveryRequested && !hasFatalErrorPayload && deliveryDisposition.kind !== "visible";
  const heartbeatControlOnlyResponse =
    heartbeatOnlyResponse &&
    (deliveryDisposition.kind === "empty" ||
      (deliveryDisposition.kind === "heartbeat" && deliveryDisposition.controlOnly));
  const spawnOnlyHandoff =
    acceptedSessionSpawn &&
    (heartbeatControlOnlyResponse ||
      (deliveryPayloads.length === 0 && normalizeOptionalString(synthesizedText) === undefined));
  if (spawnOnlyHandoff && heartbeatControlOnlyResponse) {
    // Parent heartbeat acknowledgments cannot fulfill child delivery; one-shot
    // cleanup must wait for actual descendant output before retiring the job.
    deliveryPayloads = [];
    synthesizedText = undefined;
    summary = undefined;
    outputText = undefined;
  }
  const skipHeartbeatDelivery = heartbeatOnlyResponse && !spawnOnlyHandoff;
  const sourceDeliveryOutcome = resolveSourceDeliveryOutcome(prepared.sourceDelivery, {
    didSendViaMessageTool: finalRunResult.didSendViaMessagingTool,
    messageToolSentTargets: finalRunResult.messagingToolSentTargets,
  });
  let queueSourceSessionMessageToolAwareness: (() => Promise<void>) | undefined;
  if (sourceDeliveryOutcome.visibleDeliveries.length > 0) {
    const { queueCronMessageToolDeliveryAwareness } = await loadCronDeliveryRuntime();
    queueSourceSessionMessageToolAwareness = await queueCronMessageToolDeliveryAwareness({
      cfg: prepared.cfgWithAgentDefaults,
      job: prepared.input.job,
      agentId: prepared.agentId,
      agentSessionKey: prepared.agentSessionKey,
      deferredTargetSessionKey:
        prepared.input.job.sessionTarget === "current" ? prepared.sourceSessionKey : undefined,
      runStartedAt: execution.runStartedAt,
      resolvedDelivery: prepared.resolvedDelivery,
      sourceDeliveryOutcome,
    });
  }
  const hasCommittedTerminalProgress =
    hasCommittedMessagingToolDeliveryEvidence(finalRunResult) ||
    finalRunResult.didSendDeterministicApprovalPrompt === true ||
    acceptedSessionSpawn ||
    (finalRunResult.successfulCronAdds ?? 0) > 0;
  const hasIntentionalSilentReply =
    finalRunResult.meta?.terminalReplyKind === "silent-empty" ||
    isSilentReplyPayloadText(finalRunResult.meta?.finalAssistantRawText) ||
    isSilentReplyPayloadText(finalRunResult.meta?.finalAssistantVisibleText);
  if (
    prepared.deliveryRequested &&
    !hasFatalErrorPayload &&
    !sourceDeliveryOutcome.satisfiesSourceDelivery &&
    !hasCommittedTerminalProgress &&
    !hasIntentionalSilentReply &&
    !hasIntentionalTerminalCompletion(finalRunResult) &&
    deliveryPayloads.length === 0 &&
    normalizeOptionalString(synthesizedText) === undefined
  ) {
    await queueSourceSessionMessageToolAwareness?.();
    const error = "cron isolated run completed without a final assistant payload";
    return prepared.withRunSession({
      status: "error",
      error,
      summary: error,
      outputText: error,
      delivered: false,
      deliveryAttempted: false,
      diagnostics: mergeCronRunDiagnostics(
        runDiagnostics,
        createCronRunDiagnosticsFromError("agent-run", error),
      ),
      ...telemetry,
    });
  }
  if (hasFatalStructuredErrorPayload && prepared.deliveryRequested) {
    // Structured run error payloads belong in cron state and failure alerts,
    // not the normal completion announce path where provider JSON can leak.
    await cleanupRunSession("cron-delete-after-run-fatal-error");
    const deliveryTrace = buildCronDeliveryTrace({
      deliveryPlan: prepared.deliveryPlan,
      resolvedDelivery: prepared.resolvedDelivery,
      sourceDeliveryOutcome,
      fallbackUsed: false,
      delivered: sourceDeliveryOutcome.verifiedMessageToolDelivery,
    });
    await queueSourceSessionMessageToolAwareness?.();
    return resolveRunOutcome({
      delivered: sourceDeliveryOutcome.verifiedMessageToolDelivery,
      deliveryAttempted: sourceDeliveryOutcome.verifiedMessageToolDelivery,
      delivery: deliveryTrace,
    });
  }
  const { dispatchCronDelivery, resolveCronDeliveryBestEffort } = await loadCronDeliveryRuntime();
  const deliveryResult = await dispatchCronDelivery({
    cfg: prepared.input.cfg,
    cfgWithAgentDefaults: prepared.cfgWithAgentDefaults,
    deps: prepared.input.deps,
    job: prepared.input.job,
    agentId: prepared.agentId,
    agentSessionKey: prepared.agentSessionKey,
    sourceSessionKey: prepared.sourceSessionKey,
    runSessionKey: prepared.runSessionKey,
    sessionId: prepared.currentRunSessionId(),
    lifecycleRevision: prepared.cronSession.lifecycleRevision,
    sessionUpdatedAt: prepared.cronSession.sessionEntry.updatedAt,
    beforeSessionDelete: params.beforeSessionDelete,
    runStartedAt: execution.runStartedAt,
    runEndedAt: execution.runEndedAt,
    timeoutMs: prepared.timeoutMs,
    resolvedDelivery: prepared.resolvedDelivery,
    deliveryRequested: prepared.deliveryRequested,
    skipHeartbeatDelivery,
    spawnOnlyHandoff,
    sourceDeliveryOutcome,
    queueSourceSessionMessageToolAwareness,
    deliveryBestEffort: resolveCronDeliveryBestEffort(prepared.input.job),
    deliveryPayloadHasStructuredContent,
    deliveryPayloads,
    synthesizedText,
    ttsAuto: prepared.cronSession.sessionEntry.ttsAuto,
    summary,
    outputText,
    telemetry,
    abortSignal: prepared.input.abortSignal ?? prepared.input.signal,
    isAborted: params.isAborted,
    abortReason: params.abortReason,
    withRunSession: prepared.withRunSession,
  });
  if (deliveryResult.cronRunSessionCleanupAttempted) {
    params.markCronRunSessionCleanupAttempted();
  }
  const deliveryTrace = buildCronDeliveryTrace({
    deliveryPlan: prepared.deliveryPlan,
    resolvedDelivery: prepared.resolvedDelivery,
    sourceDeliveryOutcome,
    fallbackUsed:
      prepared.deliveryRequested &&
      deliveryResult.deliveryAttempted &&
      !sourceDeliveryOutcome.satisfiesSourceDelivery,
    delivered: deliveryResult.delivered,
  });
  if (deliveryResult.result) {
    const deliveryError = deliveryResult.result.deliveryError ?? deliveryResult.deliveryError;
    const deliveryDiagnosticError =
      deliveryError ??
      (deliveryResult.result.status === "error" ? deliveryResult.result.error : undefined);
    const resultWithDeliveryMeta: RunCronAgentTurnResult = {
      ...deliveryResult.result,
      delivered: deliveryResult.result.delivered ?? deliveryResult.delivered,
      deliveryAttempted:
        deliveryResult.result.deliveryAttempted ?? deliveryResult.deliveryAttempted,
      deliveryError,
      delivery: deliveryTrace,
      diagnostics: mergeCronRunDiagnostics(
        runDiagnostics,
        deliveryResult.result.diagnostics,
        deliveryDiagnosticError
          ? createCronRunDiagnosticsFromError("delivery", deliveryDiagnosticError)
          : undefined,
      ),
    };
    failPendingPresentationWarningUnlessDelivered(
      resultWithDeliveryMeta.delivered ?? deliveryResult.delivered,
    );
    if (!hasFatalErrorPayload) {
      // Spawn-only turns are incomplete until a child produces output; keeping
      // their failure visible prevents a one-shot job from being retired.
      const incompleteSpawnOnlyHandoff =
        spawnOnlyHandoff && normalizeOptionalString(deliveryResult.synthesizedText) === undefined;
      // A successful isolated agent turn must keep `status: "ok"` even when the
      // post-run delivery phase fails. Collapsing the delivery error into the
      // execution status made the outer scheduled run report `status=error`
      // for a session that actually ended successfully (#94058). Delivery
      // failure is recorded separately via `delivered`/`deliveryAttempted` and
      // delivery diagnostics, while deliberate target-guard refusals stay errors.
      if (
        deliveryResult.result.status === "error" &&
        deliveryResult.result.errorKind !== "delivery-target" &&
        !incompleteSpawnOnlyHandoff &&
        !params.isAborted()
      ) {
        const failedDeliveryError = resultWithDeliveryMeta.error;
        const successfulResult: RunCronAgentTurnResult = {
          ...resultWithDeliveryMeta,
          status: "ok",
          delivered: resultWithDeliveryMeta.delivered ?? deliveryResult.delivered,
          ...(failedDeliveryError ? { deliveryError: failedDeliveryError } : {}),
        };
        // Preserve the dispatcher's final summary and diagnostics, but keep the
        // downstream send failure out of execution-only status and error fields.
        delete successfulResult.error;
        delete successfulResult.errorKind;
        return successfulResult;
      }
      return resultWithDeliveryMeta;
    }
    if (deliveryResult.result.status !== "ok") {
      return resultWithDeliveryMeta;
    }
    return resolveRunOutcome({
      delivered: deliveryResult.result.delivered,
      deliveryAttempted: resultWithDeliveryMeta.deliveryAttempted,
      delivery: deliveryTrace,
    });
  }
  summary = deliveryResult.summary;
  outputText = deliveryResult.outputText;
  failPendingPresentationWarningUnlessDelivered(deliveryResult.delivered);
  return resolveRunOutcome({
    delivered: deliveryResult.delivered,
    deliveryAttempted: deliveryResult.deliveryAttempted,
    deliveryError: deliveryResult.deliveryError,
    delivery: deliveryTrace,
  });
}
