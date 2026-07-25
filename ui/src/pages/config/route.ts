import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import type { ConfigPageId } from "./config-sections.ts";
import { configRouteData, type ConfigRouteData } from "./route-data.ts";

function loadConfigRoute(context: ApplicationContext, location: RouteLocation) {
  const primaryLoad = context.runtimeConfig.ensureLoaded();
  void primaryLoad.then(() => context.runtimeConfig.ensureSchemaLoaded()).catch(() => undefined);
  return configRouteData(location);
}

function configPage(id: ConfigPageId, path: string, aliases: readonly string[]) {
  return definePage({
    id,
    path,
    aliases,
    loaderDeps: (_context: ApplicationContext, location: RouteLocation) =>
      `${location.search}\u0000${location.hash}`,
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
  configPage("config", "/settings/general", ["/config"]),
  configPage("communications", "/settings/communications", ["/communications"]),
  configPage("appearance", "/settings/appearance", ["/appearance"]),
  configPage("notifications", "/settings/notifications", []),
  configPage("security", "/settings/security", []),
  configPage("automation", "/settings/automation", ["/automation"]),
  configPage("mcp", "/settings/mcp", ["/mcp"]),
  configPage("infrastructure", "/settings/infrastructure", ["/infrastructure"]),
  configPage("ai-agents", "/settings/ai-agents", ["/ai-agents"]),
  configPage("advanced", "/settings/advanced", []),
] as const;
