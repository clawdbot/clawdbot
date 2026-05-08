import {
  type CodexAppInventoryCache,
  type CodexAppInventoryCacheRead,
  type CodexAppInventoryRequest,
} from "./app-inventory-cache.js";
import {
  CODEX_PLUGINS_MARKETPLACE_NAME,
  resolveCodexPluginsPolicy,
  type ResolvedCodexPluginPolicy,
  type ResolvedCodexPluginsPolicy,
} from "./config.js";
import type { v2 } from "./protocol.js";

export type CodexPluginRuntimeRequest = (method: string, params?: unknown) => Promise<unknown>;

export type CodexPluginMarketplaceRef = {
  name: typeof CODEX_PLUGINS_MARKETPLACE_NAME;
  path?: string;
  remoteMarketplaceName?: string;
};

export type CodexPluginInventoryDiagnosticCode =
  | "disabled"
  | "marketplace_missing"
  | "plugin_missing"
  | "plugin_disabled"
  | "plugin_detail_unavailable"
  | "app_inventory_missing"
  | "app_inventory_stale"
  | "app_ownership_ambiguous";

export type CodexPluginInventoryDiagnostic = {
  code: CodexPluginInventoryDiagnosticCode;
  plugin?: ResolvedCodexPluginPolicy;
  message: string;
};

export type CodexPluginOwnedApp = {
  id: string;
  name: string;
  accessible: boolean;
  enabled: boolean;
  needsAuth: boolean;
};

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

export type CodexPluginInventory = {
  policy: ResolvedCodexPluginsPolicy;
  marketplace?: CodexPluginMarketplaceRef;
  records: CodexPluginInventoryRecord[];
  diagnostics: CodexPluginInventoryDiagnostic[];
  appInventory?: CodexAppInventoryCacheRead;
};

export type ReadCodexPluginInventoryParams = {
  pluginConfig?: unknown;
  policy?: ResolvedCodexPluginsPolicy;
  request: CodexPluginRuntimeRequest;
  appCache?: CodexAppInventoryCache;
  appCacheKey?: string;
  nowMs?: number;
  readPluginDetails?: boolean;
};

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
  const listed = (await params.request("plugin/list", {
    cwds: [],
  } satisfies v2.PluginListParams)) as v2.PluginListResponse;
  const marketplaceEntry = listed.marketplaces.find(
    (marketplace) => marketplace.name === CODEX_PLUGINS_MARKETPLACE_NAME,
  );
  if (!marketplaceEntry) {
    return {
      policy,
      records: [],
      diagnostics: policy.pluginPolicies
        .filter((pluginPolicy) => pluginPolicy.enabled)
        .map((pluginPolicy) => ({
          code: "marketplace_missing",
          plugin: pluginPolicy,
          message: `Codex marketplace ${CODEX_PLUGINS_MARKETPLACE_NAME} was not found.`,
        })),
      ...(appInventory ? { appInventory } : {}),
    };
  }

  const marketplace = marketplaceRef(marketplaceEntry);
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
    if (!pluginPolicy.enabled) {
      continue;
    }
    const summary = findPluginSummary(marketplaceEntry, pluginPolicy.pluginName);
    if (!summary) {
      diagnostics.push({
        code: "plugin_missing",
        plugin: pluginPolicy,
        message: `${pluginPolicy.pluginName} was not found in ${CODEX_PLUGINS_MARKETPLACE_NAME}.`,
      });
      continue;
    }

    const detail = await readPluginDetail(params, marketplace, pluginPolicy, diagnostics);
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
      detail,
      appInventory,
    });
    records.push({
      policy: pluginPolicy,
      summary,
      ...(detail ? { detail } : {}),
      activationRequired: !summary.installed || !summary.enabled,
      authRequired: apps.some((app) => app.needsAuth || !app.accessible),
      appOwnership,
      ownedAppIds,
      apps,
    });
  }

  return {
    policy,
    marketplace,
    records,
    diagnostics,
    ...(appInventory ? { appInventory } : {}),
  };
}

export function findOpenAiCuratedPluginSummary(
  listed: v2.PluginListResponse,
  pluginName: string,
): { marketplace: CodexPluginMarketplaceRef; summary: v2.PluginSummary } | undefined {
  const marketplaceEntry = listed.marketplaces.find(
    (marketplace) => marketplace.name === CODEX_PLUGINS_MARKETPLACE_NAME,
  );
  if (!marketplaceEntry) {
    return undefined;
  }
  const summary = findPluginSummary(marketplaceEntry, pluginName);
  return summary ? { marketplace: marketplaceRef(marketplaceEntry), summary } : undefined;
}

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

function readCachedAppInventory(
  params: ReadCodexPluginInventoryParams,
): CodexAppInventoryCacheRead | undefined {
  if (!params.appCache || !params.appCacheKey) {
    return undefined;
  }
  const request: CodexAppInventoryRequest = async (method, requestParams) =>
    (await params.request(method, requestParams)) as v2.AppsListResponse;
  return params.appCache.read({
    key: params.appCacheKey,
    request,
    nowMs: params.nowMs,
  });
}

async function readPluginDetail(
  params: ReadCodexPluginInventoryParams,
  marketplace: CodexPluginMarketplaceRef,
  pluginPolicy: ResolvedCodexPluginPolicy,
  diagnostics: CodexPluginInventoryDiagnostic[],
): Promise<v2.PluginDetail | undefined> {
  if (params.readPluginDetails === false) {
    return undefined;
  }
  try {
    const response = (await params.request(
      "plugin/read",
      pluginReadParams(marketplace, pluginPolicy.pluginName),
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
  detail?: v2.PluginDetail;
  appInventory?: CodexAppInventoryCacheRead;
}): CodexPluginOwnedApp[] {
  const detailApps = params.detail?.apps ?? [];
  if (detailApps.length === 0) {
    return [];
  }
  if (params.appInventory?.state === "missing") {
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
      return {
        id: app.id,
        name: app.name,
        accessible: info.isAccessible,
        enabled: info.isEnabled,
        needsAuth: app.needsAuth || !info.isAccessible,
      };
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function findPluginSummary(
  marketplace: v2.PluginMarketplaceEntry,
  pluginName: string,
): v2.PluginSummary | undefined {
  return marketplace.plugins.find(
    (plugin) =>
      plugin.name === pluginName ||
      plugin.id === pluginName ||
      plugin.id === `${pluginName}@${marketplace.name}` ||
      pluginNameFromPluginId(plugin.id, marketplace.name) === pluginName,
  );
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

function marketplaceRef(marketplace: v2.PluginMarketplaceEntry): CodexPluginMarketplaceRef {
  return {
    name: CODEX_PLUGINS_MARKETPLACE_NAME,
    ...(marketplace.path ? { path: marketplace.path } : {}),
    ...(!marketplace.path ? { remoteMarketplaceName: marketplace.name } : {}),
  };
}
