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

export function parsePluginInvocation(commandBody: string) {
  const commandMatch = commandBody.trim().match(/^\/\s*([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!commandMatch) {
    return null;
  }
  const key = normalizeLowercaseStringOrEmpty(`/${commandMatch[1]}`);
  return {
    keys: [...new Set([key, key.replace(/_/g, "-"), key.replace(/-/g, "_")])],
    args: commandMatch[2]?.trim() || undefined,
  };
}

export function matchRegisteredPluginCommand(params: {
  commands: readonly RegisteredPluginCommand[];
  commandBody: string;
  channel?: string;
  aliasScope: PluginCommandAliasScope;
}): { command: RegisteredPluginCommand; args?: string } | null {
  const invocation = parsePluginInvocation(params.commandBody);
  if (!invocation) {
    return null;
  }
  const { keys, args } = invocation;
  for (const candidateKey of keys) {
    const command = params.commands.find(
      (candidate) =>
        pluginCommandSupportsChannel(candidate, params.channel) &&
        listInvocationKeys(candidate, params.aliasScope).includes(candidateKey),
    );
    if (command) {
      // The preferred spelling owns argument rejection; do not try another command.
      return args && !command.acceptsArgs ? null : { command, args };
    }
  }
  return null;
}
