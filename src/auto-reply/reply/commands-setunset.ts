/** Shared parsing helpers for commands with set/unset subcommands. */
import { parseSlashCommandOrNull } from "./commands-slash-parse.js";
import { parseConfigValue } from "./config-value.js";

/** Parses a slash command whose actions include set/unset plus custom actions. */
export function parseSlashCommandWithSetUnset<T>(params: {
  raw: string;
  slash: string;
  invalidMessage: string;
  usageMessage: string;
  onKnownAction: (action: string, args: string) => T | undefined;
  onSet: (path: string, value: unknown) => T;
  onUnset: (path: string) => T;
  onError: (message: string) => T;
}): T | null {
  const parsed = parseSlashCommandOrNull(params.raw, params.slash, {
    invalidMessage: params.invalidMessage,
  });
  if (!parsed) {
    return null;
  }
  if (!parsed.ok) {
    return params.onError(parsed.message);
  }
  const { action } = parsed;
  const args = parsed.args.trim();
  if (action === "unset") {
    return args ? params.onUnset(args) : params.onError(`Usage: ${params.slash} unset path`);
  }
  if (action === "set") {
    const equalsIndex = args.indexOf("=");
    const path = equalsIndex > 0 ? args.slice(0, equalsIndex).trim() : "";
    if (!path) {
      return params.onError(`Usage: ${params.slash} set path=value`);
    }
    const value = parseConfigValue(args.slice(equalsIndex + 1));
    return value.error ? params.onError(value.error) : params.onSet(path, value.value);
  }
  const knownAction = params.onKnownAction(action, args);
  if (knownAction) {
    return knownAction;
  }
  return params.onError(params.usageMessage);
}
