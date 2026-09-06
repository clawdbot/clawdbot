// Canonical join between ClawHub discovery identity and Gateway-owned runtime state.
import type {
  PluginCatalogEntry,
  PluginDiscoveryEntry,
  PluginDiscoveryLocalFacts,
  PluginsListResult,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import type { ClawHubPluginCatalogEntry } from "../infra/clawhub-plugin-catalog.js";

const DISCOVERY_ID_PREFIX = "ch_";
const DISCOVERY_ID_PAYLOAD = /^[A-Za-z0-9_-]+$/u;

function normalizedAlias(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLocaleLowerCase();
  return normalized || undefined;
}

function localAliases(plugin: PluginCatalogEntry): string[] {
  const aliases = [plugin.id, plugin.packageName];
  if (plugin.install?.source === "clawhub") {
    aliases.push(plugin.install.packageName);
  }
  return aliases.flatMap((value) => {
    const normalized = normalizedAlias(value);
    return normalized ? [normalized] : [];
  });
}

function indexLocalPlugins(
  plugins: readonly PluginCatalogEntry[],
): Map<string, PluginCatalogEntry> {
  const index = new Map<string, PluginCatalogEntry>();
  for (const plugin of plugins) {
    for (const alias of localAliases(plugin)) {
      index.set(alias, plugin);
    }
  }
  return index;
}

function findLocalPlugin(
  plugin: ClawHubPluginCatalogEntry,
  index: ReadonlyMap<string, PluginCatalogEntry>,
): PluginCatalogEntry | undefined {
  for (const alias of [plugin.runtimeId, plugin.packageName]) {
    const normalized = normalizedAlias(alias);
    const match = normalized ? index.get(normalized) : undefined;
    if (match) {
      return match;
    }
  }
  return undefined;
}

function projectLocalFacts(
  plugin: PluginCatalogEntry | undefined,
  mutationAllowed: boolean,
): PluginDiscoveryLocalFacts {
  if (!plugin) {
    return {
      present: false,
      installed: false,
      enabled: false,
      state: "not-installed",
      action: mutationAllowed ? "install" : "unavailable",
    };
  }
  return {
    present: true,
    installed: plugin.installed,
    enabled: plugin.enabled,
    state: plugin.state,
    pluginId: plugin.id,
    action: plugin.installed ? "manage" : mutationAllowed ? "install" : "unavailable",
  };
}

/** URL-safe route identity. Package aliases remain private to the Gateway join. */
function encodePluginDiscoveryId(packageName: string): string {
  const normalized = packageName.trim();
  if (!normalized) {
    throw new Error("Cannot encode an empty ClawHub package identity.");
  }
  return `${DISCOVERY_ID_PREFIX}${Buffer.from(normalized, "utf8").toString("base64url")}`;
}

export function decodePluginDiscoveryId(id: string): string | undefined {
  if (!id.startsWith(DISCOVERY_ID_PREFIX)) {
    return undefined;
  }
  const payload = id.slice(DISCOVERY_ID_PREFIX.length);
  if (!payload || !DISCOVERY_ID_PAYLOAD.test(payload)) {
    return undefined;
  }
  try {
    const packageName = Buffer.from(payload, "base64url").toString("utf8");
    return encodePluginDiscoveryId(packageName) === id ? packageName : undefined;
  } catch {
    return undefined;
  }
}

export function joinClawHubPluginCatalog(params: {
  remote: readonly ClawHubPluginCatalogEntry[];
  local: PluginsListResult;
}): PluginDiscoveryEntry[] {
  const localIndex = indexLocalPlugins(params.local.plugins);
  return params.remote.map((plugin) => {
    const localPlugin = findLocalPlugin(plugin, localIndex);
    return {
      id: encodePluginDiscoveryId(plugin.packageName),
      catalog: {
        name: plugin.displayName,
        ...(plugin.summary ? { summary: plugin.summary } : {}),
        family: plugin.family,
        ...(plugin.ownerHandle ? { author: plugin.ownerHandle } : {}),
        official: plugin.isOfficial,
        categories: plugin.categories,
        ...(plugin.latestVersion ? { latestVersion: plugin.latestVersion } : {}),
        ...(plugin.downloads !== undefined ? { downloads: plugin.downloads } : {}),
        ...(plugin.installs !== undefined ? { installs: plugin.installs } : {}),
        ...(plugin.verificationTier ? { verificationTier: plugin.verificationTier } : {}),
      },
      local: projectLocalFacts(localPlugin, params.local.mutationAllowed),
    };
  });
}
