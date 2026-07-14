import { createAbortError } from "../infra/abort-signal.js";
/**
 * Abort-signal wrapping for agent tools.
 * Combines per-call cancellation with run-level aborts while preserving plugin,
 * channel, and before_tool_call metadata on wrapped tools.
 */
import { copyPluginToolMeta } from "../plugins/tools.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { copyBeforeToolCallHookMarker } from "./before-tool-call-metadata.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";

function throwAbortError(): never {
  throw createAbortError("Aborted");
}

/** Wrap a tool so every execute call observes the supplied run abort signal. */
export function wrapToolWithAbortSignal(
  tool: AnyAgentTool,
  abortSignal?: AbortSignal,
): AnyAgentTool {
  if (!abortSignal) {
    return tool;
  }
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const combinedSignal = signal ? AbortSignal.any([signal, abortSignal]) : abortSignal;
      if (combinedSignal.aborted) {
        throwAbortError();
      }
      return await execute(toolCallId, params, combinedSignal, onUpdate);
    },
  };
  copyPluginToolMeta(tool, wrappedTool);
  copyChannelAgentToolMeta(tool as never, wrappedTool as never);
  copyBeforeToolCallHookMarker(tool, wrappedTool);
  return wrappedTool;
}
