import type { HookRunner } from "../plugins/hooks.js";
import type { PluginHookAfterToolCallEvent } from "../plugins/types.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";

export function scheduleEmbeddedAfterToolCallHook(params: {
  ctx: ToolHandlerContext;
  hookRunner: HookRunner;
  event: PluginHookAfterToolCallEvent;
  toolName: string;
  toolCallId: string;
  runId: string;
}): void {
  const { ctx, event, hookRunner, runId, toolCallId, toolName } = params;
  void hookRunner
    .runAfterToolCall(event, {
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
