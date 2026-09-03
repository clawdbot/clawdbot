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

const TOOL_FOLLOWUPS = [
  ["gateway", "openclaw", " unavailable; ask human.", ": use openclaw tool."],
  [
    "sessions_search",
    "sessions_history",
    "Search visible past sessions for matching user and assistant text.",
    "Search visible past sessions for matching user and assistant text. Follow up with sessions_history using a returned sessionKey, sessionId, and messageId for neighboring context.",
  ],
  [
    "conversations_send",
    "conversations_list",
    "through a conversationRef.",
    "through a conversationRef from conversations_list.",
  ],
  ["sessions_spawn", "agents_list", "configured agent;", "configured agent (see agents_list);"],
  [
    "sessions_yield",
    "agents_wait",
    "Collector runs require explicit collection instead.",
    "Collector runs require agents_wait instead.",
  ],
  [
    "sessions_spawn",
    "agents_wait",
    "`groupId` groups a batch.",
    "`groupId` groups a batch; await with agents_wait.",
  ],
] as const;

function describeAvailableTool(tool: AnyAgentTool, availableTools: ReadonlySet<string>): string {
  let description = tool.description;
  // Preserve byte-stable default prompt placement while gating every named sibling.
  for (const [sourceTool, requiredTool, original, expanded] of TOOL_FOLLOWUPS) {
    if (sourceTool === tool.name && availableTools.has(requiredTool)) {
      description = description.replace(original, expanded);
    }
  }
  if (tool.name === "sessions_send") {
    const deliveryTools = ["conversations_send", "conversations_turn"].filter((name) =>
      availableTools.has(name),
    );
    if (availableTools.has("conversations_list") && deliveryTools.length > 0) {
      const guidance = `For an exact external destination, use \`conversations_list\` plus ${deliveryTools.map((name) => `\`${name}\``).join("/")}.`;
      description = description.replace(
        " Thread chats rejected:",
        ` ${guidance} Thread chats rejected:`,
      );
    }
  }
  if (tool.name === "sessions_spawn") {
    const statusTools = ["subagents", "sessions_history"].filter((name) =>
      availableTools.has(name),
    );
    if (statusTools.length > 0) {
      const guidance = statusTools.map((name) => `\`${name}\``).join("/");
      description = description.replace(
        "No spawn for quick lookup/single read.",
        `No spawn for quick lookup/single read. Check spawns via ${guidance}.`,
      );
    }
  }
  return description;
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
    const description = describeAvailableTool(tool, availableTools);
    return description === tool.description ? tool : replaceDescription(tool, description);
  });
}
