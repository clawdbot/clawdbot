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
  code: "account_app_inventory_unavailable";
  message: string;
};

type CodexPluginThreadAppAdmissionParams = {
  request: CodexPluginRuntimeRequest;
  configCwd?: string;
  appCacheKey: string;
  nowMs?: number;
};

export async function refreshAppInventoryNow(
  params: CodexPluginThreadAppAdmissionParams,
  appCache: CodexAppInventoryCache,
  options: { forceRefetch?: boolean; reason?: string; targetAppIds?: readonly string[] } = {},
): Promise<CodexAppInventorySnapshot | undefined> {
  const appCacheKey = params.appCacheKey;
  if (!appCacheKey) {
    return undefined;
  }
  const request: CodexAppInventoryRequest = async (method, requestParams) =>
    (await params.request(method, requestParams)) as CodexAppServerRequestResult<typeof method>;
  try {
    return await appCache.refreshNow({
      key: appCacheKey,
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
    // Keep building from the diagnostic inventory state; app exposure remains scoped below.
    return undefined;
  }
}

export function collectInventoryOwnedAppIds(inventory: CodexPluginInventory): string[] {
  return Array.from(
    new Set(inventory.records.flatMap((record) => record.ownedAppIds).filter(Boolean)),
  ).toSorted();
}

export async function readThreadAdmissibleAccountApps(
  params: CodexPluginThreadAppAdmissionParams,
  appCache: CodexAppInventoryCache,
): Promise<{
  apps: v2.AppInfo[];
  source?: CodexAppInventorySnapshot["source"];
  diagnostic?: CodexPluginThreadAppAdmissionDiagnostic;
}> {
  // Account-wide mode needs metadata for every installed app, not only the
  // configured plugin-owned app ids used by targeted startup refreshes.
  const snapshot = await refreshAppInventoryNow(params, appCache, {
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
  return {
    apps: snapshot.apps
      // Account-wide discovery must preserve Codex's effective enablement policy.
      // Only an explicitly configured plugin may provisionally enable its owned app.
      .filter((app) => resolveAccountAppThreadAdmission(app, snapshot.source) === "ready")
      .toSorted((left, right) => left.id.localeCompare(right.id)),
    source: snapshot.source,
  };
}

export function toOwnedAccountApp(app: v2.AppInfo): CodexPluginOwnedApp {
  return {
    id: app.id,
    name: app.name,
    accessible: app.isAccessible,
    enabled: app.isEnabled,
    needsAuth: !app.isAccessible,
  };
}

export function resolveThreadConfigAppsForRecord(params: {
  record: CodexPluginInventoryRecord;
  inventory: CodexPluginInventory;
}): CodexPluginOwnedApp[] {
  if (params.inventory.appInventory?.state === "missing") {
    return [];
  }
  return params.record.apps;
}

type CodexPluginAppThreadAdmission = "ready" | "provisional" | "blocked";

export function resolveAccountAppThreadAdmission(
  app: v2.AppInfo,
  source: CodexAppInventorySnapshot["source"] | undefined,
): CodexPluginAppThreadAdmission {
  return resolveAppInfoThreadAdmission(app, source);
}

export function resolvePluginAppThreadAdmission(
  app: CodexPluginOwnedApp,
  inventory: CodexPluginInventory,
): CodexPluginAppThreadAdmission {
  if (app.accessible) {
    return "ready";
  }
  const snapshot = inventory.appInventory?.snapshot;
  if (!snapshot) {
    return "blocked";
  }
  const appInfo = snapshot.apps.find((candidate) => candidate.id === app.id);
  return appInfo ? resolveAppInfoThreadAdmission(appInfo, snapshot.source) : "blocked";
}

function resolveAppInfoThreadAdmission(
  app: v2.AppInfo,
  source: CodexAppInventorySnapshot["source"] | undefined,
): CodexPluginAppThreadAdmission {
  if (app.isAccessible) {
    return "ready";
  }
  // The explicit OpenClaw plugin entry is the unmanaged enablement decision.
  // Codex still applies feature/workspace gates and managed app requirements
  // after this thread override; thread-scoped attestation fails closed if they win.
  return source === "installed" && !app.isEnabled ? "provisional" : "blocked";
}

export async function readConfigLayersForAppAdmission(
  params: CodexPluginThreadAppAdmissionParams,
): Promise<readonly JsonObject[] | undefined> {
  try {
    const response = await params.request("config/read", {
      includeLayers: true,
      ...(params.configCwd ? { cwd: params.configCwd } : {}),
    });
    if (!isJsonObject(response) || !Array.isArray(response.layers)) {
      throw new Error("Codex config/read omitted config layers");
    }
    return response.layers.flatMap((layer) => {
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
    });
  } catch (error) {
    embeddedAgentLog.warn("codex plugin app admission config read failed", { error });
    return undefined;
  }
}

export function resolveExplicitAppEnablement(
  layersHighestPrecedenceFirst: readonly JsonObject[],
  appId: string,
): boolean | undefined {
  // Codex includes disabled layers and orders active config from highest to lowest.
  // The first app-specific value wins; ignoring `_default` preserves the deny-all
  // service-account baseline while preventing SessionFlags from undoing an explicit opt-out.
  for (const layer of layersHighestPrecedenceFirst) {
    const apps = layer.apps;
    const app = isJsonObject(apps) ? apps[appId] : undefined;
    if (!isJsonObject(app) || !Object.hasOwn(app, "enabled")) {
      continue;
    }
    return app.enabled === true;
  }
  return undefined;
}

export function shouldForceRefreshForNotReadyPluginApps(
  params: CodexPluginThreadAppAdmissionParams,
  policy: ResolvedCodexPluginsPolicy,
  inventory: CodexPluginInventory,
): boolean {
  if (!params.appCacheKey || !policy.pluginPolicies.some((plugin) => plugin.enabled)) {
    return false;
  }
  if (inventory.appInventory?.state === "missing") {
    return false;
  }
  return inventory.records.some(
    (record) =>
      record.appOwnership === "proven" &&
      record.ownedAppIds.length > 0 &&
      (record.apps.length === 0 || record.apps.some((app) => !app.accessible)),
  );
}
