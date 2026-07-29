// Implements MCP server command parsing and persisted enablement settings.
import { parseStandardSetUnsetSlashCommand } from "./commands-setunset-standard.js";

type McpCommand =
  | { action: "show"; name?: string }
  | { action: "set"; name: string; value: unknown }
  | { action: "unset"; name: string }
  | { action: "error"; message: string };

export function parseMcpCommand(raw: string): McpCommand | null {
  return parseStandardSetUnsetSlashCommand<McpCommand>({
    raw,
    slash: "/mcp",
    invalidMessage: "Invalid /mcp syntax.",
    usageMessage: "Usage: /mcp show|set|unset",
    onKnownAction: (action, args) => {
      if (action === "show" || action === "get") {
        return { action: "show", name: args || undefined };
      }
      return undefined;
    },
    onSet: (name, value) => ({ action: "set", name, value }),
    onUnset: (name) => ({ action: "unset", name }),
  });
}
