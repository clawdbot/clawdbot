import type { CodexAppsReadParams } from "./app-inventory-protocol.js";
import type { CodexAppServerRequestParams, CodexAppServerRequestResult, v2 } from "./protocol.js";

type CodexAppInventoryMethod = "app/installed" | "app/list" | "app/read";

/** Builds app-server inventory fixtures from the existing app policy test shape. */
export function codexAppInventoryResponse<Method extends CodexAppInventoryMethod>(
  method: Method,
  apps: readonly v2.AppInfo[],
  params?: CodexAppServerRequestParams<Method>,
): CodexAppServerRequestResult<Method> {
  if (method === "app/installed") {
    return {
      apps: apps.map((app) => ({
        id: app.id,
        runtimeName: app.name,
        enabled: app.isEnabled,
        callable: app.isAccessible && app.isEnabled,
      })),
    } as CodexAppServerRequestResult<Method>;
  }

  if (method === "app/read") {
    const requestedIds = (params as CodexAppsReadParams | undefined)?.appIds;
    const requestedIdSet = requestedIds ? new Set(requestedIds) : undefined;
    const matchingApps = requestedIdSet ? apps.filter((app) => requestedIdSet.has(app.id)) : apps;
    const returnedIds = new Set(matchingApps.map((app) => app.id));

    return {
      apps: matchingApps.map((app) => ({
        id: app.id,
        name: app.name,
        description: app.description,
        iconUrl: app.logoUrl,
        iconUrlDark: app.logoUrlDark,
        distributionChannel: app.distributionChannel,
        installUrl: app.installUrl,
        pluginDisplayNames: app.pluginDisplayNames,
      })),
      missingAppIds: requestedIds?.filter((id) => !returnedIds.has(id)) ?? [],
    } as CodexAppServerRequestResult<Method>;
  }

  return {
    data: [...apps],
    nextCursor: null,
  } as CodexAppServerRequestResult<Method>;
}
