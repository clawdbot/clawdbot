/**
 * Agent harness lifecycle diagnostics wrapper.
 *
 * This module wraps harness attempts with context-engine support checks,
 * diagnostic events, trace propagation, and result classification.
 */
import {
  assertContextEngineHostSupport,
  type ContextEngineHostSupport,
} from "../../context-engine/host-compat.js";
import {
  diagnosticErrorCategory,
  diagnosticErrorMessage,
} from "../../infra/diagnostic-error-metadata.js";
import {
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  type DiagnosticHarnessRunErrorEvent,
  type DiagnosticHarnessRunOutcome,
} from "../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { applyAgentHarnessResultClassification } from "./result-classification.js";
import { assertSettledTurnFinalizationResult } from "./settled-turn-finalization-result.js";
import type {
  AgentHarness,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentHarnessSettledTurnFinalizationResult,
} from "./types.js";

type AgentHarnessLifecyclePhase = DiagnosticHarnessRunErrorEvent["phase"];
type AgentRunCompletedOutcome = "completed" | "aborted" | "blocked" | "error";
type AgentRunCompletion = {
  outcome: AgentRunCompletedOutcome;
  blockedBy?: string;
  error?: unknown;
};

function buildAgentHarnessContextEngineHostSupport(
  harness: AgentHarness,
): ContextEngineHostSupport {
  return {
    id: `agent-harness:${harness.id}`,
    label: `agent harness "${harness.id}"`,
    capabilities: harness.contextEngineHostCapabilities ?? [],
  };
}

function assertAgentHarnessContextEngineSupport(
  harness: AgentHarness,
  params: AgentHarnessAttemptParams,
): void {
  if (!params.contextEngine || params.contextEngine.info.id === "legacy") {
    return;
  }
  assertContextEngineHostSupport({
    contextEngine: params.contextEngine,
    operation: "agent-run",
    host: buildAgentHarnessContextEngineHostSupport(harness),
  });
}

function agentHarnessDiagnosticBase(
  harness: AgentHarness,
  params: AgentHarnessAttemptParams,
  trace?: DiagnosticTraceContext,
) {
  const diagnosticTrace = trace ?? getActiveDiagnosticTraceContext();
  const channel = diagnosticChannel(params);
  return {
    runId: params.runId,
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.modelId,
    harnessId: harness.id,
    ...(harness.pluginId ? { pluginId: harness.pluginId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.trigger ? { trigger: params.trigger } : {}),
    ...(channel ? { channel } : {}),
    ...(diagnosticTrace ? { trace: freezeDiagnosticTraceContext(diagnosticTrace) } : {}),
  };
}

function agentHarnessRunOutcome(result: AgentHarnessAttemptResult): DiagnosticHarnessRunOutcome {
  if (result.promptError) {
    return "error";
  }
  if (result.externalAbort || result.aborted) {
    return "aborted";
  }
  if (result.timedOut || result.idleTimedOut || result.timedOutDuringCompaction) {
    return "timed_out";
  }
  return "completed";
}

function shouldEmitAgentRunDiagnostics(harness: AgentHarness): boolean {
  return harness.id !== "openclaw";
}

function diagnosticChannel(params: AgentHarnessAttemptParams): string | undefined {
  return params.messageChannel ?? params.messageProvider;
}

function agentRunDiagnosticBase(params: AgentHarnessAttemptParams, trace: DiagnosticTraceContext) {
  const channel = diagnosticChannel(params);
  return {
    runId: params.runId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    provider: params.provider,
    model: params.modelId,
    ...(params.trigger ? { trigger: params.trigger } : {}),
    ...(channel ? { channel } : {}),
    trace,
  };
}

function agentRunCompletion(result: AgentHarnessAttemptResult): AgentRunCompletion {
  if (result.promptErrorSource === "hook:before_agent_run") {
    return { outcome: "blocked", blockedBy: "before_agent_run" };
  }
  if (result.promptError) {
    return { outcome: "error", error: result.promptError };
  }
  if (
    result.externalAbort ||
    result.aborted ||
    result.timedOut ||
    result.idleTimedOut ||
    result.timedOutDuringCompaction
  ) {
    return { outcome: "aborted" };
  }
  return { outcome: "completed" };
}

function withFallbackDiagnosticTrace(
  result: AgentHarnessAttemptResult,
  trace: DiagnosticTraceContext | undefined,
): AgentHarnessAttemptResult {
  if (result.diagnosticTrace || !trace) {
    return result;
  }
  return {
    ...result,
    diagnosticTrace: freezeDiagnosticTraceContext(trace),
  };
}

function withFallbackFinalizationDiagnosticTrace(
  result: AgentHarnessSettledTurnFinalizationResult,
  trace: DiagnosticTraceContext | undefined,
): AgentHarnessSettledTurnFinalizationResult {
  if (result.diagnosticTrace || !trace) {
    return result;
  }
  return {
    ...result,
    diagnosticTrace: freezeDiagnosticTraceContext(trace),
  };
}

function emitAgentHarnessRunStarted(
  harness: AgentHarness,
  params: AgentHarnessAttemptParams,
  trace?: DiagnosticTraceContext,
): void {
  emitTrustedDiagnosticEvent({
    type: "harness.run.started",
    ...agentHarnessDiagnosticBase(harness, params, trace),
  });
}

function emitAgentHarnessRunCompleted(params: {
  harness: AgentHarness;
  attemptParams: AgentHarnessAttemptParams;
  result: AgentHarnessAttemptResult;
  startedAt: number;
  trace?: DiagnosticTraceContext;
}): void {
  const { harness, attemptParams, result, startedAt, trace } = params;
  const outcome = agentHarnessRunOutcome(result);
  // A classified (non-thrown) failure carries its error on result.promptError;
  // forward the message so the error span shows more than a bare category.
  const errorMessage = outcome === "error" ? diagnosticErrorMessage(result.promptError) : undefined;
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "harness.run.completed",
      ...agentHarnessDiagnosticBase(harness, attemptParams, trace ?? result.diagnosticTrace),
      durationMs: Date.now() - startedAt,
      outcome,
      ...(result.agentHarnessResultClassification
        ? { resultClassification: result.agentHarnessResultClassification }
        : {}),
      ...(typeof result.yieldDetected === "boolean" ? { yieldDetected: result.yieldDetected } : {}),
      itemLifecycle: { ...result.itemLifecycle },
    },
    errorMessage ? { errorMessage } : undefined,
  );
}

function emitAgentHarnessRunError(params: {
  harness: AgentHarness;
  attemptParams: AgentHarnessAttemptParams;
  startedAt: number;
  phase: AgentHarnessLifecyclePhase;
  error: unknown;
  trace?: DiagnosticTraceContext;
}): void {
  const { harness, attemptParams, startedAt, phase, error, trace } = params;
  const errorMessage = diagnosticErrorMessage(error);
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "harness.run.error",
      ...agentHarnessDiagnosticBase(harness, attemptParams, trace),
      durationMs: Date.now() - startedAt,
      phase,
      errorCategory: diagnosticErrorCategory(error),
    },
    errorMessage ? { errorMessage } : undefined,
  );
}

/** Runs one harness attempt with diagnostics, tracing, and result classification. */
export async function runAgentHarnessLifecycleAttempt(
  harness: AgentHarness,
  params: AgentHarnessAttemptParams,
  execute: (params: AgentHarnessAttemptParams) => Promise<AgentHarnessAttemptResult> = (
    attemptParams,
  ) => harness.runAttempt(attemptParams),
): Promise<AgentHarnessAttemptResult> {
  let result: AgentHarnessAttemptResult;
  let phase: AgentHarnessLifecyclePhase = "prepare";
  const startedAt = Date.now();
  const activeHarnessTrace = getActiveDiagnosticTraceContext();
  let agentRunTrace: DiagnosticTraceContext | undefined;
  let agentRunStartedAt = 0;
  let agentRunCompleted = false;
  const emitAgentRunCompleted = (completion: AgentRunCompletion): void => {
    if (!agentRunTrace || agentRunCompleted) {
      return;
    }
    agentRunCompleted = true;
    const failed = completion.outcome === "error" && completion.error != null;
    const errorMessage = failed ? diagnosticErrorMessage(completion.error) : undefined;
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "run.completed",
        ...agentRunDiagnosticBase(params, agentRunTrace),
        durationMs: Date.now() - agentRunStartedAt,
        outcome: completion.outcome,
        ...(completion.blockedBy ? { blockedBy: completion.blockedBy } : {}),
        ...(failed ? { errorCategory: diagnosticErrorCategory(completion.error) } : {}),
      },
      errorMessage ? { errorMessage } : undefined,
    );
  };

  emitAgentHarnessRunStarted(harness, params, activeHarnessTrace);
  try {
    phase = "prepare";
    assertAgentHarnessContextEngineSupport(harness, params);
    if (shouldEmitAgentRunDiagnostics(harness) && activeHarnessTrace) {
      // Non-OpenClaw harnesses get a child run trace so provider/harness spans
      // stay linked without reusing the parent harness trace id.
      agentRunTrace = freezeDiagnosticTraceContext(
        createChildDiagnosticTraceContext(activeHarnessTrace),
      );
      agentRunStartedAt = Date.now();
      emitTrustedDiagnosticEvent({
        type: "run.started",
        ...agentRunDiagnosticBase(params, agentRunTrace),
      });
    }
    const runAndClassify = async () => {
      phase = "send";
      const rawResult = await execute(params);
      phase = "resolve";
      // Classification happens inside the diagnostic phase so failures identify
      // whether they came from send or result resolution.
      return applyAgentHarnessResultClassification(harness, rawResult, params);
    };
    result = agentRunTrace
      ? await runWithDiagnosticTraceContext(agentRunTrace, runAndClassify)
      : await runAndClassify();
    result = withFallbackDiagnosticTrace(result, activeHarnessTrace);
  } catch (error) {
    emitAgentHarnessRunError({
      harness,
      attemptParams: params,
      startedAt,
      phase,
      error,
      trace: activeHarnessTrace,
    });
    emitAgentRunCompleted({ outcome: "error", error });
    throw error;
  }

  emitAgentRunCompleted(agentRunCompletion(result));
  emitAgentHarnessRunCompleted({
    harness,
    attemptParams: params,
    result,
    startedAt,
    trace: activeHarnessTrace,
  });
  return result;
}

/** Runs one isolated finalization with diagnostics and its narrow result validator. */
export async function runAgentHarnessLifecycleFinalization(
  harness: AgentHarness,
  params: AgentHarnessAttemptParams,
  execute: () => Promise<AgentHarnessSettledTurnFinalizationResult>,
): Promise<AgentHarnessSettledTurnFinalizationResult> {
  let phase: AgentHarnessLifecyclePhase = "prepare";
  const startedAt = Date.now();
  const activeHarnessTrace = getActiveDiagnosticTraceContext();
  const agentRunTrace =
    shouldEmitAgentRunDiagnostics(harness) && activeHarnessTrace
      ? freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(activeHarnessTrace))
      : undefined;

  emitAgentHarnessRunStarted(harness, params, activeHarnessTrace);
  if (agentRunTrace) {
    emitTrustedDiagnosticEvent({
      type: "run.started",
      ...agentRunDiagnosticBase(params, agentRunTrace),
    });
  }
  try {
    const runAndValidate = async () => {
      phase = "send";
      const rawResult = await execute();
      phase = "resolve";
      return assertSettledTurnFinalizationResult(rawResult);
    };
    const rawResult = agentRunTrace
      ? await runWithDiagnosticTraceContext(agentRunTrace, runAndValidate)
      : await runAndValidate();
    const result = withFallbackFinalizationDiagnosticTrace(rawResult, activeHarnessTrace);
    if (agentRunTrace) {
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        ...agentRunDiagnosticBase(params, agentRunTrace),
        durationMs: Date.now() - startedAt,
        outcome: "completed",
      });
    }
    emitTrustedDiagnosticEvent({
      type: "harness.run.completed",
      ...agentHarnessDiagnosticBase(harness, params, result.diagnosticTrace ?? activeHarnessTrace),
      durationMs: Date.now() - startedAt,
      outcome: "completed",
      itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    });
    return result;
  } catch (error) {
    emitAgentHarnessRunError({
      harness,
      attemptParams: params,
      startedAt,
      phase,
      error,
      trace: activeHarnessTrace,
    });
    if (agentRunTrace) {
      const errorMessage = diagnosticErrorMessage(error);
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "run.completed",
          ...agentRunDiagnosticBase(params, agentRunTrace),
          durationMs: Date.now() - startedAt,
          outcome: "error",
          errorCategory: diagnosticErrorCategory(error),
        },
        errorMessage ? { errorMessage } : undefined,
      );
    }
    throw error;
  }
}
