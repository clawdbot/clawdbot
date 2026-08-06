import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ActivityRouteData } from "./run-inspector-model.ts";

function resolveActivityRouteData(search: string): ActivityRouteData {
  const params = new URLSearchParams(search);
  if (params.get("view") !== "run") {
    return { mode: "live", runId: null };
  }
  const runId = params.get("run");
  return { mode: "run", runId: runId && runId.trim() ? runId : null };
}

export const page = definePage({
  ...routePageSpec("activity"),
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => location.search,
  loader: (_context: ApplicationContext, { location }) => resolveActivityRouteData(location.search),
  component: () =>
    import("./activity-page.ts").then(() => ({
      header: true,
      render: (data: ActivityRouteData | undefined) =>
        html`<openclaw-activity-page .routeData=${data}></openclaw-activity-page>`,
    })),
});
