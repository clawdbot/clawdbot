// Normalizes plugin web-search configuration and defaults.
import { isRecord } from "@openclaw/normalization-core/record-coerce";

type PluginWebSearchConfigCarrier = {
  plugins?: {
    entries?: Record<
      string,
      {
        config?: unknown;
      }
    >;
  };
};

/** Resolve a plugin-owned `config.webSearch` object without interpreting provider fields. */
export function resolvePluginWebSearchConfig(
  config: PluginWebSearchConfigCarrier | undefined,
  pluginId: string,
): Record<string, unknown> | undefined {
  const pluginConfig = config?.plugins?.entries?.[pluginId]?.config;
  if (!isRecord(pluginConfig)) {
    return undefined;
  }
  return isRecord(pluginConfig.webSearch) ? pluginConfig.webSearch : undefined;
}
