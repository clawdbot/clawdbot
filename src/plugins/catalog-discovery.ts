// Canonical join between ClawHub discovery identity and Gateway-owned runtime state.
import type {
  PluginCatalogEntry,
  PluginDiscoveryDetail,
  PluginDiscoveryEntry,
  PluginDiscoveryLocalFacts,
  PluginsInspectResult,
  PluginsListResult,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import type {
  ClawHubPluginCatalogEntry,
  ClawHubPluginDetail,
} from "../infra/clawhub-plugin-catalog.js";

const DISCOVERY_ID_PREFIX = "ch_";
const LOCAL_DISCOVERY_ID_PREFIX = "local_";
const DISCOVERY_ID_PAYLOAD = /^[A-Za-z0-9_-]+$/u;

function normalizedAlias(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
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
  remoteInstallable = true,
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
    ...(!plugin.installed && plugin.install ? { install: plugin.install } : {}),
    action: plugin.installed
      ? "manage"
      : mutationAllowed && (remoteInstallable || plugin.install)
        ? "install"
        : "unavailable",
  };
}

/** URL-safe route identity. Package aliases remain private to the Gateway join. */
function encodeDiscoveryId(prefix: string, identity: string): string {
  const normalized = identity.trim();
  if (!normalized) {
    throw new Error("Cannot encode an empty plugin discovery identity.");
  }
  return `${prefix}${Buffer.from(normalized, "utf8").toString("base64url")}`;
}

function encodePluginDiscoveryId(packageName: string): string {
  const normalized = packageName.trim();
  if (!normalized) {
    throw new Error("Cannot encode an empty ClawHub package identity.");
  }
  return encodeDiscoveryId(DISCOVERY_ID_PREFIX, normalized);
}

function encodeLocalPluginDiscoveryId(identity: string): string {
  return encodeDiscoveryId(LOCAL_DISCOVERY_ID_PREFIX, identity);
}

export function resolvePluginDiscoveryIdentity(
  id: string,
): { origin: "clawhub" | "local"; identity: string } | undefined {
  const prefix = id.startsWith(DISCOVERY_ID_PREFIX)
    ? DISCOVERY_ID_PREFIX
    : id.startsWith(LOCAL_DISCOVERY_ID_PREFIX)
      ? LOCAL_DISCOVERY_ID_PREFIX
      : undefined;
  if (!prefix) {
    return undefined;
  }
  const payload = id.slice(prefix.length);
  if (!payload || !DISCOVERY_ID_PAYLOAD.test(payload)) {
    return undefined;
  }
  try {
    const identity = Buffer.from(payload, "base64url").toString("utf8");
    const encoded = encodeDiscoveryId(prefix, identity);
    return encoded === id
      ? { origin: prefix === DISCOVERY_ID_PREFIX ? "clawhub" : "local", identity }
      : undefined;
  } catch {
    return undefined;
  }
}

export function joinClawHubPluginCatalog(params: {
  remote: readonly ClawHubPluginCatalogEntry[];
  /** Complete ClawHub identity set used to classify unpublished bundled plugins. */
  published?: readonly ClawHubPluginCatalogEntry[];
  local: PluginsListResult;
  includeBundledOnly?: boolean;
  intent?: "all" | "bundled" | "trending" | "official" | "updated" | "featured";
  category?: string;
  query?: string;
  cursor?: string;
}): PluginDiscoveryEntry[] {
  const localIndex = indexLocalPlugins(params.local.plugins);
  const remote = params.remote.map((plugin) => {
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
        ...(plugin.iconUrl ? { imageUrl: plugin.iconUrl } : {}),
        ...(plugin.latestVersion ? { latestVersion: plugin.latestVersion } : {}),
        ...(plugin.downloads !== undefined ? { downloads: plugin.downloads } : {}),
        ...(plugin.installs !== undefined ? { installs: plugin.installs } : {}),
        ...(plugin.verificationTier ? { verificationTier: plugin.verificationTier } : {}),
        publishedToClawHub: true,
      },
      local: projectLocalFacts(localPlugin, params.local.mutationAllowed),
    };
  });
  if (!params.includeBundledOnly) {
    return remote;
  }
  const publishedLocalPlugins = new Set<PluginCatalogEntry>();
  for (const plugin of [...(params.published ?? []), ...params.remote]) {
    const localPlugin = findLocalPlugin(plugin, localIndex);
    if (localPlugin) {
      publishedLocalPlugins.add(localPlugin);
    }
  }
  const query = normalizedAlias(params.query);
  const localOnly = params.local.plugins
    .filter((plugin) => plugin.origin === "bundled" && !publishedLocalPlugins.has(plugin))
    .filter((plugin) => {
      const category = localDiscoveryCategory(plugin.category);
      if (params.category && category !== params.category) {
        return false;
      }
      if (!query) {
        return true;
      }
      return [plugin.id, plugin.packageName, plugin.name, plugin.description]
        .flatMap((value) => (value ? [value.toLowerCase()] : []))
        .some((value) => value.includes(query));
    })
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map((plugin) => projectLocalDiscoveryEntry(plugin, params.local.mutationAllowed));
  return [...localOnly, ...remote];
}

function localDiscoveryCategory(category: string | undefined): string {
  if (category === "channel") {
    return "channels";
  }
  if (category === "provider") {
    return "models";
  }
  if (category === "context-engine") {
    return "context";
  }
  if (category === "tool") {
    return "tools";
  }
  return category || "other";
}

function localDiscoveryIdentity(plugin: PluginCatalogEntry): string {
  return plugin.packageName ?? plugin.id;
}

function projectLocalDiscoveryEntry(
  plugin: PluginCatalogEntry,
  mutationAllowed: boolean,
): PluginDiscoveryEntry {
  return {
    id: encodeLocalPluginDiscoveryId(localDiscoveryIdentity(plugin)),
    catalog: {
      name: plugin.name,
      ...(plugin.description ? { summary: plugin.description } : {}),
      official: false,
      categories: [localDiscoveryCategory(plugin.category)],
      publishedToClawHub: false,
      ...(plugin.version ? { latestVersion: plugin.version } : {}),
    },
    local: projectLocalFacts(plugin, mutationAllowed, false),
  };
}

export function findLocalPluginByIdentity(
  local: PluginsListResult,
  identity: string,
): PluginCatalogEntry | undefined {
  return indexLocalPlugins(local.plugins).get(normalizedAlias(identity) ?? "");
}

export function joinLocalPluginDetail(params: {
  plugin: PluginCatalogEntry;
  local: PluginsListResult;
  inspection?: PluginsInspectResult;
}): { plugin: PluginDiscoveryEntry; detail: PluginDiscoveryDetail } {
  const plugin = projectLocalDiscoveryEntry(params.plugin, params.local.mutationAllowed);
  const inspection = params.inspection;
  return {
    plugin,
    detail: {
      origin: "local",
      ...(params.plugin.packageName ? { packageName: params.plugin.packageName } : {}),
      topics: [],
      configuration: [],
      mcpServers: inspection?.declared.mcpServers ?? [],
      skills: (inspection?.declared.skills ?? []).map((name) => ({ name })),
      versions: [],
    },
  };
}

export function joinClawHubPluginDetail(params: {
  remote: ClawHubPluginDetail;
  local: PluginsListResult;
}): { plugin: PluginDiscoveryEntry; detail: PluginDiscoveryDetail } {
  const [plugin] = joinClawHubPluginCatalog({ remote: [params.remote], local: params.local });
  if (!plugin) {
    throw new Error("ClawHub returned no plugin detail.");
  }
  const detail: PluginDiscoveryDetail = {
    origin: "clawhub",
    packageName: params.remote.packageName,
    ...(params.remote.owner ? { author: params.remote.owner } : {}),
    topics: params.remote.topics,
    ...(params.remote.createdAt !== undefined ? { createdAt: params.remote.createdAt } : {}),
    ...(params.remote.updatedAt !== undefined ? { updatedAt: params.remote.updatedAt } : {}),
    ...(params.remote.readme ? { readme: params.remote.readme } : {}),
    ...(params.remote.compatibility ? { compatibility: params.remote.compatibility } : {}),
    configuration: params.remote.configFields,
    mcpServers: params.remote.mcpServers,
    skills: params.remote.skills,
    versions: params.remote.versions,
    ...(params.remote.verification ? { verification: params.remote.verification } : {}),
    ...(params.remote.security ? { security: params.remote.security } : {}),
  };
  return { plugin, detail };
}
