import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveWorkboardRouteLocation, type WorkboardRouteData } from "./route-location.ts";

export type { WorkboardRouteData } from "./route-location.ts";

function workboardLoaderDeps(context: ApplicationContext, location: RouteLocation): string {
  const route = resolveWorkboardRouteLocation(location, context.basePath);
  const canonicalLocation = route.canonicalLocation;
  return `${canonicalLocation?.pathname ?? location.pathname}\u0000${
    canonicalLocation?.search ?? route.search
  }`;
}

async function loadWorkboardRoute(
  context: ApplicationContext,
  location: RouteLocation,
): Promise<WorkboardRouteData> {
  const sessions = context.sessions.state;
  await Promise.all([
    context.runtimeConfig.ensureLoaded(),
    context.agents.ensureList(),
    sessions.result || sessions.loading ? Promise.resolve() : context.sessions.refresh(),
  ]);
  return {
    ...resolveWorkboardRouteLocation(location, context.basePath),
  };
}

export const page = definePage({
  ...routePageSpec("workboard"),
  loaderDeps: workboardLoaderDeps,
  loader: (context: ApplicationContext, { location }) => loadWorkboardRoute(context, location),
  component: () =>
    import("./workboard-page.ts").then(() => ({
      header: true,
      render: (data: WorkboardRouteData | undefined) =>
        html`<openclaw-workboard-page .routeData=${data}></openclaw-workboard-page>`,
    })),
});
