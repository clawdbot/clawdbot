import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import { resolveReadOnlyChannelCommandDefaults } from "../channels/plugins/read-only-command-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { listProviderPluginCommandSpecs } from "./command-registry-state.js";

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
