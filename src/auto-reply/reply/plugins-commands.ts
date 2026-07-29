// Provides plugin command discovery and handler registration helpers.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";

/** Parsed `/plugins` command variants accepted by auto-reply command handling. */
type PluginsCommand =
  | { action: "list" }
  | { action: "inspect"; name?: string }
  | { action: "install"; force: boolean; spec: string }
  | { action: "enable"; name: string }
  | { action: "disable"; name: string }
  | { action: "error"; message: string };

/** Parses a `/plugin` or `/plugins` command into a closed command action. */
export function parsePluginsCommand(raw: string): PluginsCommand | null {
  const match = raw.match(/^\/plugins?(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }

  const tail = normalizeOptionalString(match?.[1]) ?? "";
  if (!tail) {
    return { action: "list" };
  }

  const [rawAction, ...rest] = tail.split(/\s+/);
  const action = normalizeOptionalLowercaseString(rawAction);
  const name = rest.join(" ").trim();

  if (action === "list") {
    return name
      ? {
          action: "error",
          message: "Usage: /plugins list|inspect|show|get|enable|disable [plugin]",
        }
      : { action: "list" };
  }

  if (action === "inspect" || action === "show" || action === "get") {
    return { action: "inspect", name: name || undefined };
  }

  if (action === "install" || action === "add") {
    const force = rest.at(-1) === "--force";
    const specParts = force ? rest.slice(0, -1) : rest;
    const hasMisplacedForce = specParts.includes("--force");
    const spec = specParts.join(" ").trim();
    if (!spec || hasMisplacedForce) {
      return {
        action: "error",
        message:
          "Usage: /plugins install <path|archive|npm-spec|npm-pack:path|git:repo|clawhub:pkg> [--force]",
      };
    }
    return { action: "install", force, spec };
  }

  if (action === "enable" || action === "disable") {
    if (!name) {
      return {
        action: "error",
        message: `Usage: /plugins ${action} <plugin-id-or-name>`,
      };
    }
    return { action, name };
  }

  return {
    action: "error",
    message: "Usage: /plugins list|inspect|show|get|install|enable|disable [plugin]",
  };
}
