import { definePage, type RouteLoaderOptions, type RouteLocation } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { loadPluginCatalog } from "../../lib/plugins/index.ts";
import type { PluginsRouteData } from "./plugins-page.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initialTabFromSearch(search: string): PluginsRouteData["initialTab"] {
  const tab = new URLSearchParams(search).get("tab");
  return tab === "discover" || tab === "installed" ? tab : null;
}

async function loadPluginsRouteData(
  context: ApplicationContext,
  options: RouteLoaderOptions,
): Promise<PluginsRouteData> {
  const initialTab = initialTabFromSearch(options.location.search);
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const client = gatewaySnapshot.client;
  if (!gatewaySnapshot.connected || !client) {
    return { gateway, gatewaySnapshot, result: null, error: null, initialTab };
  }
  try {
    const result = await loadPluginCatalog(client);
    return { gateway, gatewaySnapshot, result, error: null, initialTab };
  } catch (error) {
    return { gateway, gatewaySnapshot, result: null, error: errorMessage(error), initialTab };
  }
}

export const page = definePage({
  id: "plugins",
  path: "/settings/plugins",
  // Query-only tab changes need distinct matches; without this the router
  // reuses the cached loader result and the hub keeps the previous tab.
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) =>
    initialTabFromSearch(location.search) ?? "",
  loader: loadPluginsRouteData,
  component: () =>
    import("./plugins-page.ts").then(() => ({
      header: true,
      render: (data: PluginsRouteData | undefined) =>
        html`<openclaw-plugins-page .routeData=${data}></openclaw-plugins-page>`,
    })),
});
