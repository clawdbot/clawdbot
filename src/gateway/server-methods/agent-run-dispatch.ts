import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  buildAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import {
  normalizeAgentRunTimeoutPhase,
  normalizeProviderStarted,
} from "../../agents/run-timeout-attribution.js";
import { agentCommandFromIngress } from "../../commands/agent.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { clearAgentRunContext } from "../../infra/agent-events.js";
import { readErrorName } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { createRunningTaskRun } from "../../tasks/detached-task-runtime.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import { formatForLog } from "../ws-log.js";
import { setGatewayDedupeEntries } from "./agent-dedupe.js";
import {
  resolveFailedTrackedAgentTaskStatus,
  tryFinalizeTrackedAgentTask,
  type GatewayAgentTaskTrackingMode,
} from "./agent-task-tracking.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

function readAgentRunTimeoutAttribution(meta: unknown) {
  const record =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : undefined;
  return {
    timeoutPhase: normalizeAgentRunTimeoutPhase(record?.timeoutPhase),
    providerStarted: normalizeProviderStarted(record?.providerStarted),
  };
}

function isGatewayAbortSignalReason(reason: unknown): boolean {
  return reason === undefined || isAbortError(reason) || readErrorName(reason) === "TimeoutError";
}

function isGatewayAgentAbortRejection(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) {
    return false;
  }
  if (isAgentRunRestartAbortReason(signal.reason)) {
    return true;
  }
  if (readErrorName(signal.reason) === "TimeoutError") {
    return true;
  }
  if (!isGatewayAbortSignalReason(signal.reason)) {
    return false;
  }
  return isAbortError(error) || readErrorName(error) === "TimeoutError";
}

function resolveGatewayAgentAbortStopReason(signal: AbortSignal): "restart" | "rpc" | "timeout" {
  if (isAgentRunRestartAbortReason(signal.reason)) {
    return "restart";
  }
  return readErrorName(signal.reason) === "TimeoutError" ? "timeout" : "rpc";
}

export function resolveAbortedAgentStopReason(entry?: ChatAbortControllerEntry): string {
  return entry?.abortStopReason?.trim() || "rpc";
}

export function deleteGatewayDedupeEntries(params: {
  dedupe: GatewayRequestContext["dedupe"];
  keys: readonly string[];
}) {
  for (const key of params.keys) {
    params.dedupe.delete(key);
  }
}

export function dispatchAgentRunFromGateway(params: {
  ingressOpts: Parameters<typeof agentCommandFromIngress>[0];
  runId: string;
  dedupeKeys: readonly string[];
  /**
   * Controller whose signal is wired into `ingressOpts.abortSignal`. Used on
   * completion to drop the matching `chatAbortControllers` entry without
   * touching a same-runId entry owned by a concurrent chat.send.
   */
  abortController: AbortController;
  cleanupAbortController: () => void;
  respond: GatewayRequestHandlerOptions["respond"];
  context: GatewayRequestHandlerOptions["context"];
  taskTrackingMode: Exclude<GatewayAgentTaskTrackingMode, "plugin_subagent">;
  onSettled?: (outcome: {
    terminalOutcome: AgentRunTerminalOutcome;
    onRecovered?: () => void;
  }) => Promise<boolean> | boolean;
}) {
  const shouldTrackTask = params.taskTrackingMode === "cli";
  let taskTracked = false;
  if (shouldTrackTask) {
    try {
      taskTracked = Boolean(
        createRunningTaskRun({
          runtime: "cli",
          sourceId: params.runId,
          ownerKey: params.ingressOpts.sessionKey,
          scopeKind: "session",
          requesterOrigin: normalizeDeliveryContext({
            channel: params.ingressOpts.channel,
            to: params.ingressOpts.to,
            accountId: params.ingressOpts.accountId,
            threadId: params.ingressOpts.threadId,
          }),
          childSessionKey: params.ingressOpts.sessionKey,
          runId: params.runId,
          task: params.ingressOpts.message,
          deliveryStatus: "not_applicable",
          startedAt: Date.now(),
        }),
      );
    } catch (err) {
      // Best-effort only: background task tracking must not block agent runs.
      // Still surface the swallowed error so non-transient tracking failures stay observable.
      params.context.logGateway.warn(
        `failed to start tracked agent task ${params.runId}: ${formatForLog(err)}`,
      );
    }
  }
  const settle = async (outcome: {
    terminalOutcome: AgentRunTerminalOutcome;
    onRecovered?: () => void;
  }): Promise<boolean> => {
    try {
      return (await params.onSettled?.(outcome)) ?? true;
    } catch (error) {
      params.context.logGateway.warn(
        `failed to settle agent continuation ${params.runId}: ${formatForLog(error)}`,
      );
      return false;
    }
  };
  void agentCommandFromIngress(params.ingressOpts, defaultRuntime, params.context.deps)
    .then(async (result) => {
      const aborted = result?.meta?.aborted === true;
      const timeoutAttribution = readAgentRunTimeoutAttribution(result?.meta);
      if (taskTracked) {
        tryFinalizeTrackedAgentTask({
          runId: params.runId,
          status: aborted ? "timed_out" : "succeeded",
          terminalSummary: aborted ? "aborted" : "completed",
          log: params.context.logGateway,
        });
      }
      const payload = {
        runId: params.runId,
        status: aborted ? ("timeout" as const) : ("ok" as const),
        summary: aborted ? "aborted" : "completed",
        ...(aborted ? { stopReason: result?.meta?.stopReason ?? "rpc" } : {}),
        ...(aborted && timeoutAttribution.timeoutPhase
          ? { timeoutPhase: timeoutAttribution.timeoutPhase }
          : {}),
        ...(aborted && timeoutAttribution.providerStarted !== undefined
          ? { providerStarted: timeoutAttribution.providerStarted }
          : {}),
        result,
      };
      const terminalOutcome = buildAgentRunTerminalOutcome({
        status:
          aborted || result?.meta?.stopReason === "timeout" || timeoutAttribution.timeoutPhase
            ? "timeout"
            : result?.meta?.error || result?.meta?.stopReason === "error"
              ? "error"
              : "ok",
        error: result?.meta?.error,
        stopReason: result?.meta?.stopReason,
        livenessState: result?.meta?.livenessState,
        timeoutPhase: timeoutAttribution.timeoutPhase,
        providerStarted: timeoutAttribution.providerStarted,
      });
      const persistTerminalDedupe = () => {
        setGatewayDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.dedupeKeys,
          entry: {
            ts: Date.now(),
            ok: true,
            payload,
          },
        });
      };
      const settled = await settle({ terminalOutcome, onRecovered: persistTerminalDedupe });
      if (!settled) {
        const summary = "failed to persist cron continuation settlement";
        const error = errorShape(ErrorCodes.UNAVAILABLE, summary);
        const failedPayload = { runId: params.runId, status: "error" as const, summary };
        setGatewayDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.dedupeKeys,
          entry: { ts: Date.now(), ok: false, payload: failedPayload, error },
        });
        params.respond(false, failedPayload, error, { runId: params.runId, error: summary });
        return;
      }
      persistTerminalDedupe();
      // Send a second res frame (same id) so TS clients with expectFinal can wait.
      // Swift clients will typically treat the first res as the result and ignore this.
      params.respond(true, payload, undefined, { runId: params.runId });
    })
    .catch(async (err: unknown) => {
      const aborted = isGatewayAgentAbortRejection(err, params.abortController.signal);
      const renderedErr = formatForLog(err);
      if (taskTracked) {
        tryFinalizeTrackedAgentTask({
          runId: params.runId,
          status: aborted ? "timed_out" : resolveFailedTrackedAgentTaskStatus(err),
          error: renderedErr,
          terminalSummary: renderedErr,
          log: params.context.logGateway,
        });
      }
      const error = errorShape(ErrorCodes.UNAVAILABLE, renderedErr);
      const stopReason = resolveGatewayAgentAbortStopReason(params.abortController.signal);
      const terminalOutcome = buildAgentRunTerminalOutcome({
        status: aborted ? "timeout" : "error",
        error: renderedErr,
        stopReason,
        timeoutPhase: aborted ? "gateway_draining" : undefined,
      });
      const payload = {
        runId: params.runId,
        status: aborted ? ("timeout" as const) : ("error" as const),
        summary: aborted ? "aborted" : renderedErr,
        ...(aborted ? { stopReason, timeoutPhase: "gateway_draining" as const } : {}),
      };
      const persistTerminalDedupe = (settlementPersisted: boolean) => {
        setGatewayDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.dedupeKeys,
          entry: {
            ts: Date.now(),
            ok: aborted && settlementPersisted,
            payload,
            ...(aborted ? {} : { error }),
          },
        });
      };
      const settled = await settle({
        terminalOutcome,
        onRecovered: () => persistTerminalDedupe(true),
      });
      persistTerminalDedupe(settled);
      params.respond(aborted && settled, payload, aborted && settled ? undefined : error, {
        runId: params.runId,
        ...(aborted ? {} : { error: formatForLog(err) }),
      });
    })
    .finally(() => {
      clearAgentRunContext(params.runId, params.ingressOpts.lifecycleGeneration);
      params.cleanupAbortController();
    });
}
