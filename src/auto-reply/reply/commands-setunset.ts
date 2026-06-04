/** Shared parsing helpers for commands with set/unset subcommands. */
import { parseSlashCommandOrNull } from "./commands-slash-parse.js";
import { parseConfigValue } from "./config-value.js";

/** Parsed set/unset action or a user-facing parse error. */
export type SetUnsetParseResult =
  | { kind: "set"; path: string; value: unknown }
  | { kind: "unset"; path: string }
  | { kind: "error"; message: string };

/** Parses `set path=value` or `unset path` command arguments. */
export function parseSetUnsetCommand(params: {
  slash: string;
  action: "set" | "unset";
  args: string;
}): SetUnsetParseResult {
  const action = params.action;
  const args = params.args.trim();
  if (action === "unset") {
    if (!args) {
      return { kind: "error", message: `Usage: ${params.slash} unset path` };
    }
    return { kind: "unset", path: args };
  }
  if (!args) {
    return { kind: "error", message: `Usage: ${params.slash} set path=value` };
  }
  const eqIndex = args.indexOf("=");
  if (eqIndex <= 0) {
    return { kind: "error", message: `Usage: ${params.slash} set path=value` };
  }
  const path = args.slice(0, eqIndex).trim();
  const rawValue = args.slice(eqIndex + 1);
  if (!path) {
    return { kind: "error", message: `Usage: ${params.slash} set path=value` };
  }
  const parsed = parseConfigValue(rawValue);
  if (parsed.error) {
    return { kind: "error", message: parsed.error };
  }
  return { kind: "set", path, value: parsed.value };
}

/** Dispatches parsed set/unset action into caller-provided callbacks. */
export function parseSetUnsetCommandAction<T>(params: {
  slash: string;
  action: string;
  args: string;
  onSet: (path: string, value: unknown) => T;
  onUnset: (path: string) => T;
  onError: (message: string) => T;
}): T | null {
  if (params.action !== "set" && params.action !== "unset") {
    return null;
  }
  const parsed = parseSetUnsetCommand({
    slash: params.slash,
    action: params.action,
    args: params.args,
  });
  if (parsed.kind === "error") {
    return params.onError(parsed.message);
  }
  return parsed.kind === "set"
    ? params.onSet(parsed.path, parsed.value)
    : params.onUnset(parsed.path);
}

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
  const { action, args } = parsed;
  const setUnset = parseSetUnsetCommandAction<T>({
    slash: params.slash,
    action,
    args,
    onSet: params.onSet,
    onUnset: params.onUnset,
    onError: params.onError,
  });
  if (setUnset) {
    return setUnset;
  }
  const knownAction = params.onKnownAction(action, args);
  if (knownAction) {
    return knownAction;
  }
  return params.onError(params.usageMessage);
}
