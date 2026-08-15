import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { CliCatalogNodeCommand } from "../cli-catalog-overlay/node-commands.js";
import type { CliCatalogPluginCommand } from "../cli-catalog-overlay/plugin-commands.js";
import { listCommandPromptSurfaces } from "../cli-catalog-overlay/prompt-projection.js";

export type CommandInventoryPromptInput = {
  pluginCommands?: readonly CliCatalogPluginCommand[];
  promptPluginIds?: ReadonlySet<string>;
  nodeCommands?: readonly CliCatalogNodeCommand[];
  scope?: "default" | "node-operator";
};

const MAX_COMMAND_INVENTORY_PROMPT_CHARS = 1800;

function formatSurfaceLine(surface: {
  id: string;
  kind: string;
  target: string;
  commandHints: readonly string[];
  risk: string;
  confirmationRequired: boolean;
}): string {
  const routing =
    surface.kind === "node-command" && surface.commandHints.length > 0
      ? ` via=${surface.commandHints.join(" | ")}`
      : "";
  return `- ${surface.id}->${surface.target}${routing} risk=${surface.risk} confirmation=${surface.confirmationRequired ? "user" : "none"}`;
}

function appendWithinBudget(lines: string[], nextLine: string, maxChars: number): boolean {
  const separatorChars = lines.length === 0 ? 0 : 1;
  const remaining = maxChars - lines.join("\n").length - separatorChars;
  if (remaining <= 0) {
    return false;
  }
  lines.push(truncateUtf16Safe(nextLine, remaining));
  return nextLine.length <= remaining;
}

export function buildCommandInventoryPromptSection(
  params: {
    availableTools?: ReadonlySet<string>;
    hostCliAvailable?: boolean;
  } & CommandInventoryPromptInput = {},
): string[] {
  const includeHostCli =
    params.hostCliAvailable !== false &&
    (!params.availableTools || params.availableTools.has("exec"));
  const includeNodeCommands = !params.availableTools || params.availableTools.has("nodes");
  const surfaces = listCommandPromptSurfaces({
    includeHostCli,
    pluginCommands: params.pluginCommands,
    promptPluginIds: params.promptPluginIds,
    nodeCommands: includeNodeCommands ? params.nodeCommands : [],
    scope: params.scope,
  });
  if (surfaces.length === 0) {
    return [];
  }
  const lines = [
    "## OpenClaw Commands",
    "Use these existing commands for bounded operational requests instead of inventing a new flow.",
    "Do not run commands marked confirmation=user until the user explicitly confirms the action.",
  ];
  for (const surface of surfaces) {
    if (
      !appendWithinBudget(lines, formatSurfaceLine(surface), MAX_COMMAND_INVENTORY_PROMPT_CHARS)
    ) {
      break;
    }
  }
  if (lines.join("\n").length < MAX_COMMAND_INVENTORY_PROMPT_CHARS) {
    lines.push("");
  }
  return lines;
}
