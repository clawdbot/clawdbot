import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
/**
 * Adjusts exec/process tool descriptions for long-running follow-up behavior.
 * Cron-aware runs can point models at scheduled follow-ups; cronless runs keep
 * guidance constrained to process polling and wake handling.
 */
import type { AnyAgentTool } from "./agent-tools.types.js";
import { describeExecTool, describeProcessTool } from "./bash-tools.descriptions.js";
import { isAutomationsToolName } from "./tools/automations-tool-name.js";

function replaceDescription(tool: AnyAgentTool, description: string): AnyAgentTool {
  const updated = { ...tool, description };
  return copyAgentToolMetadata(tool, updated);
}

/** Return tools with exec/process descriptions adjusted for cron availability. */
export function applyDeferredFollowupToolDescriptions(
  tools: AnyAgentTool[],
  params?: { agentId?: string },
): AnyAgentTool[] {
  const hasCronTool = tools.some((tool) => isAutomationsToolName(tool.name));
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
