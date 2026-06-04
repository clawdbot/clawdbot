import type { ChannelConfiguredBindingProvider } from "./types.adapters.js";
import type { ChannelPlugin } from "./types.plugin.js";

/**
 * Returns the configured binding provider exposed by a channel plugin, when present.
 */
export function resolveChannelConfiguredBindingProvider(
  plugin:
    | Pick<ChannelPlugin, "bindings">
    | {
        bindings?: ChannelConfiguredBindingProvider;
      }
    | null
    | undefined,
): ChannelConfiguredBindingProvider | undefined {
  return plugin?.bindings;
}
