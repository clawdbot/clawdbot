// Provides plugin command discovery and handler registration helpers.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";

/** Parsed `/plugins` command variants accepted by auto-reply command handling. */
type PluginsCommand =
  | { action: "list" }
  | { action: "inspect"; name?: string }
  | { action: "install"; acceptCapabilities: boolean; force: boolean; spec: string }
  | { action: "enable"; acceptCapabilities: boolean; name: string }
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
    const specParts = [...rest];
    let force = false;
    let acceptCapabilities = false;
    while (specParts.length > 0) {
      const flag = specParts.at(-1);
      if (flag === "--force" && !force) {
        force = true;
      } else if (flag === "--accept-capabilities" && !acceptCapabilities) {
        acceptCapabilities = true;
      } else {
        break;
      }
      specParts.pop();
    }
    const hasMisplacedFlag = specParts.some(
      (part) => part === "--force" || part === "--accept-capabilities",
    );
    const spec = specParts.join(" ").trim();
    if (!spec || hasMisplacedFlag) {
      return {
        action: "error",
        message:
          "Usage: /plugins install <path|archive|npm-spec|npm-pack:path|git:repo|clawhub:pkg> [--force] [--accept-capabilities]",
      };
    }
    return { action: "install", acceptCapabilities, force, spec };
  }

  if (action === "enable") {
    const acceptCapabilities = rest.at(-1) === "--accept-capabilities";
    const nameParts = acceptCapabilities ? rest.slice(0, -1) : rest;
    const pluginName = nameParts.join(" ").trim();
    if (!pluginName || nameParts.includes("--accept-capabilities")) {
      return {
        action: "error",
        message: "Usage: /plugins enable <plugin-id-or-name> [--accept-capabilities]",
      };
    }
    return { action, acceptCapabilities, name: pluginName };
  }

  if (action === "disable") {
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
