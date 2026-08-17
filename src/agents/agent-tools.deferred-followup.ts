import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
/** Adjusts cross-tool guidance from the final authorized tool set. */
import type { AnyAgentTool } from "./agent-tools.types.js";
import { describeExecTool, describeProcessTool } from "./bash-tools.descriptions.js";
import { describeAgentsListTool, describeAgentsWaitTool } from "./tool-description-presets.js";
import { isAutomationsToolName } from "./tools/automations-tool-name.js";

function replaceDescription(tool: AnyAgentTool, description: string): AnyAgentTool {
  const updated = { ...tool, description };
  return copyAgentToolMetadata(tool, updated);
}

/** Return tools with cross-tool guidance adjusted for the tools that survived filtering. */
export function applyToolAvailabilityDescriptions(
  tools: AnyAgentTool[],
  params?: { agentId?: string },
): AnyAgentTool[] {
  const hasCronTool = tools.some((tool) => isAutomationsToolName(tool.name));
  const hasSessionsSpawnTool = tools.some((tool) => tool.name === "sessions_spawn");
  return tools.map((tool) => {
    if (tool.name === "exec") {
      return replaceDescription(tool, describeExecTool({ agentId: params?.agentId, hasCronTool }));
    }
    if (tool.name === "process") {
      return replaceDescription(tool, describeProcessTool({ hasCronTool }));
    }
    if (tool.name === "agents_list") {
      return replaceDescription(tool, describeAgentsListTool(hasSessionsSpawnTool));
    }
    if (tool.name === "agents_wait") {
      return replaceDescription(tool, describeAgentsWaitTool(hasSessionsSpawnTool));
    }
    return tool;
  });
}
