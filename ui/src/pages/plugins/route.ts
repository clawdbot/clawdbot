import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { loadPluginCatalog } from "../../lib/plugins/index.ts";
import type { PluginsRouteData } from "./plugins-page.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadPluginsRouteData(context: ApplicationContext): Promise<PluginsRouteData> {
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const client = gatewaySnapshot.client;
  if (!gatewaySnapshot.connected || !client) {
    return { gateway, gatewaySnapshot, result: null, error: null };
  }
  try {
    const result = await loadPluginCatalog(client);
    return { gateway, gatewaySnapshot, result, error: null };
  } catch (error) {
    return { gateway, gatewaySnapshot, result: null, error: errorMessage(error) };
  }
}

export const page = definePage({
  id: "plugins",
  path: "/settings/plugins",
  loader: loadPluginsRouteData,
  component: () =>
    import("./plugins-page.ts").then(() => ({
      header: true,
      render: (data: PluginsRouteData | undefined) =>
        html`<openclaw-plugins-page .routeData=${data}></openclaw-plugins-page>`,
    })),
});
