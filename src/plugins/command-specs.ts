import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import { resolveReadOnlyChannelCommandDefaults } from "../channels/plugins/read-only-command-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { pluginCommandSupportsChannel } from "./command-registration.js";
import { pluginCommands } from "./command-registry-state.js";
import type { OpenClawPluginCommandDefinition } from "./types.js";

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
  return command.name;
}

export function getPluginCommandSpecs(
  provider?: string,
  options: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    workspaceDir?: string;
    config?: OpenClawConfig;
  } = {},
): Array<{
  name: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  acceptsArgs: boolean;
}> {
  const providerName = normalizeOptionalLowercaseString(provider);
  const commandDefaults =
    providerName && options.config
      ? resolveReadOnlyChannelCommandDefaults(providerName, {
          ...options,
          config: options.config,
        })
      : undefined;
  if (
    providerName &&
    (getLoadedChannelPlugin(providerName)?.commands ?? commandDefaults)
      ?.nativeCommandsAutoEnabled !== true
  ) {
    return [];
  }
  return listProviderPluginCommandSpecs(provider);
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
    .map((cmd) => {
      const spec: {
        name: string;
        description: string;
        descriptionLocalizations?: Record<string, string>;
        acceptsArgs: boolean;
      } = {
        name: resolvePluginNativeName(cmd, provider),
        description: cmd.description,
        acceptsArgs: cmd.acceptsArgs ?? false,
      };
      if (cmd.descriptionLocalizations) {
        spec.descriptionLocalizations = cmd.descriptionLocalizations;
      }
      return spec;
    });
}
