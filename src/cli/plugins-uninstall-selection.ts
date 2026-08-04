// Plugin uninstall id resolver for registry ids, display names, npm specs, and ClawHub specs.
import { err as resultError, ok, type Result } from "@openclaw/normalization-core/result";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import type { PluginRecord } from "../plugins/registry.js";

/** Resolve user input to the plugin id that should be removed from config/install records. */
export function resolvePluginUninstallId<
  TPlugin extends Pick<PluginRecord, "id" | "name">,
>(params: {
  rawId: string;
  config: OpenClawConfig;
  plugins: TPlugin[];
}): Result<{ pluginId: string; plugin?: TPlugin }, string> {
  const rawId = params.rawId.trim();
  const pluginConfig = params.config.plugins;
  const installs = pluginConfig?.installs ?? {};
  const resolveInstalledPlugin = (pluginId: string) => {
    const plugin = params.plugins.find((entry) => entry.id === pluginId);
    return plugin ? { pluginId, plugin } : { pluginId };
  };
  const exactPlugin = params.plugins.find((entry) => entry.id === rawId);
  if (exactPlugin) {
    return ok({ pluginId: exactPlugin.id, plugin: exactPlugin });
  }
  // Config records and stale policy references are canonical ids, never display-name aliases.
  if (
    Object.hasOwn(installs, rawId) ||
    Object.hasOwn(pluginConfig?.entries ?? {}, rawId) ||
    pluginConfig?.allow?.includes(rawId) ||
    pluginConfig?.deny?.includes(rawId) ||
    pluginConfig?.slots?.memory === rawId ||
    pluginConfig?.slots?.contextEngine === rawId
  ) {
    return ok(resolveInstalledPlugin(rawId));
  }

  const matchingPluginIds = new Set(
    params.plugins.filter((plugin) => plugin.name === rawId).map((plugin) => plugin.id),
  );
  for (const [pluginId, install] of Object.entries(installs)) {
    if (
      install.spec === rawId ||
      install.resolvedSpec === rawId ||
      install.resolvedName === rawId ||
      install.marketplacePlugin === rawId
    ) {
      matchingPluginIds.add(pluginId);
    }
  }

  const requestedClawHub = parseClawHubPluginSpec(rawId);
  if (requestedClawHub) {
    for (const [pluginId, install] of Object.entries(installs)) {
      const installedClawHubName =
        install.clawhubPackage ??
        parseClawHubPluginSpec(install.spec ?? "")?.name ??
        parseClawHubPluginSpec(install.resolvedSpec ?? "")?.name;
      if (installedClawHubName === requestedClawHub.name) {
        matchingPluginIds.add(pluginId);
      }
    }
  }

  if (matchingPluginIds.size > 1) {
    const matches = [...matchingPluginIds].toSorted().join(", ");
    return resultError(
      `Plugin uninstall target "${rawId}" is ambiguous; matches: ${matches}. Use an exact plugin id.`,
    );
  }
  const [matchedPluginId] = matchingPluginIds;
  return ok(resolveInstalledPlugin(matchedPluginId ?? rawId));
}
