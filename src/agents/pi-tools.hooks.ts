/**
 * Tool hook wrapper — wires plugin before_tool_call / after_tool_call hooks
 * into the tool execution pipeline.
 *
 * Follows the same wrapping pattern as pi-tools.abort.ts.
 */

import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

export type ToolHookContext = {
  agentId?: string;
  sessionKey?: string;
};

/**
 * Wrap a tool so that plugin before_tool_call and after_tool_call hooks fire
 * around every invocation.
 *
 * - before_tool_call runs sequentially and may modify params or block the call.
 * - after_tool_call runs in parallel (fire-and-forget) with result/error/duration.
 */
export function wrapToolWithHooks(tool: AnyAgentTool, ctx: ToolHookContext): AnyAgentTool {
  const originalExecute = tool.execute;
  if (!originalExecute) return tool;

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const hookRunner = getGlobalHookRunner();
      const toolName = tool.name;

      // --- before_tool_call ---
      if (hookRunner?.hasHooks("before_tool_call")) {
        const beforeResult = await hookRunner.runBeforeToolCall(
          { toolName, params: (params ?? {}) as Record<string, unknown> },
          { agentId: ctx.agentId, sessionKey: ctx.sessionKey, toolName },
        );

        if (beforeResult?.block) {
          const reason = beforeResult.blockReason ?? "Blocked by plugin hook";
          return {
            content: [{ type: "text" as const, text: `[blocked] ${reason}` }],
            details: undefined,
          };
        }

        // Allow hooks to modify params
        if (beforeResult?.params) {
          params = beforeResult.params;
        }
      }

      // --- execute ---
      const start = Date.now();
      let result: Awaited<ReturnType<NonNullable<AnyAgentTool["execute"]>>>;
      let error: string | undefined;
      try {
        result = await originalExecute(toolCallId, params, signal, onUpdate);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        const durationMs = Date.now() - start;

        // --- after_tool_call (fire-and-forget) ---
        if (hookRunner?.hasHooks("after_tool_call")) {
          hookRunner
            .runAfterToolCall(
              {
                toolName,
                params: (params ?? {}) as Record<string, unknown>,
                result: error ? undefined : result!,
                error,
                durationMs,
              },
              { agentId: ctx.agentId, sessionKey: ctx.sessionKey, toolName },
            )
            .catch(() => {
              // swallow — after_tool_call is fire-and-forget
            });
        }
      }

      return result;
    },
  };
}
