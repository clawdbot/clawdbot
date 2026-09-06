import type { CodexAppServerRequestParams, CodexAppServerRequestResult, v2 } from "./protocol.js";

type CodexAppInventoryMethod = "app/installed" | "app/read";

/** Builds app-server inventory fixtures from the existing app policy test shape. */
export function codexAppInventoryResponse<Method extends CodexAppInventoryMethod>(
  method: Method,
  apps: readonly v2.AppInfo[],
  params?: CodexAppServerRequestParams<Method>,
  options?: { callableByAppId?: Readonly<Record<string, boolean>> },
): CodexAppServerRequestResult<Method> {
  if (method === "app/installed") {
    return {
      apps: apps.map((app) => ({
        id: app.id,
        runtimeName: app.name,
        enabled: app.isEnabled,
        callable: options?.callableByAppId?.[app.id] ?? (app.isAccessible && app.isEnabled),
      })),
    } as CodexAppServerRequestResult<Method>;
  }

  const readParams = params as CodexAppServerRequestParams<"app/read"> | undefined;
  const requestedIds = readParams?.appIds;
  const requestedIdSet = requestedIds ? new Set(requestedIds) : undefined;
  const matchingApps = apps.filter(
    (app) => app.isAccessible && (!requestedIdSet || requestedIdSet.has(app.id)),
  );
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
      toolSummaries: readParams?.includeTools ? (app.toolSummaries ?? null) : null,
    })),
    missingAppIds: requestedIds?.filter((id) => !returnedIds.has(id)) ?? [],
  } as CodexAppServerRequestResult<Method>;
}
