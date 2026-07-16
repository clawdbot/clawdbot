import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { boardFilterFromSearch } from "./board-filter.ts";

export type WorkboardRouteData = {
  boardFilter: string;
  search: string;
};

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
    boardFilter: boardFilterFromSearch(location.search),
    search: location.search,
  };
}

export const page = definePage({
  id: "workboard",
  path: "/workboard",
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => location.search,
  loader: (context: ApplicationContext, { location }) => loadWorkboardRoute(context, location),
  component: () =>
    import("./workboard-page.ts").then(() => ({
      header: true,
      render: (data: WorkboardRouteData | undefined) =>
        html`<openclaw-workboard-page .routeData=${data}></openclaw-workboard-page>`,
    })),
});
