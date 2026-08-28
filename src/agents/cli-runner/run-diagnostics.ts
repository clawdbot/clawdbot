/** Trusted run hierarchy for Claude Code CLI-backed agent turns. */
import {
  diagnosticErrorCategory,
  diagnosticErrorFailureKind,
  diagnosticErrorMessage,
} from "../../infra/diagnostic-error-metadata.js";
import {
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  type DiagnosticHarnessRunErrorEvent,
} from "../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner.js";
import { isSignalTimeoutReason, isTimeoutError } from "../failover-error.js";
import type { RunCliAgentParams } from "./types.js";

type ClaudeCliRunPhase = DiagnosticHarnessRunErrorEvent["phase"];

export type ClaudeCliRunDiagnosticLifecycle = {
  setPhase: (phase: ClaudeCliRunPhase) => void;
};

type ClaudeCliRunDiagnosticParams = Pick<
  RunCliAgentParams,
  | "abortSignal"
  | "messageChannel"
  | "messageProvider"
  | "model"
  | "modelProvider"
  | "runId"
  | "sessionId"
  | "sessionKey"
  | "trigger"
>;

function diagnosticBase(params: ClaudeCliRunDiagnosticParams, trace: DiagnosticTraceContext) {
  const channel = params.messageChannel ?? params.messageProvider;
  return {
    runId: params.runId,
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    provider: params.modelProvider ?? "anthropic",
    ...(params.model ? { model: params.model } : {}),
    ...(params.trigger ? { trigger: params.trigger } : {}),
    ...(channel ? { channel } : {}),
    trace,
  };
}

function resultRunOutcome(
  result: EmbeddedAgentRunResult,
): "completed" | "aborted" | "blocked" | "error" {
  if (result.meta.livenessState === "blocked") {
    return "blocked";
  }
  if (result.meta.aborted === true) {
    return "aborted";
  }
  if (result.meta.error) {
    return "error";
  }
  return "completed";
}

function errorHarnessOutcome(
  error: unknown,
  abortSignal: AbortSignal | undefined,
): "aborted" | "timed_out" | "error" {
  const failureKind = diagnosticErrorFailureKind(error);
  if (failureKind === "timeout") {
    return "timed_out";
  }
  if (failureKind === "aborted") {
    return abortSignal?.aborted && isSignalTimeoutReason(abortSignal.reason)
      ? "timed_out"
      : "aborted";
  }
  if (abortSignal?.aborted === true) {
    return isSignalTimeoutReason(abortSignal.reason) ? "timed_out" : "aborted";
  }
  if (isTimeoutError(error)) {
    return "timed_out";
  }
  return "error";
}

/**
 * Wraps one OpenClaw Claude CLI turn in synthetic harness/run boundaries.
 * The child run scope makes every real Claude CLI model call nest beneath it.
 */
export async function runClaudeCliAgentTurnWithDiagnostics(
  params: ClaudeCliRunDiagnosticParams,
  run: (lifecycle: ClaudeCliRunDiagnosticLifecycle) => Promise<EmbeddedAgentRunResult>,
): Promise<EmbeddedAgentRunResult> {
  const harnessTrace = freezeDiagnosticTraceContext(createDiagnosticTraceContextFromActiveScope());
  const runTrace = freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(harnessTrace));
  const harnessBase = {
    ...diagnosticBase(params, harnessTrace),
    harnessId: "claude-cli",
  };
  const runBase = diagnosticBase(params, runTrace);
  const startedAt = Date.now();
  let phase: ClaudeCliRunPhase = "prepare";

  emitTrustedDiagnosticEvent({
    type: "harness.run.started",
    ...harnessBase,
  });
  emitTrustedDiagnosticEvent({
    type: "run.started",
    ...runBase,
  });

  try {
    const result = await runWithDiagnosticTraceContext(runTrace, () =>
      run({
        setPhase: (nextPhase) => {
          phase = nextPhase;
        },
      }),
    );
    const runOutcome = resultRunOutcome(result);
    const resultErrorMessage = result.meta.error?.message;
    const runErrorMessage = runOutcome === "error" ? resultErrorMessage : undefined;
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "run.completed",
        ...runBase,
        durationMs: Date.now() - startedAt,
        outcome: runOutcome,
        ...(runOutcome === "blocked" ? { blockedBy: "before_agent_run" } : {}),
        ...(runOutcome === "error" && result.meta.error
          ? { errorCategory: result.meta.error.kind }
          : {}),
      },
      runErrorMessage ? { errorMessage: runErrorMessage } : undefined,
    );
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "harness.run.completed",
        ...harnessBase,
        durationMs: Date.now() - startedAt,
        outcome:
          result.meta.timeoutPhase !== undefined
            ? "timed_out"
            : runOutcome === "aborted"
              ? "aborted"
              : runOutcome === "completed"
                ? "completed"
                : "error",
        ...(typeof result.meta.yielded === "boolean" ? { yieldDetected: result.meta.yielded } : {}),
      },
      resultErrorMessage && (runOutcome === "error" || runOutcome === "blocked")
        ? { errorMessage: resultErrorMessage }
        : undefined,
    );
    return result.diagnosticTrace ? result : { ...result, diagnosticTrace: harnessTrace };
  } catch (error) {
    const errorMessage = diagnosticErrorMessage(error);
    const harnessOutcome = errorHarnessOutcome(error, params.abortSignal);
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "run.completed",
        ...runBase,
        durationMs: Date.now() - startedAt,
        outcome: harnessOutcome === "error" ? "error" : "aborted",
        ...(harnessOutcome === "error" ? { errorCategory: diagnosticErrorCategory(error) } : {}),
      },
      errorMessage ? { errorMessage } : undefined,
    );
    if (harnessOutcome === "error") {
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "harness.run.error",
          ...harnessBase,
          durationMs: Date.now() - startedAt,
          phase,
          errorCategory: diagnosticErrorCategory(error),
        },
        errorMessage ? { errorMessage } : undefined,
      );
    } else {
      emitTrustedDiagnosticEvent({
        type: "harness.run.completed",
        ...harnessBase,
        durationMs: Date.now() - startedAt,
        outcome: harnessOutcome,
      });
    }
    throw error;
  }
}
