import { CODEX_PLUGINS_MARKETPLACE_NAME } from "./app-server/config.js";
import { isOpenAiCuratedMarketplaceName } from "./app-server/plugin-inventory.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import {
  parseCodexPluginMarketplaceId,
  type CodexAvailablePlugin,
} from "./plugin-marketplace-discovery.js";

export type CodexPluginConfigEntry = {
  enabled?: boolean;
  marketplaceName?: string;
  pluginName?: string;
  allow_destructive_actions?: boolean | "auto" | "ask";
};

export type CodexPluginsConfigBlock = {
  enabled?: boolean;
  plugins?: Record<string, CodexPluginConfigEntry>;
};

/** Config IO shared by command handlers and their scoped runtime. */
export type CodexPluginsManagementIO = {
  readConfig: () => Promise<{
    enabled?: boolean;
    plugins?: Record<string, CodexPluginConfigEntry>;
  }>;
  mutate: (update: (block: CodexPluginsConfigBlock) => void) => Promise<void>;
};

type ConfiguredPluginKeyResolution =
  | { status: "matched"; configKey: string }
  | { status: "missing" }
  | { status: "ambiguous" }
  | { status: "mismatched" };

/** Merge historical curated wire aliases only when they identify the same install source. */
export function resolveCuratedMarketplaceAliases(
  plugins: readonly CodexAvailablePlugin[],
  requestedMarketplaceName: string,
): CodexAvailablePlugin | undefined {
  if (!isOpenAiCuratedMarketplaceName(requestedMarketplaceName)) {
    return undefined;
  }
  const sourceIdentities = new Set(
    plugins.map((plugin) =>
      plugin.marketplacePath
        ? `local:${plugin.marketplacePath}`
        : plugin.remotePluginId
          ? `remote:${plugin.remotePluginId}`
          : undefined,
    ),
  );
  if (sourceIdentities.size !== 1 || sourceIdentities.has(undefined)) {
    return undefined;
  }
  const selected =
    plugins.find((plugin) => plugin.marketplaceName === requestedMarketplaceName) ?? plugins[0];
  if (!selected) {
    return undefined;
  }
  return {
    ...selected,
    installed: plugins.some((plugin) => plugin.installed),
    enabled: plugins.some((plugin) => plugin.installed && plugin.enabled),
    available: plugins.every((plugin) => plugin.available),
    ...(selected.remotePluginId
      ? {
          mustShowInstallationInterstitial: plugins.some(
            (plugin) => plugin.mustShowInstallationInterstitial === true,
          )
            ? true
            : plugins.every((plugin) => plugin.mustShowInstallationInterstitial === false)
              ? false
              : null,
        }
      : {}),
    ...(plugins.some((plugin) => plugin.installPolicy === "NOT_AVAILABLE")
      ? { installPolicy: "NOT_AVAILABLE" }
      : {}),
  };
}

export function persistedPluginName(plugin: CodexAvailablePlugin): string {
  return !plugin.marketplacePath && plugin.summaryId.endsWith(`@${plugin.marketplaceName}`)
    ? plugin.summaryId
    : plugin.pluginName;
}

export function resolveConfiguredPluginKey(
  plugins: Record<string, CodexPluginConfigEntry>,
  target: string,
): ConfiguredPluginKeyResolution {
  const requested = parseCodexPluginMarketplaceId(target);
  const direct = plugins[target];
  if (!requested) {
    if (!direct) {
      return { status: "missing" };
    }
    const qualifiedName = direct.pluginName
      ? parseCodexPluginMarketplaceId(direct.pluginName)
      : undefined;
    if (
      qualifiedName &&
      direct.marketplaceName &&
      !marketplaceNamesRepresentSameCatalog(qualifiedName.marketplaceName, direct.marketplaceName)
    ) {
      return { status: "mismatched" };
    }
    const identity = resolveConfiguredPluginIdentity(direct);
    if (!identity) {
      return { status: "matched", configKey: target };
    }
    const marketplaceName = isOpenAiCuratedMarketplaceName(identity.marketplaceName)
      ? CODEX_PLUGINS_MARKETPLACE_NAME
      : identity.marketplaceName;
    const canonicalId = `${identity.pluginName}@${marketplaceName}`;
    const canonical = plugins[canonicalId];
    if (canonical && !matchesConfiguredPluginIdentity(canonical, identity, canonicalId)) {
      return { status: "mismatched" };
    }
    const matching = Object.values(plugins).filter((entry) =>
      matchesConfiguredPluginIdentity(entry, identity, canonicalId),
    );
    return matching.length > 1 ? { status: "ambiguous" } : { status: "matched", configKey: target };
  }
  if (direct && !matchesConfiguredPluginIdentity(direct, requested, target)) {
    return { status: "mismatched" };
  }
  const matching = Object.entries(plugins).filter(([, entry]) =>
    matchesConfiguredPluginIdentity(entry, requested, target),
  );
  if (matching.length > 1) {
    return { status: "ambiguous" };
  }
  const configKey = matching[0]?.[0];
  return configKey ? { status: "matched", configKey } : { status: "missing" };
}

export function resolveInstalledPluginKey(
  plugins: Record<string, CodexPluginConfigEntry>,
  plugin: CodexAvailablePlugin,
): ConfiguredPluginKeyResolution {
  const discovered = resolveConfiguredPluginKey(plugins, plugin.id);
  if (discovered.status === "ambiguous" || discovered.status === "mismatched") {
    return discovered;
  }
  if (!isOpenAiCuratedMarketplaceName(plugin.marketplaceName)) {
    return discovered;
  }
  const canonicalId = `${plugin.pluginName}@${CODEX_PLUGINS_MARKETPLACE_NAME}`;
  const canonical = resolveConfiguredPluginKey(plugins, canonicalId);
  if (canonical.status === "ambiguous" || canonical.status === "mismatched") {
    return canonical;
  }
  if (
    discovered.status === "matched" &&
    canonical.status === "matched" &&
    discovered.configKey !== canonical.configKey
  ) {
    return { status: "ambiguous" };
  }
  return canonical.status === "matched" ? canonical : discovered;
}

function resolveConfiguredPluginIdentity(
  entry: CodexPluginConfigEntry,
): { pluginName: string; marketplaceName: string } | undefined {
  if (!entry.pluginName || !entry.marketplaceName) {
    return undefined;
  }
  const qualified = parseCodexPluginMarketplaceId(entry.pluginName);
  if (qualified) {
    return marketplaceNamesRepresentSameCatalog(qualified.marketplaceName, entry.marketplaceName)
      ? { pluginName: qualified.pluginName, marketplaceName: entry.marketplaceName }
      : undefined;
  }
  return parseCodexPluginMarketplaceId(`${entry.pluginName}@${entry.marketplaceName}`);
}

export function matchesConfiguredPluginIdentity(
  entry: CodexPluginConfigEntry,
  requested: { pluginName: string; marketplaceName: string },
  target: string,
): boolean {
  const configuredName = entry.pluginName
    ? parseCodexPluginMarketplaceId(entry.pluginName)
    : undefined;
  return (
    typeof entry.marketplaceName === "string" &&
    marketplaceNamesRepresentSameCatalog(entry.marketplaceName, requested.marketplaceName) &&
    (entry.pluginName === requested.pluginName ||
      entry.pluginName === target ||
      (configuredName?.pluginName === requested.pluginName &&
        marketplaceNamesRepresentSameCatalog(
          configuredName.marketplaceName,
          requested.marketplaceName,
        )))
  );
}

export function marketplaceNamesRepresentSameCatalog(left: string, right: string): boolean {
  return (
    left === right ||
    (isOpenAiCuratedMarketplaceName(left) && isOpenAiCuratedMarketplaceName(right))
  );
}

export function describeConfiguredPluginIdentityConflict(
  target: string,
  status: "ambiguous" | "mismatched",
): string {
  const identity = formatCodexDisplayText(target);
  return status === "ambiguous"
    ? `Multiple configured Codex plugins match '${identity}'; resolve duplicate plugin policies first.`
    : `Configured Codex plugin key '${identity}' points to a different plugin identity; resolve the configuration conflict first.`;
}
