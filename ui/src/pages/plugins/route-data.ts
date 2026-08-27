import type { RouteLocation } from "@openclaw/uirouter";
import {
  INTERNAL_PLUGINS_PATH_PARAM,
  pathForPluginsHubTab,
  pluginsHubTabFromPath,
  type PluginsHubRouteTab,
} from "../../app-route-paths.ts";

export function pluginsRouteLocation(location: RouteLocation): RouteLocation {
  const searchParams = new URLSearchParams(location.search);
  const pathname = searchParams.get(INTERNAL_PLUGINS_PATH_PARAM) ?? location.pathname;
  searchParams.delete(INTERNAL_PLUGINS_PATH_PARAM);
  const search = searchParams.toString();
  return {
    pathname,
    search: search ? `?${search}` : "",
    hash: location.hash,
  };
}

export function pluginsHubTabForRoute(location: RouteLocation, basePath = ""): PluginsHubRouteTab {
  const pathTab = pluginsHubTabFromPath(location.pathname, basePath);
  if (pathTab === "discover") {
    return pathTab;
  }
  return new URLSearchParams(location.search).get("tab") === "discover" ? "discover" : "installed";
}

export function canonicalPluginsRouteLocation(
  location: RouteLocation,
  basePath = "",
): RouteLocation | null {
  const searchParams = new URLSearchParams(location.search);
  const hadLegacyTab = searchParams.has("tab");
  searchParams.delete("tab");
  const search = searchParams.toString();
  const canonical: RouteLocation = {
    pathname: pathForPluginsHubTab(pluginsHubTabForRoute(location, basePath), basePath),
    search: search ? `?${search}` : "",
    hash: location.hash,
  };
  return hadLegacyTab || canonical.pathname !== location.pathname ? canonical : null;
}
