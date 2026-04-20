import { describeToolForVerbose } from "../agents/tool-description-summary.js";
import { normalizeToolName } from "../agents/tool-policy-shared.js";
import type { EffectiveToolInventoryResult } from "../agents/tools-effective-inventory.types.js";
export {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
  buildHelpMessage,
  type CommandsMessageOptions,
  type CommandsMessageResult,
} from "./command-status-builders.js";
export {
  buildStatusMessage,
  formatContextUsageShort,
  formatTokenCount,
  type StatusArgs,
} from "../status/status-message.js";

type ToolsMessageItem = {
  id: string;
  name: string;
  description: string;
  rawDescription: string;
  source: EffectiveToolInventoryResult["groups"][number]["source"];
  pluginId?: string;
  channelId?: string;
};

function sortToolsMessageItems(items: ToolsMessageItem[]): ToolsMessageItem[] {
  return items.toSorted((a, b) => a.name.localeCompare(b.name));
}

function formatCompactToolEntry(tool: ToolsMessageItem): string {
  if (tool.source === "plugin") {
    return tool.pluginId ? `${tool.id} (${tool.pluginId})` : tool.id;
  }
  if (tool.source === "channel") {
    return tool.channelId ? `${tool.id} (${tool.channelId})` : tool.id;
  }
  return tool.id;
}

function formatVerboseToolDescription(tool: ToolsMessageItem): string {
  return describeToolForVerbose({
    rawDescription: tool.rawDescription,
    fallback: tool.description,
  });
}

export function buildToolsMessage(
  result: EffectiveToolInventoryResult,
  options?: { verbose?: boolean },
): string {
  const groups = result.groups
    .map((group) => ({
      label: group.label,
      tools: sortToolsMessageItems(
        group.tools.map((tool) => ({
          id: normalizeToolName(tool.id),
          name: tool.label,
          description: tool.description || "Tool",
          rawDescription: tool.rawDescription || tool.description || "Tool",
          source: tool.source,
          pluginId: tool.pluginId,
          channelId: tool.channelId,
        })),
      ),
    }))
    .filter((group) => group.tools.length > 0);

  if (groups.length === 0) {
    const lines = [
      "No tools are available for this agent right now.",
      "",
      `Profile: ${result.profile}`,
    ];
    return lines.join("\n");
  }

  const verbose = options?.verbose === true;
  const lines = verbose
    ? ["Available tools", "", `Profile: ${result.profile}`, "What this agent can use right now:"]
    : ["Available tools", "", `Profile: ${result.profile}`];

  for (const group of groups) {
    lines.push("", group.label);
    if (verbose) {
      for (const tool of group.tools) {
        lines.push(`  ${tool.name} - ${formatVerboseToolDescription(tool)}`);
      }
      continue;
    }
    lines.push(`  ${group.tools.map((tool) => formatCompactToolEntry(tool)).join(", ")}`);
  }

  if (verbose) {
    lines.push("", "Tool availability depends on this agent's configuration.");
  } else {
    lines.push("", "Use /tools verbose for descriptions.");
  }
  return lines.join("\n");
}
