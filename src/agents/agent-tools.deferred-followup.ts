import { copyPluginToolMeta } from "../plugins/tools.js";
/**
 * Adjusts exec/process tool descriptions for long-running follow-up behavior.
 * Cron-aware runs can point models at scheduled follow-ups; cronless runs keep
 * guidance constrained to process polling and wake handling.
 */
import type { AnyAgentTool } from "./agent-tools.types.js";
import { describeExecTool, describeProcessTool } from "./bash-tools.descriptions.js";
import { copyBeforeToolCallHookMarker } from "./before-tool-call-metadata.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import { copyToolTerminalPresentation } from "./tool-terminal-presentation.js";

function replaceDescription(tool: AnyAgentTool, description: string): AnyAgentTool {
  const updated = { ...tool, description };
  copyPluginToolMeta(tool, updated);
  copyChannelAgentToolMeta(tool as never, updated as never);
  copyBeforeToolCallHookMarker(tool, updated);
  copyToolTerminalPresentation(tool, updated);
  return updated;
}

/** Return tools with exec/process descriptions adjusted for cron availability. */
export function applyDeferredFollowupToolDescriptions(
  tools: AnyAgentTool[],
  params?: { agentId?: string },
): AnyAgentTool[] {
  const hasCronTool = tools.some((tool) => tool.name === "cron");
  return tools.map((tool) => {
    if (tool.name === "exec") {
      return replaceDescription(tool, describeExecTool({ agentId: params?.agentId, hasCronTool }));
    }
    if (tool.name === "process") {
      return replaceDescription(tool, describeProcessTool({ hasCronTool }));
    }
    return tool;
  });
}
