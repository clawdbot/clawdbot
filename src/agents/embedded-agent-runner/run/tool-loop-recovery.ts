import { clearBatchAdmittedToolCallsForRun } from "../../agent-tools.before-tool-call.state.js";
import type { HookContext } from "../../agent-tools.before-tool-call.types.js";
import type { Agent } from "../../runtime/index.js";
import type { InternalBeforeToolBatchHook } from "../../runtime/internal-hooks.js";
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
    try {
      const intervention = await admitToolCallBatch(calls, ctx);
      return intervention ? { intervention } : undefined;
    } catch (error) {
      const first = calls[0];
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
