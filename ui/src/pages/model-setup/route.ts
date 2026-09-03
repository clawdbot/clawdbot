import type { RouteLocation } from "@openclaw/uirouter";
import { definePage, redirect } from "@openclaw/uirouter";
import { nothing } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { modelsLocation, readModelsRouteState } from "../model-providers/location.ts";

export const page = definePage({
  ...routePageSpec("model-setup"),
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) =>
    `${location.search}\u0000${location.hash}`,
  loader: (context: ApplicationContext, { location }) => {
    const routeState = readModelsRouteState(location);
    return redirect(
      modelsLocation(
        context.basePath,
        { view: "connect", ...(routeState.firstRun ? { firstRun: true } : {}) },
        location,
      ),
    );
  },
  // Redirect routes still require a module by contract, but never render page content.
  component: async () => ({ header: true, render: () => nothing }),
});
