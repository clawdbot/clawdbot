// Parses config command set/unset requests into typed config operations.
import { parseStandardSetUnsetSlashCommand } from "./commands-setunset-standard.js";

export type ConfigCommand =
  | { action: "show"; path?: string }
  | { action: "set"; path: string; value: unknown }
  | { action: "unset"; path: string }
  | { action: "error"; message: string };

export function parseConfigCommand(raw: string): ConfigCommand | null {
  return parseStandardSetUnsetSlashCommand<ConfigCommand>({
    raw,
    slash: "/config",
    invalidMessage: "Invalid /config syntax.",
    usageMessage: "Usage: /config show|set|unset",
    onKnownAction: (action, args) => {
      if (action === "show" || action === "get") {
        return { action: "show", path: args || undefined };
      }
      return undefined;
    },
  });
}
