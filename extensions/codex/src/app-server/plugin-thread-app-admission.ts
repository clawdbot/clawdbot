import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  serializeCodexAppInventoryError,
  type CodexAppInventoryCache,
  type CodexAppInventoryRequest,
  type CodexAppInventorySnapshot,
} from "./app-inventory-cache.js";
import type { ResolvedCodexPluginsPolicy } from "./config.js";
import type {
  CodexPluginInventory,
  CodexPluginInventoryRecord,
  CodexPluginOwnedApp,
  CodexPluginRuntimeRequest,
} from "./plugin-inventory.js";
import type { CodexAppServerRequestResult } from "./protocol.js";
import { isJsonObject, type JsonObject, type v2 } from "./protocol.js";

export type CodexPluginThreadAppAdmissionDiagnostic = {
  code: "account_app_inventory_unavailable" | "account_app_config_unavailable";
  message: string;
};

type CodexPluginThreadAppAdmissionParams = {
  request: CodexPluginRuntimeRequest;
  configCwd?: string;
  appCacheKey: string;
  nowMs?: number;
};

/** Effective Codex config and active layers from one authoritative read. */
export type CodexPluginThreadAppAdmissionConfig = {
  config: JsonObject;
  layers: readonly JsonObject[];
};

export async function refreshCodexPluginAppInventory(
  params: CodexPluginThreadAppAdmissionParams,
  appCache: CodexAppInventoryCache,
  options: { forceRefetch?: boolean; reason?: string; targetAppIds?: readonly string[] } = {},
): Promise<CodexAppInventorySnapshot | undefined> {
  if (!params.appCacheKey) {
    return undefined;
  }
  const request: CodexAppInventoryRequest = async (method, requestParams) =>
    (await params.request(method, requestParams)) as CodexAppServerRequestResult<typeof method>;
  try {
    return await appCache.refreshNow({
      key: params.appCacheKey,
      request,
      nowMs: params.nowMs,
      forceRefetch: options.forceRefetch,
      targetAppIds: options.targetAppIds,
    });
  } catch (error) {
    embeddedAgentLog.warn("codex plugin thread config app inventory refresh failed", {
      reason: options.reason,
      forceRefetch: options.forceRefetch === true,
      error: serializeCodexAppInventoryError(error),
    });
    return undefined;
  }
}

export function collectCodexPluginOwnedAppIds(inventory: CodexPluginInventory): string[] {
  return Array.from(
    new Set(inventory.records.flatMap((record) => record.ownedAppIds).filter(Boolean)),
  ).toSorted();
}

export function collectCodexReservedPluginAppIds(params: {
  policy: ResolvedCodexPluginsPolicy;
  inventory: CodexPluginInventory;
  accountApps: readonly v2.AppInfo[];
}): Set<string> {
  const reserved = new Set(
    params.inventory.records.flatMap((record) =>
      record.appOwnership === "proven" ? record.ownedAppIds : [],
    ),
  );
  const recordsByConfigKey = new Map(
    params.inventory.records.map((record) => [record.policy.configKey, record] as const),
  );
  const configuredOwnerNames = new Set(
    params.policy.pluginPolicies.flatMap((policy) => {
      const record = recordsByConfigKey.get(policy.configKey);
      return [policy.configKey, policy.pluginName, record?.summary.name, record?.summary.id]
        .filter((name): name is string => Boolean(name))
        .map(normalizeCodexPluginOwnerName);
    }),
  );

  for (const app of params.accountApps) {
    if (
      app.pluginDisplayNames.some((name) =>
        configuredOwnerNames.has(normalizeCodexPluginOwnerName(name)),
      )
    ) {
      reserved.add(app.id);
    }
  }
  return reserved;
}

function normalizeCodexPluginOwnerName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export async function readCodexThreadAdmissibleAccountApps(
  params: CodexPluginThreadAppAdmissionParams,
  appCache: CodexAppInventoryCache,
): Promise<{
  apps: v2.AppInfo[];
  diagnostic?: CodexPluginThreadAppAdmissionDiagnostic;
}> {
  // Account-wide policy must use a complete snapshot; a targeted plugin read
  // cannot establish which other account apps are authorized for this thread.
  const request: CodexAppInventoryRequest = async (method, requestParams) =>
    (await params.request(method, requestParams)) as CodexAppServerRequestResult<typeof method>;
  const cachedInventory = appCache.read({
    key: params.appCacheKey,
    request,
    nowMs: params.nowMs,
    suppressRefresh: true,
  });
  const snapshot =
    cachedInventory.state === "fresh" && !cachedInventory.snapshot?.targetAppIds?.length
      ? cachedInventory.snapshot
      : await refreshCodexPluginAppInventory(params, appCache, {
          forceRefetch: false,
          reason: "account_apps_all",
          targetAppIds: [],
        });
  if (!snapshot) {
    return {
      apps: [],
      diagnostic: {
        code: "account_app_inventory_unavailable",
        message: "Codex account app inventory was unavailable; account apps were not exposed.",
      },
    };
  }
  const installedAppsById = new Map(snapshot.installedApps.map((app) => [app.id, app]));
  return {
    apps: snapshot.apps
      .filter(
        (app) =>
          resolveCodexInstalledAppThreadAdmission(
            toCodexPluginOwnedAccountApp(app),
            installedAppsById.get(app.id),
          ) !== "blocked",
      )
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  };
}

export function toCodexPluginOwnedAccountApp(app: v2.AppInfo): CodexPluginOwnedApp {
  return {
    id: app.id,
    name: app.name,
    accessible: app.isAccessible,
    enabled: app.isEnabled,
    needsAuth: !app.isAccessible,
  };
}

export function resolveCodexThreadConfigAppsForRecord(params: {
  record: CodexPluginInventoryRecord;
  inventory: CodexPluginInventory;
}): CodexPluginOwnedApp[] {
  return params.inventory.appInventory?.state === "missing" ? [] : params.record.apps;
}

type CodexPluginAppThreadAdmission = "ready" | "provisional" | "blocked";

export function resolveCodexPluginAppThreadAdmission(
  app: CodexPluginOwnedApp,
  inventory: CodexPluginInventory,
): CodexPluginAppThreadAdmission {
  const snapshot = inventory.appInventory?.snapshot;
  if (!snapshot) {
    return "blocked";
  }
  return resolveCodexInstalledAppThreadAdmission(
    app,
    snapshot.installedApps.find((candidate) => candidate.id === app.id),
  );
}

function resolveCodexInstalledAppThreadAdmission(
  app: Pick<CodexPluginOwnedApp, "accessible" | "needsAuth">,
  installed: v2.InstalledApp | undefined,
): CodexPluginAppThreadAdmission {
  if (!app.accessible || app.needsAuth || !installed) {
    return "blocked";
  }
  if (installed.enabled && installed.callable) {
    return "ready";
  }
  // Explicit plugin and account-wide policy can both override deny-by-default.
  // An enabled app with no callable tools cannot be repaired by thread policy.
  return !installed.enabled && !installed.callable ? "provisional" : "blocked";
}

export async function readCodexConfigForAppAdmission(
  params: CodexPluginThreadAppAdmissionParams,
): Promise<CodexPluginThreadAppAdmissionConfig | undefined> {
  try {
    const response = await params.request("config/read", {
      includeLayers: true,
      ...(params.configCwd ? { cwd: params.configCwd } : {}),
    });
    if (
      !isJsonObject(response) ||
      !isJsonObject(response.config) ||
      !Array.isArray(response.layers)
    ) {
      throw new Error("Codex config/read omitted effective config or config layers");
    }
    return {
      config: response.config,
      layers: response.layers.flatMap((layer) => {
        if (!isJsonObject(layer)) {
          throw new Error("Codex config/read returned an invalid config layer");
        }
        if (layer.disabledReason !== undefined && layer.disabledReason !== null) {
          if (typeof layer.disabledReason !== "string") {
            throw new Error("Codex config/read returned an invalid disabled layer");
          }
          return [];
        }
        if (!isJsonObject(layer.config)) {
          throw new Error("Codex config/read returned an invalid layer config");
        }
        return [layer.config];
      }),
    };
  } catch (error) {
    embeddedAgentLog.warn("codex plugin app admission config read failed", {
      error: serializeCodexAppInventoryError(error),
    });
    return undefined;
  }
}

export function resolveCodexExplicitAppEnablement(
  layersHighestPrecedenceFirst: readonly JsonObject[],
  appId: string,
): boolean | undefined {
  // The first active app-specific value wins. `_default` does not prevent an
  // explicitly selected plugin from safely requesting thread-only enablement.
  for (const layer of layersHighestPrecedenceFirst) {
    const apps = layer.apps;
    const app = isJsonObject(apps) ? apps[appId] : undefined;
    if (isJsonObject(app) && Object.hasOwn(app, "enabled")) {
      return app.enabled === true;
    }
  }
  return undefined;
}

export function shouldForceRefreshCodexNotReadyPluginApps(
  params: CodexPluginThreadAppAdmissionParams,
  policy: ResolvedCodexPluginsPolicy,
  inventory: CodexPluginInventory,
): boolean {
  if (
    !params.appCacheKey ||
    !policy.pluginPolicies.some((plugin) => plugin.enabled) ||
    inventory.appInventory?.state === "missing"
  ) {
    return false;
  }
  return inventory.records.some(
    (record) =>
      record.appOwnership === "proven" &&
      record.ownedAppIds.length > 0 &&
      (record.apps.length === 0 || record.apps.some((app) => !app.accessible)),
  );
}
