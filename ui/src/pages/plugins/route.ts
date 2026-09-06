import {
  definePage,
  redirect,
  type RouteLoaderOptions,
  type RouteLocation,
} from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { loadPluginCatalog } from "../../lib/plugins/index.ts";
import type { PluginsRouteData } from "./plugins-page.ts";
import { canonicalPluginsRouteLocation, pluginsRouteLocation } from "./route-data.ts";

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

type PluginsSurface = "discovery" | "settings";

function definePluginsPage(routeId: "plugins" | "plugin-settings", surface: PluginsSurface) {
  return definePage({
    ...routePageSpec(routeId),
    loaderDeps: (_context: ApplicationContext, location: RouteLocation) => {
      const routeLocation = pluginsRouteLocation(location);
      return `${routeLocation.pathname}\u0000${routeLocation.search}\u0000${routeLocation.hash}`;
    },
    loader: (context: ApplicationContext, options: RouteLoaderOptions) => {
      const location = pluginsRouteLocation(options.location);
      const canonical = canonicalPluginsRouteLocation(location, context.basePath);
      if (canonical) {
        return redirect(canonical);
      }
      return loadPluginsRouteData(context, options);
    },
    component: () =>
      import("./plugins-page.ts").then(() => ({
        header: true,
        render: (data: PluginsRouteData | undefined) =>
          html`<openclaw-plugins-page
            .routeData=${data}
            .surface=${surface}
          ></openclaw-plugins-page>`,
      })),
  });
}

const page = definePluginsPage("plugins", "discovery");
const settingsPage = definePluginsPage("plugin-settings", "settings");
export const pages = [page, settingsPage] as const;
