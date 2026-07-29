import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ConfigPageId } from "./config-sections.ts";
import { configRouteData, type ConfigRouteData } from "./route-data.ts";

function loadConfigRoute(context: ApplicationContext, location: RouteLocation) {
  const primaryLoad = context.runtimeConfig.ensureLoaded();
  void primaryLoad.then(() => context.runtimeConfig.ensureSchemaLoaded()).catch(() => undefined);
  return configRouteData(location);
}

function configPage(id: ConfigPageId) {
  return definePage({
    ...routePageSpec(id),
    loaderDeps: (_context: ApplicationContext, location: RouteLocation) =>
      `${location.pathname}\u0000${location.search}\u0000${location.hash}`,
    loader: (context: ApplicationContext, { location }) => loadConfigRoute(context, location),
    component: () =>
      import("./config-page.ts").then(() => ({
        header: true,
        render: (data: ConfigRouteData | undefined) => html`
          <openclaw-config-page .pageId=${id} .routeData=${data ?? null}></openclaw-config-page>
        `,
      })),
  });
}

export const pages = [
  configPage("config"),
  configPage("communications"),
  configPage("appearance"),
  configPage("notifications"),
  configPage("security"),
  configPage("automation"),
  configPage("mcp"),
  configPage("memory"),
  configPage("talk"),
  configPage("infrastructure"),
  configPage("ai-agents"),
  configPage("advanced"),
] as const;
