import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ActivityRouteData } from "./run-inspector-model.ts";

function resolveActivityRouteData(search: string): ActivityRouteData {
  const params = new URLSearchParams(search);
  if (params.get("view") !== "run") {
    return { mode: "live", selector: null };
  }
  const executionId = params.get("execution");
  if (executionId?.trim()) {
    return { mode: "run", selector: { kind: "execution", id: executionId } };
  }
  const runId = params.get("run");
  return {
    mode: "run",
    selector: runId?.trim() ? { kind: "run", id: runId } : null,
  };
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
