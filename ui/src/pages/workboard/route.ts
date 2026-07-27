import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveWorkboardRouteLocation, type WorkboardRouteData } from "./route-location.ts";

export type { WorkboardRouteData } from "./route-location.ts";

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
  id: "workboard",
  path: "/workboard",
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) =>
    `${location.pathname}\u0000${location.search}`,
  loader: (context: ApplicationContext, { location }) => loadWorkboardRoute(context, location),
  component: () =>
    import("./workboard-page.ts").then(() => ({
      header: true,
      render: (data: WorkboardRouteData | undefined) =>
        html`<openclaw-workboard-page .routeData=${data}></openclaw-workboard-page>`,
    })),
});
