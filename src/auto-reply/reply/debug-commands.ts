// Implements debug command toggles used by maintainers during reply runs.
import { parseStandardSetUnsetSlashCommand } from "./commands-setunset-standard.js";

export type DebugCommand =
  | { action: "show" }
  | { action: "reset" }
  | { action: "set"; path: string; value: unknown }
  | { action: "unset"; path: string }
  | { action: "error"; message: string };

export function parseDebugCommand(raw: string): DebugCommand | null {
  return parseStandardSetUnsetSlashCommand<DebugCommand>({
    raw,
    slash: "/debug",
    invalidMessage: "Invalid /debug syntax.",
    usageMessage: "Usage: /debug show|set|unset|reset",
    onKnownAction: (action) => {
      if (action === "show") {
        return { action: "show" };
      }
      if (action === "reset") {
        return { action: "reset" };
      }
      return undefined;
    },
  });
}
