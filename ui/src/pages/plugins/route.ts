import { definePage, type RouteLoaderOptions, type RouteLocation } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { loadPluginCatalog } from "../../lib/plugins/index.ts";
import type { PluginsRouteData } from "./plugins-page.ts";
import { pluginsRouteLocation } from "./route-data.ts";

async function loadPluginsRouteData(
  context: ApplicationContext,
  options: RouteLoaderOptions,
): Promise<PluginsRouteData> {
  const location = pluginsRouteLocation(options.location);
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const client = gatewaySnapshot.client;
  if (gatewaySnapshot.phase !== "connected" || !client) {
    return { gateway, gatewaySnapshot, result: null, error: null, location };
  }
  try {
    const result = await loadPluginCatalog(client);
    return { gateway, gatewaySnapshot, result, error: null, location };
  } catch (error) {
    return {
      gateway,
      gatewaySnapshot,
      result: null,
      error: formatUiError(error),
      location,
    };
  }
}

export const page = definePage({
  ...routePageSpec("plugins"),
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => {
    const routeLocation = pluginsRouteLocation(location);
    return `${routeLocation.pathname}\u0000${routeLocation.search}\u0000${routeLocation.hash}`;
  },
  loader: loadPluginsRouteData,
  component: () =>
    import("./plugins-page.ts").then(() => ({
      header: true,
      render: (data: PluginsRouteData | undefined) =>
        html`<openclaw-plugins-page .routeData=${data}></openclaw-plugins-page>`,
    })),
});
