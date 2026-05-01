import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

export type PluginsCommand =
  | { action: "list" }
  | { action: "inspect"; name?: string }
  | { action: "install"; spec: string }
  | { action: "enable"; name: string }
  | { action: "disable"; name: string }
  | { action: "error"; message: string };

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
    if (!name) {
      return {
        action: "error",
        message: "Usage: /plugins install <path|archive|npm-spec|git:repo|clawhub:pkg>",
      };
    }
    return { action: "install", spec: name };
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
