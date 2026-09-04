import type { RouteLocation } from "@openclaw/uirouter";
import { definePage, redirect } from "@openclaw/uirouter";
import { html, nothing } from "lit";
import { pathForRoute, routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ConfigPageId } from "./config-sections.ts";
import {
  configRouteData,
  configTargetIdFromHash,
  SETTINGS_ROUTE_TARGETS,
  type ConfigRouteData,
} from "./route-data.ts";

function loadConfigRoute(
  context: ApplicationContext,
  location: RouteLocation,
  pageId: ConfigPageId,
) {
  const primaryLoad = context.runtimeConfig.ensureLoaded();
  if (pageId !== "updates") {
    void primaryLoad.then(() => context.runtimeConfig.ensureSchemaLoaded()).catch(() => undefined);
  }
  return configRouteData(location);
}

function configPage(id: ConfigPageId) {
  return definePage({
    ...routePageSpec(id),
    loaderDeps: (_context: ApplicationContext, location: RouteLocation) => {
      const route = configRouteData(location);
      return `${route.pathname}\u0000${route.search}\u0000${route.hash}`;
    },
    loader: (context: ApplicationContext, { location }) => loadConfigRoute(context, location, id),
    component: () =>
      import("./config-page.ts").then(() => ({
        header: true,
        render: (data: ConfigRouteData | undefined) => html`
          <openclaw-config-page .pageId=${id} .routeData=${data ?? null}></openclaw-config-page>
        `,
      })),
  });
}

const removedGeneralRedirectPage = definePage({
  ...routePageSpec("config"),
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) =>
    `${location.pathname}\u0000${location.search}\u0000${location.hash}`,
  loader: (context: ApplicationContext, { location }) => {
    const target =
      configTargetIdFromHash(location.hash) === "settings-general-model"
        ? SETTINGS_ROUTE_TARGETS.modelBehavior
        : SETTINGS_ROUTE_TARGETS.appearanceLanguage;
    return redirect({
      pathname: pathForRoute(target.routeId, context.basePath),
      search: "search" in target ? target.search : "",
      hash: target.hash,
    });
  },
  // Redirect routes still require a module by contract, but never render page content.
  component: async () => ({ header: true, render: () => nothing }),
});

export const pages = [
  removedGeneralRedirectPage,
  configPage("communications"),
  configPage("appearance"),
  configPage("notifications"),
  configPage("security"),
  configPage("automation"),
  configPage("mcp"),
  configPage("memory"),
  configPage("talk"),
  configPage("infrastructure"),
  configPage("updates"),
  configPage("ai-agents"),
  configPage("advanced"),
] as const;
