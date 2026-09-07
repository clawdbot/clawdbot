import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Restore disabled search and its prior plugin enablement after setup proposes config. */
export function restoreDisabledSearchConfig(
  original: OpenClawConfig,
  result: OpenClawConfig,
  pluginId?: string,
): OpenClawConfig {
  const next: OpenClawConfig = {
    ...result,
    tools: {
      ...result.tools,
      web: { ...result.tools?.web, search: { ...result.tools?.web?.search, enabled: false } },
    },
  };

  if (!pluginId) {
    return next;
  }

  const originalPluginEntry = original.plugins?.entries?.[pluginId];
  const resultPluginEntry = next.plugins?.entries?.[pluginId];

  const nextPlugins = { ...next.plugins };

  if (Array.isArray(original.plugins?.allow)) {
    nextPlugins.allow = [...original.plugins.allow];
  } else {
    delete nextPlugins.allow;
  }

  if (resultPluginEntry || originalPluginEntry) {
    const nextEntries = {
      ...nextPlugins.entries,
    };
    const patchedEntry = { ...resultPluginEntry };
    if (typeof originalPluginEntry?.enabled === "boolean") {
      patchedEntry.enabled = originalPluginEntry.enabled;
    } else {
      delete patchedEntry.enabled;
    }
    nextEntries[pluginId] = patchedEntry;
    nextPlugins.entries = nextEntries;
  }

  return {
    ...next,
    plugins: nextPlugins,
  };
}
