import type { RouteLocation } from "@openclaw/uirouter";
import {
  INTERNAL_PLUGIN_SETTINGS_PATH_PARAM,
  INTERNAL_PLUGINS_PATH_PARAM,
  pathForRoute,
} from "../../app-route-paths.ts";

export function pluginsRouteLocation(location: RouteLocation): RouteLocation {
  const searchParams = new URLSearchParams(location.search);
  const pathname =
    searchParams.get(INTERNAL_PLUGINS_PATH_PARAM) ??
    searchParams.get(INTERNAL_PLUGIN_SETTINGS_PATH_PARAM) ??
    location.pathname;
  searchParams.delete(INTERNAL_PLUGINS_PATH_PARAM);
  searchParams.delete(INTERNAL_PLUGIN_SETTINGS_PATH_PARAM);
  const search = searchParams.toString();
  return {
    pathname,
    search: search ? `?${search}` : "",
    hash: location.hash,
  };
}

export function canonicalPluginsRouteLocation(
  location: RouteLocation,
  basePath = "",
): RouteLocation | null {
  const searchParams = new URLSearchParams(location.search);
  const settingsPath = pathForRoute("plugin-settings", basePath);
  const legacyTab = searchParams.get("tab");
  const supportedAdvancedTab = location.pathname === settingsPath && legacyTab === "advanced";
  const hadLegacyTab = searchParams.has("tab") && !supportedAdvancedTab;
  if (hadLegacyTab) {
    searchParams.delete("tab");
  }
  const search = searchParams.toString();
  const isLegacyDiscoverPath = location.pathname === `${settingsPath}/discover`;
  const legacyDiscover = isLegacyDiscoverPath || legacyTab === "discover";
  const canonical: RouteLocation = {
    pathname: legacyDiscover ? pathForRoute("plugins", basePath) : location.pathname,
    search: search ? `?${search}` : "",
    hash: location.hash,
  };
  return hadLegacyTab || isLegacyDiscoverPath ? canonical : null;
}
