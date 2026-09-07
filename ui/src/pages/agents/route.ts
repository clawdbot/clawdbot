import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import type { AgentsListResult } from "../../api/types.ts";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { resolveAgentsRouteLocation, type AgentsRouteLocation } from "./route-location.ts";

export type AgentsRouteData = AgentsRouteLocation & {
  // Client identity alone cannot distinguish provider replacement or reconnect epochs.
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  agentsList: AgentsListResult | null;
  error: string | null;
};

export const page = definePage({
  ...routePageSpec("agents"),
  loaderDeps: (context: ApplicationContext, location: RouteLocation) => {
    const route = resolveAgentsRouteLocation(location, context.basePath).location;
    return `${route.pathname}\u0000${route.search}\u0000${route.hash}`;
  },
  loader: async (context: ApplicationContext, { location }) =>
    (await import("./route-loader.ts")).load(context, location),
  component: () => import("./agents-page.ts"),
});
