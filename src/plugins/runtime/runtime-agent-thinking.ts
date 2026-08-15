import type { PluginRuntime } from "./types.js";

export function resolveRuntimeThinkingCatalog(
  params: Parameters<PluginRuntime["agent"]["resolveThinkingPolicy"]>[0],
  buildConfiguredCatalog: () => Exclude<typeof params.catalog, undefined>,
) {
  if (params.catalog) {
    return params.catalog;
  }
  const configuredCatalog = buildConfiguredCatalog();
  return configuredCatalog.length > 0 ? configuredCatalog : undefined;
}
