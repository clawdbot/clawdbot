import type { HookRunner } from "../plugins/hooks.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";

export function scheduleEmbeddedAfterToolCallHook(params: {
  ctx: ToolHandlerContext;
  hookRunner: HookRunner;
  params: Record<string, unknown>;
  result: unknown;
  error?: string;
  startedAt?: number;
  toolName: string;
  toolCallId: string;
  runId: string;
}): void {
  const { ctx, hookRunner, runId, toolCallId, toolName } = params;
  void hookRunner
    .runAfterToolCall(
      {
        toolName,
        params: params.params,
        runId,
        toolCallId,
        result: params.result,
        error: params.error,
        durationMs: params.startedAt == null ? undefined : Date.now() - params.startedAt,
      },
      {
        toolName,
        agentId: ctx.params.agentId,
        sessionKey: ctx.params.sessionKey,
        sessionId: ctx.params.sessionId,
        runId,
        toolCallId,
      },
    )
    .catch((error: unknown) => {
      ctx.log.warn(`after_tool_call hook failed: tool=${toolName} error=${String(error)}`);
    });
}
