import { emitAgentEvent } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  buildAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agent-run-terminal-outcome.js";
import type { EmbeddedAgentRunEntryTerminal } from "../embedded-agent-runner/run-entry.js";
import {
  resolveAgentRunAbortLifecycleFields,
  resolveAgentRunErrorLifecycleFields,
} from "../run-termination.js";
import type { AgentAttemptLifecycleState } from "./attempt-callbacks.js";
import type { AgentAttemptResult } from "./runtime-loaders.js";

const log = createSubsystemLogger("agents/agent-command");

function resolveTerminalLogLevel(
  outcome: AgentRunTerminalOutcome,
): "info" | "warn" | "error" | undefined {
  if (!outcome.stopReason || outcome.stopReason === "end_turn") {
    return undefined;
  }
  if (outcome.reason === "completed") {
    return "info";
  }
  return outcome.status === "timeout" ? "warn" : "error";
}

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
  return resolveTerminalLogLevel(outcome);
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
    emitFinishing(terminal: EmbeddedAgentRunEntryTerminal) {
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
          aborted: terminal.metadata.aborted ?? false,
          stopReason: terminal.outcome.stopReason,
          ...resolveAgentRunAbortLifecycleFields(params.abortSignal),
        },
      });
    },
    emitEnd(terminal: EmbeddedAgentRunEntryTerminal) {
      if (params.state.lifecycleEnded) {
        return;
      }
      params.state.lifecycleEnded = true;
      const stopReason = terminal.outcome.stopReason;
      const logLevel = resolveTerminalLogLevel(terminal.outcome);
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
          aborted: terminal.metadata.aborted ?? false,
          stopReason,
          ...resolveAgentRunAbortLifecycleFields(params.abortSignal),
        },
      });
    },
    resolveResultError,
    emitResultError(
      runResult: AgentAttemptResult,
      fallbackExhausted: boolean,
      terminal: EmbeddedAgentRunEntryTerminal,
    ) {
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
          ...terminal.metadata,
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
