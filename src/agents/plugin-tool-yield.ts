import {
  runWithPluginToolTurnYieldInvocation,
  type PluginTurnYieldCommitter,
} from "../plugins/runtime/tool-yield-context.js";
import { copyPluginToolMeta, getPluginToolMeta } from "../plugins/tools.js";
import { copyBeforeToolCallHookMarker } from "./before-tool-call-metadata.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import { isToolResultError } from "./tool-result-error.js";
import { copyToolTerminalPresentation } from "./tool-terminal-presentation.js";
import type { AnyAgentTool } from "./tools/common.js";

type ForwardedToolExecution = (
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal,
  onUpdate?: unknown,
  ...executionArgs: unknown[]
) => ReturnType<AnyAgentTool["execute"]>;

function wrapToolWithPluginTurnYield(params: {
  tool: AnyAgentTool;
  committer: PluginTurnYieldCommitter;
}): AnyAgentTool {
  const { tool } = params;
  const execute = tool.execute as ForwardedToolExecution;
  const wrapped: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, toolParams, signal, onUpdate, ...executionArgs: unknown[]) => {
      const execution = await runWithPluginToolTurnYieldInvocation({
        catalogMode: tool.catalogMode,
        committer: params.committer,
        executionMode: tool.executionMode,
        run: async () => await execute(toolCallId, toolParams, signal, onUpdate, ...executionArgs),
      });
      if (!execution.requestedMessage || isToolResultError(execution.result)) {
        return execution.result;
      }
      await params.committer.commit(execution.requestedMessage);
      return { ...execution.result, terminate: true };
    },
  };
  copyPluginToolMeta(tool, wrapped);
  copyChannelAgentToolMeta(tool as never, wrapped as never);
  copyBeforeToolCallHookMarker(tool, wrapped);
  copyToolTerminalPresentation(tool, wrapped);
  return wrapped;
}

/** Applies the host-owned yield commit boundary to plugin tool execution. */
export function applyPluginToolTurnYieldRuntime(
  tools: AnyAgentTool[],
  committer: PluginTurnYieldCommitter,
): AnyAgentTool[] {
  return tools.map((tool) =>
    getPluginToolMeta(tool) === undefined ? tool : wrapToolWithPluginTurnYield({ tool, committer }),
  );
}
