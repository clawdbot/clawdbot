import {
  appendLoopWarningToToolResult,
  clearBatchAdmittedToolCallsForRun,
} from "../../agent-tools.before-tool-call.state.js";
import type { HookContext } from "../../agent-tools.before-tool-call.types.js";
import { normalizeCodeModeExecBeforeHookParams } from "../../code-mode-control-tools.js";
import type { AfterToolCallResult, Agent } from "../../runtime/index.js";
import {
  attachInternalToolBatchLifecycle,
  type InternalBeforeToolBatchHook,
} from "../../runtime/internal-hooks.js";
import { admitToolCallBatch } from "../../tool-loop-admission.js";
import { hashToolCall } from "../../tool-loop-detection.js";
import { log } from "../logger.js";

/** Build the embedded-runner's private bridge into agent-core loop recovery. */
export function createToolLoopBatchAdmission(
  ctx: HookContext,
): InternalBeforeToolBatchHook | undefined {
  if (ctx.loopDetection?.enabled !== true) {
    return undefined;
  }
  return async ({ calls }) => {
    const canonicalCalls = calls.map((call) => ({
      ...call,
      args: call.tool
        ? normalizeCodeModeExecBeforeHookParams({ tool: call.tool, params: call.args })
        : call.args,
    }));
    try {
      const admission = await admitToolCallBatch(canonicalCalls, ctx);
      const { commitReadyCalls, releaseSkippedCalls, ...result } = admission;
      return commitReadyCalls && releaseSkippedCalls
        ? attachInternalToolBatchLifecycle(result, {
            commitReadyCalls,
            releaseSkippedCalls,
          })
        : result;
    } catch (error) {
      const first = canonicalCalls[0];
      log.error(`tool-loop batch admission failed: ${String(error)}`);
      return first
        ? {
            intervention: {
              kind: "critical-tool-loop",
              toolCallId: first.toolCall.id,
              toolName: first.toolCall.name,
              actionKey: hashToolCall(first.toolCall.name, first.args),
              detector: "loop_admission_failure",
              count: 1,
              reason: "Tool execution was blocked because loop safety checks failed.",
            },
          }
        : undefined;
    }
  };
}

/** Ensure calls blocked by later policies cannot leave run-scoped admission markers behind. */
export function installToolLoopRecoveryCleanup(params: { agent: Agent; runId: string }): void {
  params.agent.subscribe((event) => {
    if (event.type === "agent_end") {
      clearBatchAdmittedToolCallsForRun(params.runId);
    }
  });
}

/** Attach pending guidance after every result-replacing outcome hook has settled. */
export function installToolLoopWarningFinalizer(params: { agent: Agent; runId: string }): void {
  const previousAfterToolOutcome = params.agent.afterToolOutcome?.bind(params.agent);
  params.agent.afterToolOutcome = async (context, signal) => {
    let prior: AfterToolCallResult | undefined;
    try {
      prior = await previousAfterToolOutcome?.(context, signal);
    } catch (error) {
      const result = appendLoopWarningToToolResult(
        {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: {},
        },
        context.toolCall.id,
        params.runId,
      );
      return { content: result.content, details: result.details, isError: true };
    }

    const effectiveResult = prior
      ? {
          ...context.result,
          content: prior.content ?? context.result.content,
          details: prior.details ?? context.result.details,
          terminate: prior.terminate ?? context.result.terminate,
        }
      : context.result;
    const result = appendLoopWarningToToolResult(
      effectiveResult,
      context.toolCall.id,
      params.runId,
    );
    return result === effectiveResult ? prior : { ...prior, content: result.content };
  };
}
