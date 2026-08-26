import type { PluginHookAfterToolCallEvent } from "../plugins/types.js";
import { loadHookRunnerGlobal } from "./embedded-agent-subscribe.handlers.tools.results.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";

/** Dispatch the embedded runtime's canonical after-tool hook without delaying settlement. */
export async function runEmbeddedAfterToolCallHook(params: {
  ctx: ToolHandlerContext;
  toolName: string;
  startArgs: Record<string, unknown>;
  runId: string;
  toolCallId: string;
  result: unknown;
  error?: string;
  startedAt?: number;
}): Promise<void> {
  const { ctx, toolName, startArgs, runId, toolCallId } = params;
  const hookRunner = ctx.hookRunner ?? (await loadHookRunnerGlobal()).getGlobalHookRunner();
  if (!hookRunner?.hasHooks("after_tool_call")) {
    return;
  }
  const hookEvent: PluginHookAfterToolCallEvent = {
    toolName,
    params: startArgs,
    runId,
    toolCallId,
    result: params.result,
    error: params.error,
    durationMs: params.startedAt != null ? Date.now() - params.startedAt : undefined,
  };
  void hookRunner
    .runAfterToolCall(hookEvent, {
      toolName,
      agentId: ctx.params.agentId,
      sessionKey: ctx.params.sessionKey,
      sessionId: ctx.params.sessionId,
      runId,
      toolCallId,
    })
    .catch((error: unknown) => {
      ctx.log.warn(`after_tool_call hook failed: tool=${toolName} error=${String(error)}`);
    });
}
