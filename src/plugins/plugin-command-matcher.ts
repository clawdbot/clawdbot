import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import type { RegisteredPluginCommand } from "./command-registry-state.js";
import { pluginCommandSupportsChannel } from "./plugin-command-metadata.js";

type PluginCommandAliasScope = { kind: "all" } | { kind: "provider"; provider: string };

function listInvocationKeys(
  command: RegisteredPluginCommand,
  aliasScope: PluginCommandAliasScope,
): string[] {
  const keys = new Set<string>();
  const add = (value: string | undefined) => {
    const normalized = normalizeOptionalLowercaseString(value);
    if (normalized) {
      keys.add(`/${normalized}`);
    }
  };
  add(command.name);
  if (aliasScope.kind === "all") {
    for (const alias of Object.values(command.nativeNames ?? {})) {
      if (typeof alias === "string") {
        add(alias);
      }
    }
    return [...keys];
  }
  const provider = normalizeOptionalLowercaseString(aliasScope.provider);
  const providerAlias = provider ? command.nativeNames?.[provider] : undefined;
  add(typeof providerAlias === "string" ? providerAlias : command.nativeNames?.default);
  return [...keys];
}

export function matchRegisteredPluginCommand(params: {
  commands: readonly RegisteredPluginCommand[];
  commandBody: string;
  channel?: string;
  aliasScope: PluginCommandAliasScope;
}): { command: RegisteredPluginCommand; args?: string } | null {
  const trimmed = params.commandBody.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const commandMatch = trimmed.match(/^\/\s*([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!commandMatch) {
    return null;
  }
  const key = normalizeLowercaseStringOrEmpty(`/${commandMatch[1]}`);
  const alternateKeys = [key];
  if (key.includes("_")) {
    alternateKeys.push(key.replace(/_/g, "-"));
  }
  if (key.includes("-")) {
    alternateKeys.push(key.replace(/-/g, "_"));
  }
  const command = alternateKeys
    .map((candidateKey) =>
      params.commands.find(
        (candidate) =>
          pluginCommandSupportsChannel(candidate, params.channel) &&
          listInvocationKeys(candidate, params.aliasScope).includes(candidateKey),
      ),
    )
    .find((candidate): candidate is RegisteredPluginCommand => candidate !== undefined);
  if (!command) {
    return null;
  }
  const args = commandMatch[2]?.trim();
  if (args && !command.acceptsArgs) {
    return null;
  }
  return { command, args: args || undefined };
}
