/**
 * Reads Codex plugin marketplace state and app inventory to decide which
 * plugin-owned apps can be exposed to a native Codex thread.
 */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  CodexAppInventoryCache,
  CodexAppInventoryCacheRead,
  CodexAppInventoryRequest,
} from "./app-inventory-cache.js";
import {
  CODEX_PLUGINS_MARKETPLACE_NAME,
  CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
  resolveCodexPluginsPolicy,
  type CodexPluginMarketplaceName,
  type ResolvedCodexPluginPolicy,
  type ResolvedCodexPluginsPolicy,
} from "./config.js";
import type {
  CodexPluginMetadataCache,
  CodexPluginMetadataQueryKind,
} from "./plugin-metadata-cache.js";
import type { CodexAppServerRequestResult, v2 } from "./protocol.js";

const CODEX_PLUGINS_REMOTE_MARKETPLACE_NAME = `${CODEX_PLUGINS_MARKETPLACE_NAME}-remote`;
// Codex serves the curated catalog under this wire name for API-key/Bedrock
// accounts (codex-rs/core-plugins is_openai_curated_marketplace_name). It is
// the same logical catalog, so configured `openai-curated` plugins resolve
// from it and marketplace refs normalize back to CODEX_PLUGINS_MARKETPLACE_NAME.
const CODEX_PLUGINS_API_MARKETPLACE_NAME = "openai-api-curated";

/** Request callback used to call Codex app-server plugin/app methods. */
export type CodexPluginRuntimeRequest = (method: string, params?: unknown) => Promise<unknown>;

type CodexPluginMarketplaceResponse = v2.PluginInstalledResponse | v2.PluginListResponse;

/** Stable reference to a supported Codex plugin marketplace. */
export type CodexPluginMarketplaceRef = {
  name: CodexPluginMarketplaceName;
  path?: string;
  remoteMarketplaceName?: string;
};

/** Machine-readable inventory diagnostic code used by thread config builders. */
type CodexPluginInventoryDiagnosticCode =
  | "disabled"
  | "marketplace_missing"
  | "plugin_missing"
  | "plugin_disabled"
  | "plugin_detail_unavailable"
  | "app_inventory_missing"
  | "app_inventory_stale"
  | "app_ownership_ambiguous";

/** Diagnostic explaining why a configured plugin or app cannot be exposed. */
export type CodexPluginInventoryDiagnostic = {
  code: CodexPluginInventoryDiagnosticCode;
  plugin?: ResolvedCodexPluginPolicy;
  message: string;
};

/** App owned by a Codex plugin with current accessibility/auth state. */
export type CodexPluginOwnedApp = {
  id: string;
  name: string;
  accessible: boolean;
  enabled: boolean;
  needsAuth: boolean;
  /** Current non-read-only tool keys; absent when Codex omits tool metadata. */
  approvalOverrideToolConfigKeys?: readonly string[];
};

/** Inventory record for one configured Codex plugin policy. */
export type CodexPluginInventoryRecord = {
  policy: ResolvedCodexPluginPolicy;
  summary: v2.PluginSummary;
  detail?: v2.PluginDetail;
  activationRequired: boolean;
  authRequired: boolean;
  appOwnership: "proven" | "ambiguous" | "none";
  ownedAppIds: string[];
  apps: CodexPluginOwnedApp[];
};

/** Complete inventory result for configured Codex plugins and owned apps. */
export type CodexPluginInventory = {
  policy: ResolvedCodexPluginsPolicy;
  records: CodexPluginInventoryRecord[];
  diagnostics: CodexPluginInventoryDiagnostic[];
  appInventory?: CodexAppInventoryCacheRead;
};

/** Inputs for reading plugin marketplace/detail state and cached app inventory. */
type ReadCodexPluginInventoryParams = {
  pluginConfig?: unknown;
  policy?: ResolvedCodexPluginsPolicy;
  request: CodexPluginRuntimeRequest;
  appCache?: CodexAppInventoryCache;
  appCacheKey?: string;
  configCwd?: string;
  metadataCache?: CodexPluginMetadataCache;
  nowMs?: number;
  readPluginDetails?: boolean;
  suppressAppInventoryRefresh?: boolean;
};

/** Reads configured Codex plugin state and maps owned apps to readiness diagnostics. */
export async function readCodexPluginInventory(
  params: ReadCodexPluginInventoryParams,
): Promise<CodexPluginInventory> {
  const policy = params.policy ?? resolveCodexPluginsPolicy(params.pluginConfig);
  if (!policy.enabled) {
    return {
      policy,
      records: [],
      diagnostics: [
        {
          code: "disabled",
          message: "Native Codex plugin support is disabled.",
        },
      ],
    };
  }

  const appInventory = readCachedAppInventory(params);
  const installedPlugins = await readInstalledCodexPluginMetadata({ ...params, policy });
  const pluginCatalogs = new Map<string, Promise<v2.PluginListResponse>>();

  const diagnostics: CodexPluginInventoryDiagnostic[] = [];
  const records: CodexPluginInventoryRecord[] = [];
  if (appInventory?.state === "missing") {
    diagnostics.push({
      code: "app_inventory_missing",
      message: "Cached Codex app inventory is missing; plugin apps are excluded for this setup.",
    });
  } else if (appInventory?.state === "stale") {
    diagnostics.push({
      code: "app_inventory_stale",
      message: "Cached Codex app inventory is stale; using stale app readiness and refreshing.",
    });
  }

  for (const pluginPolicy of policy.pluginPolicies) {
    if (!pluginPolicy.enabled && !policy.allowAllPlugins) {
      continue;
    }
    let listed: CodexPluginMarketplaceResponse = installedPlugins;
    let resolvedPlugin = findConfiguredMarketplacePlugin(listed, pluginPolicy);
    if (
      !resolvedPlugin &&
      pluginPolicy.enabled &&
      pluginPolicy.marketplaceName !== CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME
    ) {
      // Installed snapshots exclude uninstalled plugins. Read only the
      // explicitly configured marketplace; non-curated packages still require
      // an owner-issued install command before they can be activated.
      const requestParams = buildPluginCatalogRequestParams(params, pluginPolicy.marketplaceName);
      const catalogKey = JSON.stringify([
        requestParams,
        pluginMetadataCatalogScope(pluginPolicy.marketplaceName),
      ]);
      let catalog = pluginCatalogs.get(catalogKey);
      if (!catalog) {
        catalog = listCodexPluginMetadata(params, pluginPolicy.marketplaceName);
        pluginCatalogs.set(catalogKey, catalog);
      }
      listed = await catalog;
      resolvedPlugin = findConfiguredMarketplacePlugin(listed, pluginPolicy);
    }
    const hasMarketplace = listed.marketplaces.some((marketplace) =>
      marketplaceMatchesConfiguredName(marketplace, pluginPolicy.marketplaceName),
    );
    if (!hasMarketplace) {
      diagnostics.push({
        code: "marketplace_missing",
        plugin: pluginPolicy,
        message: `Codex marketplace ${pluginPolicy.marketplaceName} was not found.`,
      });
      continue;
    }
    if (!resolvedPlugin) {
      diagnostics.push({
        code: "plugin_missing",
        plugin: pluginPolicy,
        message: `${pluginPolicy.pluginName} was not found in ${pluginPolicy.marketplaceName}.`,
      });
      continue;
    }
    const { summary } = resolvedPlugin;
    const unavailableByMarketplacePolicy =
      summary.availability === "DISABLED_BY_ADMIN" || summary.installPolicy === "NOT_AVAILABLE";
    if (unavailableByMarketplacePolicy) {
      diagnostics.push({
        code: "plugin_disabled",
        plugin: pluginPolicy,
        message: `${pluginPolicy.pluginName} is unavailable in ${pluginPolicy.marketplaceName}.`,
      });
      if (!summary.installed) {
        continue;
      }
    }
    const pluginMarketplace = marketplaceRef(
      resolvedPlugin.marketplace,
      pluginPolicy.marketplaceName,
    );
    const detail = await readPluginDetail(
      params,
      pluginMarketplace,
      pluginPolicy,
      summary,
      diagnostics,
    );
    const ownedAppIds =
      detail?.apps
        .map((app) => app.id)
        .filter(Boolean)
        .toSorted() ?? [];
    const appOwnership = resolveAppOwnership({
      detail,
      appInventory,
      summary,
    });
    if (appOwnership === "ambiguous") {
      diagnostics.push({
        code: "app_ownership_ambiguous",
        plugin: pluginPolicy,
        message: `${pluginPolicy.pluginName} has only display-name app matches; apps are not exposed until ownership is stable.`,
      });
    }
    if (summary.installed && !summary.enabled) {
      diagnostics.push({
        code: "plugin_disabled",
        plugin: pluginPolicy,
        message: `${pluginPolicy.pluginName} is installed in Codex but disabled.`,
      });
    }

    const apps = resolveOwnedApps({
      pluginPolicy,
      detail,
      appInventory,
    });
    records.push({
      policy: pluginPolicy,
      summary,
      ...(detail ? { detail } : {}),
      activationRequired:
        pluginPolicy.enabled &&
        (unavailableByMarketplacePolicy || !summary.installed || !summary.enabled),
      authRequired: apps.some((app) => app.needsAuth || !app.accessible),
      appOwnership,
      ownedAppIds,
      apps,
    });
  }

  const inventory = {
    policy,
    records,
    diagnostics,
    ...(appInventory ? { appInventory } : {}),
  };
  return inventory;
}

/** Finds a configured plugin only in its authorized marketplace identity. */
export function findCodexMarketplacePluginSummary(
  listed: CodexPluginMarketplaceResponse,
  marketplaceName: CodexPluginMarketplaceName,
  pluginName: string,
): { marketplace: CodexPluginMarketplaceRef; summary: v2.PluginSummary } | undefined {
  const resolved = findConfiguredMarketplacePlugin(listed, { marketplaceName, pluginName });
  return resolved
    ? {
        marketplace: marketplaceRef(resolved.marketplace, marketplaceName),
        summary: resolved.summary,
      }
    : undefined;
}

/** Builds plugin/read or plugin/install params from a marketplace reference. */
export function pluginReadParams(
  marketplace: CodexPluginMarketplaceRef,
  pluginName: string,
): v2.PluginReadParams {
  return {
    ...(marketplace.path ? { marketplacePath: marketplace.path } : {}),
    ...(marketplace.remoteMarketplaceName
      ? { remoteMarketplaceName: marketplace.remoteMarketplaceName }
      : {}),
    pluginName,
  };
}

/** Returns configured plugin keys whose current metadata may still recover. */
export function resolveRecoverableCodexPluginConfigKeys(params: {
  policy: ResolvedCodexPluginsPolicy;
  metadataCache: CodexPluginMetadataCache;
  appCacheKey: string;
  configCwd?: string;
}): string[] {
  return params.policy.pluginPolicies
    .filter(
      (pluginPolicy) =>
        pluginPolicy.enabled &&
        !isSettledMissingPluginPolicy({
          pluginPolicy,
          metadataCache: params.metadataCache,
          appCacheKey: params.appCacheKey,
          configCwd: params.configCwd,
        }),
    )
    .map((pluginPolicy) => pluginPolicy.configKey)
    .toSorted();
}

async function listCodexPluginMetadata(
  params: ReadCodexPluginInventoryParams,
  marketplaceName: CodexPluginMarketplaceName,
): Promise<v2.PluginListResponse> {
  const requestParams = buildPluginCatalogRequestParams(params, marketplaceName);
  if (!params.metadataCache || !params.appCacheKey) {
    return (await params.request("plugin/list", requestParams)) as v2.PluginListResponse;
  }
  const snapshot = await params.metadataCache.load({
    appCacheKey: params.appCacheKey,
    queryKind: "curated-global",
    requestParams,
    catalogScope: pluginMetadataCatalogScope(marketplaceName),
    request: async (method, listedParams) =>
      (await params.request(method, listedParams)) as v2.PluginListResponse,
    // Upstream can fail open to local-only results when fetching remote
    // catalogs. Never settle a negative without the requested marketplace.
    cacheable: (response: v2.PluginListResponse) =>
      response.marketplaces.some((marketplace) =>
        marketplaceMatchesConfiguredName(marketplace, marketplaceName),
      ),
  });
  return snapshot.response;
}

async function readInstalledCodexPluginMetadata(
  params: ReadCodexPluginInventoryParams & { policy: ResolvedCodexPluginsPolicy },
): Promise<v2.PluginInstalledResponse> {
  const requestParams = (
    params.configCwd ? { cwds: [params.configCwd] } : {}
  ) satisfies v2.PluginInstalledParams;
  if (!params.metadataCache || !params.appCacheKey) {
    return (await params.request("plugin/installed", requestParams)) as v2.PluginInstalledResponse;
  }
  const snapshot = await params.metadataCache.load({
    appCacheKey: params.appCacheKey,
    queryKind: "installed",
    requestParams,
    request: async (method, installedParams) =>
      (await params.request(method, installedParams)) as v2.PluginInstalledResponse,
    // Codex can fail open to local-only marketplaces when its remote installed
    // fetch fails. Never settle a snapshot that cannot prove a configured owner.
    cacheable: (response) =>
      params.policy.pluginPolicies.every((pluginPolicy) => {
        if (!pluginPolicy.enabled && !params.policy.allowAllPlugins) {
          return true;
        }
        return Boolean(findConfiguredMarketplacePlugin(response, pluginPolicy));
      }),
  });
  return snapshot.response;
}

function isSettledMissingPluginPolicy(params: {
  pluginPolicy: ResolvedCodexPluginPolicy;
  metadataCache: CodexPluginMetadataCache;
  appCacheKey: string;
  configCwd?: string;
}): boolean {
  const queryKind: CodexPluginMetadataQueryKind =
    params.pluginPolicy.marketplaceName === CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME
      ? "installed"
      : "curated-global";
  const requestParams =
    queryKind === "installed"
      ? params.configCwd
        ? { cwds: [params.configCwd] }
        : {}
      : buildPluginCatalogRequestParams(params, params.pluginPolicy.marketplaceName);
  const listed = params.metadataCache.read(
    params.appCacheKey,
    queryKind,
    requestParams,
    queryKind === "curated-global"
      ? pluginMetadataCatalogScope(params.pluginPolicy.marketplaceName)
      : undefined,
  )?.response;
  if (!listed) {
    return false;
  }
  return !findConfiguredMarketplacePlugin(listed, params.pluginPolicy);
}

function pluginMetadataCatalogScope(
  marketplaceName: CodexPluginMarketplaceName,
): string | undefined {
  return isOpenAiCuratedMarketplaceName(marketplaceName) ? undefined : marketplaceName;
}

function buildPluginCatalogRequestParams(
  params: { configCwd?: string },
  marketplaceName: CodexPluginMarketplaceName,
): v2.PluginListParams {
  const marketplaceKinds =
    marketplaceName === "created-by-me-remote"
      ? (["created-by-me-remote"] as const)
      : marketplaceName.startsWith("workspace-shared-with-me")
        ? (["shared-with-me"] as const)
        : undefined;
  return {
    ...(params.configCwd ? { cwds: [params.configCwd] } : {}),
    ...(marketplaceKinds ? { marketplaceKinds: [...marketplaceKinds] } : {}),
  } satisfies v2.PluginListParams;
}

function readCachedAppInventory(
  params: ReadCodexPluginInventoryParams,
): CodexAppInventoryCacheRead | undefined {
  if (!params.appCache || !params.appCacheKey) {
    return undefined;
  }
  const request: CodexAppInventoryRequest = async (method, requestParams) =>
    (await params.request(method, requestParams)) as CodexAppServerRequestResult<typeof method>;
  return params.appCache.read({
    key: params.appCacheKey,
    request,
    nowMs: params.nowMs,
    suppressRefresh: params.suppressAppInventoryRefresh,
  });
}

async function readPluginDetail(
  params: ReadCodexPluginInventoryParams,
  marketplace: CodexPluginMarketplaceRef,
  pluginPolicy: ResolvedCodexPluginPolicy,
  summary: v2.PluginSummary,
  diagnostics: CodexPluginInventoryDiagnostic[],
): Promise<v2.PluginDetail | undefined> {
  if (params.readPluginDetails === false) {
    return undefined;
  }
  if (marketplace.remoteMarketplaceName && !summary.remotePluginId) {
    diagnostics.push({
      code: "plugin_detail_unavailable",
      plugin: pluginPolicy,
      message: `${pluginPolicy.pluginName} detail unavailable: Codex did not return a remote plugin id.`,
    });
    return undefined;
  }
  try {
    const response = (await params.request(
      "plugin/read",
      pluginReadParams(
        marketplace,
        marketplace.remoteMarketplaceName && summary.remotePluginId
          ? summary.remotePluginId
          : pluginPolicy.pluginName,
      ),
    )) as v2.PluginReadResponse;
    return response.plugin;
  } catch (error) {
    diagnostics.push({
      code: "plugin_detail_unavailable",
      plugin: pluginPolicy,
      message: `${pluginPolicy.pluginName} detail unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return undefined;
  }
}

function resolveAppOwnership(params: {
  detail?: v2.PluginDetail;
  appInventory?: CodexAppInventoryCacheRead;
  summary: v2.PluginSummary;
}): "proven" | "ambiguous" | "none" {
  if (params.detail && params.detail.apps.length > 0) {
    return "proven";
  }
  const apps = params.appInventory?.snapshot?.apps ?? [];
  const displayMatches = apps.filter((app) =>
    app.pluginDisplayNames.some((displayName) => displayName === params.summary.name),
  );
  return displayMatches.length > 0 ? "ambiguous" : "none";
}

function resolveOwnedApps(params: {
  pluginPolicy: ResolvedCodexPluginPolicy;
  detail?: v2.PluginDetail;
  appInventory?: CodexAppInventoryCacheRead;
}): CodexPluginOwnedApp[] {
  const detailApps = params.detail?.apps ?? [];
  if (detailApps.length === 0) {
    return [];
  }
  if (params.appInventory?.state === "missing") {
    embeddedAgentLog.warn("codex plugin inventory missing app inventory for detail apps", {
      configKey: params.pluginPolicy.configKey,
      pluginName: params.pluginPolicy.pluginName,
      appIds: detailApps.map((app) => app.id).toSorted(),
    });
    return [];
  }
  const appInfoById = new Map(
    (params.appInventory?.snapshot?.apps ?? []).map((app) => [app.id, app] as const),
  );
  return detailApps
    .map((app) => {
      const info = appInfoById.get(app.id);
      if (!info) {
        return {
          id: app.id,
          name: app.name,
          accessible: false,
          enabled: false,
          needsAuth: true,
        };
      }
      return Object.assign(
        {
          id: app.id,
          name: app.name,
          accessible: info.isAccessible,
          enabled: info.isEnabled,
          // Modern plugin summaries carry no auth bit; account-authorized
          // app/read metadata is the canonical connector access proof.
          needsAuth: !info.isAccessible,
        },
        resolveOwnedAppApprovalOverrideKeys(info),
      );
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

/** Returns current tool keys whose overrides could bypass the requested reviewer. */
export function resolveOwnedAppApprovalOverrideKeys(
  app: v2.AppInfo,
): Pick<CodexPluginOwnedApp, "approvalOverrideToolConfigKeys"> {
  if (!app.toolSummaries) {
    return {};
  }
  const appName = app.name.trim();
  const appNameLower = appName.toLowerCase();
  // Agents: app/read includes disabled tools. Keep every non-read-only alias,
  // including collisions with read-only titles; retired names cannot authorize
  // a current tool and must not prevent the entire app from being admitted.
  const keys = app.toolSummaries
    .filter((tool) => !tool.isReadOnly)
    .flatMap((tool) => resolveAppToolConfigKeys({ appName, appNameLower, tool }));
  return { approvalOverrideToolConfigKeys: Array.from(new Set(keys)).toSorted() };
}

function resolveAppToolConfigKeys(params: {
  appName: string;
  appNameLower: string;
  tool: { name: string; title?: string | null };
}): string[] {
  const keys = [params.tool.name];
  if (params.tool.title) {
    keys.push(params.tool.title);
  }
  if (params.appName) {
    keys.push(`${params.appName}_${params.tool.name}`);
  }
  if (params.appNameLower && params.appNameLower !== params.appName) {
    keys.push(`${params.appNameLower}_${params.tool.name}`);
  }
  return keys;
}

function findPluginSummary(
  marketplace: v2.PluginMarketplaceEntry,
  pluginName: string,
): v2.PluginSummary | undefined {
  const exact = marketplace.plugins.find(
    (plugin) => plugin.id === pluginName || plugin.id === `${pluginName}@${marketplace.name}`,
  );
  if (exact) {
    return exact;
  }
  const matches = marketplace.plugins.filter(
    (plugin) =>
      plugin.name === pluginName ||
      pluginNameFromPluginId(plugin.id, marketplace.name) === pluginName,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function findConfiguredMarketplacePlugin(
  listed: CodexPluginMarketplaceResponse,
  plugin: Pick<ResolvedCodexPluginPolicy, "marketplaceName" | "pluginName">,
): { marketplace: v2.PluginMarketplaceEntry; summary: v2.PluginSummary } | undefined {
  if (plugin.marketplaceName === CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME) {
    return findWorkspaceMarketplacePlugin(listed, plugin.pluginName);
  }
  for (const marketplace of listed.marketplaces) {
    if (!marketplaceMatchesConfiguredName(marketplace, plugin.marketplaceName)) {
      continue;
    }
    const summary = findPluginSummary(marketplace, plugin.pluginName);
    if (summary) {
      return { marketplace, summary };
    }
  }
  return undefined;
}

function marketplaceMatchesConfiguredName(
  marketplace: v2.PluginMarketplaceEntry,
  configuredMarketplaceName: CodexPluginMarketplaceName,
): boolean {
  return isOpenAiCuratedMarketplaceName(configuredMarketplaceName)
    ? isOpenAiCuratedMarketplace(marketplace)
    : marketplace.name === configuredMarketplaceName;
}

function findWorkspaceMarketplacePlugin(
  listed: CodexPluginMarketplaceResponse,
  pluginName: string,
): { marketplace: v2.PluginMarketplaceEntry; summary: v2.PluginSummary } | undefined {
  // Workspace display names are not unique; the configured pluginName is the
  // exact catalog id returned by plugin/list.
  const marketplace = listed.marketplaces.find(
    (entry) => entry.name === CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
  );
  const summary = marketplace?.plugins.find((plugin) => plugin.id === pluginName);
  return marketplace && summary ? { marketplace, summary } : undefined;
}

function pluginNameFromPluginId(pluginId: string, marketplaceName: string): string | undefined {
  const trimmed = pluginId.trim();
  if (!trimmed) {
    return undefined;
  }
  const marketplaceSuffix = `@${marketplaceName}`;
  const withoutMarketplaceSuffix = trimmed.endsWith(marketplaceSuffix)
    ? trimmed.slice(0, -marketplaceSuffix.length)
    : trimmed;
  return withoutMarketplaceSuffix.split("/").at(-1)?.trim() || undefined;
}

function marketplaceRef(
  marketplace: v2.PluginMarketplaceEntry,
  name: CodexPluginMarketplaceName,
): CodexPluginMarketplaceRef {
  return {
    name,
    ...(marketplace.path ? { path: marketplace.path } : {}),
    ...(!marketplace.path ? { remoteMarketplaceName: marketplace.name } : {}),
  };
}

/** True for any supported OpenAI curated marketplace wire name, matching Codex's own curated predicate. */
export function isOpenAiCuratedMarketplace(marketplace: v2.PluginMarketplaceEntry): boolean {
  return isOpenAiCuratedMarketplaceName(marketplace.name);
}

/** True for all Codex wire aliases of the same OpenAI-curated catalog. */
export function isOpenAiCuratedMarketplaceName(marketplaceName: string): boolean {
  return (
    marketplaceName === CODEX_PLUGINS_MARKETPLACE_NAME ||
    marketplaceName === CODEX_PLUGINS_REMOTE_MARKETPLACE_NAME ||
    marketplaceName === CODEX_PLUGINS_API_MARKETPLACE_NAME
  );
}
