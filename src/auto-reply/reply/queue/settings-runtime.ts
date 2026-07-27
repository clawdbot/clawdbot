// Resolves runtime queue settings after considering provider fallback health.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPlugin } from "../../../channels/plugins/index.js";
import { resolveQueueSettings as resolveQueueSettingsCore } from "./settings.js";
import type { QueueSettings, ResolveQueueSettingsParams } from "./types.js";

/** Resolves plugin-provided debounce defaults for a channel queue. */
function resolvePluginDebounce(channelKey: string | undefined): number | undefined {
  if (!channelKey) {
    return undefined;
  }
  const plugin = getLoadedChannelPlugin(channelKey);
  const value = plugin?.defaults?.queue?.debounceMs;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

/** Resolves queue settings with channel plugin defaults layered into core config. */
export function resolveQueueSettings(params: ResolveQueueSettingsParams): QueueSettings {
  const channelKey = normalizeOptionalLowercaseString(params.channel);
  return resolveQueueSettingsCore({
    ...params,
    pluginDebounceMs: params.pluginDebounceMs ?? resolvePluginDebounce(channelKey),
  });
}
