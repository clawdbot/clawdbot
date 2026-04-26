import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import { resolveReadOnlyChannelCommandDefaults } from "../channels/plugins/read-only.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { listProviderPluginCommandSpecs } from "./command-registry-state.js";

export function getPluginCommandSpecs(provider?: string): Array<{
  name: string;
  description: string;
  acceptsArgs: boolean;
}> {
  const providerName = normalizeOptionalLowercaseString(provider);
  if (
    providerName &&
    (
      getLoadedChannelPlugin(providerName)?.commands ??
      resolveReadOnlyChannelCommandDefaults(providerName)
    )?.nativeCommandsAutoEnabled !== true
  ) {
    return [];
  }
  return listProviderPluginCommandSpecs(provider);
}
