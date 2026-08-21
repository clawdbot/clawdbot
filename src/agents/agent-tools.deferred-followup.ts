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

const SESSION_TOOL_FOLLOWUPS = [
  [
    "sessions_search",
    "sessions_history",
    "Follow up with sessions_history using a returned sessionKey, sessionId, and messageId for neighboring context.",
  ],
  [
    "conversations_send",
    "conversations_list",
    "Find the exact conversationRef with conversations_list.",
  ],
  ["sessions_spawn", "agents_list", "Find configured agent ids with agents_list."],
  ["sessions_spawn", "agents_wait", "Await collector runs with agents_wait."],
  ["sessions_spawn", "subagents", "Check spawns via `subagents`."],
  ["sessions_spawn", "sessions_history", "Check spawns via `sessions_history`."],
] as const;

function describeAvailableSessionFollowups(
  toolName: string,
  availableTools: ReadonlySet<string>,
): string[] {
  if (toolName === "sessions_send") {
    const deliveryTools = ["conversations_send", "conversations_turn"].filter((name) =>
      availableTools.has(name),
    );
    return availableTools.has("conversations_list") && deliveryTools.length > 0
      ? [
          `For an exact external destination, use \`conversations_list\` plus ${deliveryTools.map((name) => `\`${name}\``).join("/")}.`,
        ]
      : [];
  }
  return SESSION_TOOL_FOLLOWUPS.filter(
    ([sourceTool, requiredTool]) => sourceTool === toolName && availableTools.has(requiredTool),
  ).map((followup) => followup[2]);
}

/** Return tools with cross-tool guidance adjusted for the tools that survived filtering. */
export function applyToolAvailabilityDescriptions(
  tools: AnyAgentTool[],
  params?: { agentId?: string },
): AnyAgentTool[] {
  const availableTools = new Set(tools.map((tool) => tool.name));
  const hasCronTool = tools.some((tool) => isAutomationsToolName(tool.name));
  const hasProcessTool = availableTools.has("process");
  const hasSessionsSpawnTool = availableTools.has("sessions_spawn");
  return tools.map((tool) => {
    if (tool.name === "exec") {
      return replaceDescription(
        tool,
        describeExecTool({ agentId: params?.agentId, hasCronTool, hasProcessTool }),
      );
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
    const followups = describeAvailableSessionFollowups(tool.name, availableTools);
    return followups.length > 0
      ? replaceDescription(tool, `${tool.description} ${followups.join(" ")}`)
      : tool;
  });
}
