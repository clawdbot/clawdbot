import { emitAgentEvent } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildAgentRunTerminalOutcome } from "../agent-run-terminal-outcome.js";
import {
  resolveAgentRunAbortLifecycleFields,
  resolveAgentRunErrorLifecycleFields,
} from "../run-termination.js";
import type { AgentAttemptLifecycleState } from "./attempt-callbacks.js";
import type { AgentAttemptResult } from "./runtime-loaders.js";

const log = createSubsystemLogger("agents/agent-command");

export function resolveAgentRunLifecycleEndLogLevel(meta: {
  aborted?: unknown;
  error?: unknown;
  stopReason?: unknown;
  livenessState?: unknown;
  timeoutPhase?: unknown;
  providerStarted?: unknown;
}): "info" | "warn" | "error" | undefined {
  const status =
    meta.stopReason === "timeout" || meta.timeoutPhase
      ? "timeout"
      : meta.aborted === true || meta.error || meta.stopReason === "error"
        ? "error"
        : "ok";
  const outcome = buildAgentRunTerminalOutcome({
    status,
    error: meta.error,
    stopReason: meta.stopReason,
    livenessState: meta.livenessState,
    timeoutPhase: meta.timeoutPhase,
    providerStarted: meta.providerStarted,
  });
  if (!outcome.stopReason || outcome.stopReason === "end_turn") {
    return undefined;
  }
  if (outcome.reason === "completed") {
    return "info";
  }
  return outcome.status === "timeout" ? "warn" : "error";
}

export function applyAgentRunAbortMetadata<T extends { meta: object }>(
  result: T,
  signal: AbortSignal | undefined,
): T {
  const abortFields = resolveAgentRunAbortLifecycleFields(signal);
  if (abortFields.aborted !== true) {
    return result;
  }
  return {
    ...result,
    meta: {
      ...result.meta,
      ...abortFields,
    },
  };
}

export function createAgentCommandLifecycle(params: {
  runId: string;
  lifecycleGeneration: () => string;
  startedAt: number;
  abortSignal?: AbortSignal;
  state: AgentAttemptLifecycleState;
}) {
  let lifecycleFinishingEmitted = false;
  const resolveResultError = (runResult: AgentAttemptResult, includeErrorPayload: boolean) =>
    params.state.lifecycleError ??
    (includeErrorPayload
      ? runResult.payloads?.find(
          (payload) => payload.isError === true && typeof payload.text === "string",
        )?.text
      : undefined) ??
    (runResult.meta.error ? "Agent run failed" : undefined);

  return {
    emitFinishing(runResult: AgentAttemptResult) {
      if (
        params.state.lifecycleEnded ||
        params.state.lifecycleFinishing ||
        lifecycleFinishingEmitted
      ) {
        return;
      }
      lifecycleFinishingEmitted = true;
      params.state.lifecycleFinishing = true;
      emitAgentEvent({
        runId: params.runId,
        lifecycleGeneration: params.lifecycleGeneration(),
        stream: "lifecycle",
        data: {
          phase: "finishing",
          startedAt: params.startedAt,
          endedAt: Date.now(),
          aborted: runResult.meta.aborted ?? false,
          stopReason: runResult.meta.stopReason,
          ...resolveAgentRunAbortLifecycleFields(params.abortSignal),
        },
      });
    },
    emitEnd(runResult: AgentAttemptResult) {
      if (params.state.lifecycleEnded) {
        return;
      }
      params.state.lifecycleEnded = true;
      const stopReason = runResult.meta.stopReason;
      const logLevel = resolveAgentRunLifecycleEndLogLevel(runResult.meta);
      if (logLevel) {
        log[logLevel](`[agent] run ${params.runId} ended with stopReason=${stopReason}`);
      }
      emitAgentEvent({
        runId: params.runId,
        lifecycleGeneration: params.lifecycleGeneration(),
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt: params.startedAt,
          endedAt: Date.now(),
          aborted: runResult.meta.aborted ?? false,
          stopReason,
          ...resolveAgentRunAbortLifecycleFields(params.abortSignal),
        },
      });
    },
    resolveResultError,
    emitResultError(runResult: AgentAttemptResult, fallbackExhausted: boolean) {
      if (params.state.lifecycleEnded) {
        return;
      }
      params.state.lifecycleEnded = true;
      const error =
        resolveResultError(runResult, fallbackExhausted) ??
        (fallbackExhausted ? "All model fallback candidates failed" : "Agent run failed");
      emitAgentEvent({
        runId: params.runId,
        lifecycleGeneration: params.lifecycleGeneration(),
        stream: "lifecycle",
        data: {
          phase: "error",
          startedAt: params.startedAt,
          endedAt: Date.now(),
          error,
          ...(runResult.meta.stopReason ? { stopReason: runResult.meta.stopReason } : {}),
          ...(runResult.meta.livenessState ? { livenessState: runResult.meta.livenessState } : {}),
          ...(runResult.meta.timeoutPhase ? { timeoutPhase: runResult.meta.timeoutPhase } : {}),
          ...(typeof runResult.meta.providerStarted === "boolean"
            ? { providerStarted: runResult.meta.providerStarted }
            : {}),
          ...(typeof runResult.meta.aborted === "boolean"
            ? { aborted: runResult.meta.aborted }
            : {}),
          ...(runResult.meta.replayInvalid === true ? { replayInvalid: true } : {}),
          ...(runResult.meta.yielded === true ? { yielded: true } : {}),
          ...(fallbackExhausted ? { fallbackExhaustedFailure: true } : {}),
        },
      });
    },
    emitPostTurnError(error: unknown) {
      if (params.state.lifecycleEnded) {
        return;
      }
      params.state.lifecycleEnded = true;
      emitAgentEvent({
        runId: params.runId,
        lifecycleGeneration: params.lifecycleGeneration(),
        stream: "lifecycle",
        data: {
          phase: "error",
          startedAt: params.startedAt,
          endedAt: Date.now(),
          error: error instanceof Error ? error.message : "Agent run failed",
          ...resolveAgentRunErrorLifecycleFields(error, params.abortSignal),
        },
      });
    },
  };
}
