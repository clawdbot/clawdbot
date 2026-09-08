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
    // Preserve saved first-run URLs; both markers use the same explicit-choice UI.
    firstRun: ["1", "explicit"].includes(
      new URLSearchParams(location.search).get("firstRun") ?? "",
    ),
  }),
  component: () =>
    import("./model-setup-page.ts").then(() => ({
      header: true,
      render: (data: ModelSetupRouteData | undefined) =>
        html`<openclaw-model-setup-page .routeData=${data}></openclaw-model-setup-page>`,
    })),
});
