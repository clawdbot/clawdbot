import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ModelSetupRouteData } from "./model-setup-page.ts";

export const page = definePage({
  ...routePageSpec("model-setup"),
  // Query-only first-run changes need distinct matches so the completion
  // action cannot retain a cached destination from the previous visit.
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => location.search,
  loader: (_context: ApplicationContext, { location }): ModelSetupRouteData => ({
    firstRun: new URLSearchParams(location.search).get("firstRun") === "1",
  }),
  component: () =>
    import("./model-setup-page.ts").then(() => ({
      header: true,
      render: (data: ModelSetupRouteData | undefined) =>
        html`<openclaw-model-setup-page .routeData=${data}></openclaw-model-setup-page>`,
    })),
});
