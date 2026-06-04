// Normalizes plugin command specs for CLI and slash command surfaces.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import { resolveReadOnlyChannelCommandDefaults } from "../channels/plugins/read-only-command-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pluginCommandSupportsChannel } from "./command-registration.js";
import { pluginCommands } from "./command-registry-state.js";
import type { PluginCommandRegistration } from "./registry-types.js";
import type { OpenClawPluginCommandDefinition } from "./types.js";

type PluginCommandSpecOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
};

export type PluginCommandEntrySpec = {
  name: string;
  description: string;
  acceptsArgs: boolean;
  nativeName?: string;
};

function resolvePluginNativeName(
  command: OpenClawPluginCommandDefinition,
  provider?: string,
): string {
  const providerName = normalizeOptionalLowercaseString(provider);
  const providerOverride = providerName ? command.nativeNames?.[providerName] : undefined;
  if (typeof providerOverride === "string" && providerOverride.trim()) {
    return providerOverride.trim();
  }
  const defaultOverride = command.nativeNames?.default;
  if (typeof defaultOverride === "string" && defaultOverride.trim()) {
    return defaultOverride.trim();
  }
  const fallbackName = command.name.trim();
  return fallbackName || command.name;
}

function resolvePluginTextName(command: OpenClawPluginCommandDefinition): string {
  const name = command.name.trim();
  return name || command.name;
}

function pluginNativeCommandsEnabled(
  providerName: string | undefined,
  options: PluginCommandSpecOptions,
): boolean {
  if (!providerName) {
    return true;
  }
  const commandDefaults = options.config
    ? resolveReadOnlyChannelCommandDefaults(providerName, {
        ...options,
        config: options.config,
      })
    : undefined;
  return (
    (getLoadedChannelPlugin(providerName)?.commands ?? commandDefaults)
      ?.nativeCommandsAutoEnabled === true
  );
}

export function getPluginCommandSpecs(
  provider?: string,
  options: PluginCommandSpecOptions = {},
): Array<{
  name: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  acceptsArgs: boolean;
}> {
  const providerName = normalizeOptionalLowercaseString(provider);
  if (!pluginNativeCommandsEnabled(providerName, options)) {
    return [];
  }
  return listProviderPluginCommandSpecs(providerName);
}

export function getPluginCommandSpecsFromRegistrations(
  commands: readonly PluginCommandRegistration[],
  provider?: string,
  options: PluginCommandSpecOptions = {},
): Array<{
  name: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  acceptsArgs: boolean;
}> {
  const providerName = normalizeOptionalLowercaseString(provider);
  if (!pluginNativeCommandsEnabled(providerName, options)) {
    return [];
  }
  return listProviderPluginCommandSpecsFromRegistrations(commands, providerName);
}

export function getPluginCommandEntrySpecs(
  provider?: string,
  options: PluginCommandSpecOptions = {},
): PluginCommandEntrySpec[] {
  const providerName = normalizeOptionalLowercaseString(provider);
  const nativeCommandsEnabled = pluginNativeCommandsEnabled(providerName, options);
  return Array.from(pluginCommands.values())
    .map((cmd) => serializePluginCommandEntrySpec(cmd, providerName, nativeCommandsEnabled))
    .filter((spec): spec is PluginCommandEntrySpec => spec !== null);
}

export function getPluginCommandEntrySpecsFromRegistrations(
  commands: readonly PluginCommandRegistration[],
  provider?: string,
  options: PluginCommandSpecOptions = {},
): PluginCommandEntrySpec[] {
  const providerName = normalizeOptionalLowercaseString(provider);
  const nativeCommandsEnabled = pluginNativeCommandsEnabled(providerName, options);
  return commands
    .map((entry) =>
      serializePluginCommandEntrySpec(entry.command, providerName, nativeCommandsEnabled),
    )
    .filter((spec): spec is PluginCommandEntrySpec => spec !== null);
}

/** Resolve plugin command specs for a provider's native naming surface without support gating. */
export function listProviderPluginCommandSpecs(provider?: string): Array<{
  name: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  acceptsArgs: boolean;
}> {
  return Array.from(pluginCommands.values())
    .filter((cmd) => pluginCommandSupportsChannel(cmd, provider))
    .map((cmd) => serializePluginCommandSpec(cmd, provider));
}

export function listProviderPluginCommandSpecsFromRegistrations(
  commands: readonly PluginCommandRegistration[],
  provider?: string,
): Array<{
  name: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  acceptsArgs: boolean;
}> {
  return commands
    .map((entry) => entry.command)
    .filter((cmd) => pluginCommandSupportsChannel(cmd, provider))
    .map((cmd) => serializePluginCommandSpec(cmd, provider));
}

function serializePluginCommandSpec(
  cmd: OpenClawPluginCommandDefinition,
  provider?: string,
): {
  name: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  acceptsArgs: boolean;
} {
  const spec: {
    name: string;
    description: string;
    descriptionLocalizations?: Record<string, string>;
    acceptsArgs: boolean;
  } = {
    name: resolvePluginNativeName(cmd, provider),
    description: cmd.description.trim(),
    acceptsArgs: cmd.acceptsArgs ?? false,
  };
  if (cmd.descriptionLocalizations) {
    spec.descriptionLocalizations = cmd.descriptionLocalizations;
  }
  return spec;
}

function serializePluginCommandEntrySpec(
  cmd: OpenClawPluginCommandDefinition,
  provider: string | undefined,
  nativeCommandsEnabled: boolean,
): PluginCommandEntrySpec | null {
  if (!pluginCommandSupportsChannel(cmd, provider)) {
    return null;
  }
  const nativeName = nativeCommandsEnabled ? resolvePluginNativeName(cmd, provider) : undefined;
  return {
    name: resolvePluginTextName(cmd),
    description: cmd.description.trim(),
    acceptsArgs: cmd.acceptsArgs ?? false,
    ...(nativeName ? { nativeName } : {}),
  };
}
