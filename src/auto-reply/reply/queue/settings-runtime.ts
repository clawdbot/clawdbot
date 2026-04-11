import { getChannelPlugin } from "../../../channels/plugins/index.js";
import { normalizeOptionalLowercaseString } from "../../../shared/string-coerce.js";
import { resolveQueueSettings as resolveQueueSettingsCore } from "./settings.js";
import type { QueueSettings, ResolveQueueSettingsParams } from "./types.js";

function resolvePluginDebounce(channelKey: string | undefined): number | undefined {
  if (!channelKey) {
    return undefined;
  }
  const plugin = getChannelPlugin(channelKey);
  const value = plugin?.defaults?.queue?.debounceMs;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

export function resolveQueueSettings(params: ResolveQueueSettingsParams): QueueSettings {
  const channelKey = normalizeOptionalLowercaseString(params.channel);
  return resolveQueueSettingsCore({
    ...params,
    pluginDebounceMs: params.pluginDebounceMs ?? resolvePluginDebounce(channelKey),
  });
}
