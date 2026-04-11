import { describeExecTool, describeProcessTool } from "./bash-tools.descriptions.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

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
