import { t } from "../../i18n/index.ts";
import type { PluginCatalogItem, PluginListResult } from "../../lib/plugins/index.ts";

export function mergePluginCatalogItem(
  current: PluginListResult | null,
  plugin: PluginCatalogItem,
): PluginListResult | null {
  if (!current) {
    return current;
  }
  const existingIndex = current.plugins.findIndex((entry) => entry.id === plugin.id);
  const plugins = [...current.plugins];
  if (existingIndex >= 0) {
    plugins[existingIndex] = plugin;
  } else {
    plugins.push(plugin);
  }
  return { ...current, plugins };
}

export function pluginMutationBlockedReason(params: {
  connected: boolean;
  hasAdminAccess: boolean;
  mutationAllowed: boolean | undefined;
}): string | null {
  if (!params.connected) {
    return t("pluginsPage.connectToChange");
  }
  if (!params.hasAdminAccess) {
    return t("pluginsPage.adminRequired");
  }
  return params.mutationAllowed === false ? t("pluginsPage.changesDisabled") : null;
}
