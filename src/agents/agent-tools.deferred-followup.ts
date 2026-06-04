import type { AnyAgentTool } from "./agent-tools.types.js";
import { describeExecTool, describeProcessTool } from "./bash-tools.descriptions.js";

// Updates exec/process tool descriptions with deferred-followup guidance based
// on the tools available in the current run.
/** Return tools with exec/process descriptions adjusted for cron availability. */
export function applyDeferredFollowupToolDescriptions(
  tools: AnyAgentTool[],
  params?: { agentId?: string },
): AnyAgentTool[] {
  const hasCronTool = tools.some((tool) => tool.name === "cron");
  return tools.map((tool) => {
    if (tool.name === "exec") {
      return {
        ...tool,
        description: describeExecTool({ agentId: params?.agentId, hasCronTool }),
      };
    }
    if (tool.name === "process") {
      return {
        ...tool,
        description: describeProcessTool({ hasCronTool }),
      };
    }
    return tool;
  });
}
