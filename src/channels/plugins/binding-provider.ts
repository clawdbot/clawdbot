import type { ChannelConfiguredBindingProvider } from "./types.adapters.js";
import type { ChannelPlugin } from "./types.plugin.js";

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
