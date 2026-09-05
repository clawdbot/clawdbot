import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  resolveWorkboardRouteLocation,
  workboardRouteLocation,
  type WorkboardRouteData,
} from "./route-location.ts";

export type { WorkboardRouteData } from "./route-location.ts";

export const page = definePage({
  ...routePageSpec("workboard"),
  loaderDeps: (context: ApplicationContext, location: RouteLocation) => {
    const routeLocation = workboardRouteLocation(location);
    const route = resolveWorkboardRouteLocation(routeLocation, context.basePath);
    const canonicalLocation = route.canonicalLocation;
    return `${canonicalLocation?.pathname ?? routeLocation.pathname}\u0000${
      canonicalLocation?.search ?? route.search
    }`;
  },
  loader: (context: ApplicationContext, { location }) =>
    resolveWorkboardRouteLocation(location, context.basePath),
  component: () =>
    import("../plugin/plugin-page.ts").then(() => ({
      header: true,
      render: (data: WorkboardRouteData | undefined) =>
        html`<openclaw-plugin-page
          .pluginId=${"workboard"}
          .tabId=${"workboard"}
          .params=${{ boardId: data?.boardFilter ?? "__all__" }}
        ></openclaw-plugin-page>`,
    })),
});
