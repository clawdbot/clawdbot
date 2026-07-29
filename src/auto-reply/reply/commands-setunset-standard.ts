// Implements standard set/unset command handling for persisted config values.
import { parseSlashCommandWithSetUnset } from "./commands-setunset.js";

export function parseStandardSetUnsetSlashCommand<T>(params: {
  raw: string;
  slash: string;
  invalidMessage: string;
  usageMessage: string;
  onKnownAction: (action: string, args: string) => T | undefined;
  onSet?: (path: string, value: unknown) => T;
  onUnset?: (path: string) => T;
  onError?: (message: string) => T;
}): T | null {
  return parseSlashCommandWithSetUnset<T>({
    raw: params.raw,
    slash: params.slash,
    invalidMessage: params.invalidMessage,
    usageMessage: params.usageMessage,
    onKnownAction: params.onKnownAction,
    onSet: params.onSet ?? ((path, value) => ({ action: "set", path, value }) as T),
    onUnset: params.onUnset ?? ((path) => ({ action: "unset", path }) as T),
    onError: params.onError ?? ((message) => ({ action: "error", message }) as T),
  });
}
