import { definePage, type RouteLocation } from "@openclaw/uirouter";
import { INTERNAL_ACTIVITY_PATH_PARAM, routePageSpec } from "../../app-route-paths.ts";

function sessionActivityRouteLocation(location: RouteLocation): RouteLocation {
  const params = new URLSearchParams(location.search);
  const pathname = params.get(INTERNAL_ACTIVITY_PATH_PARAM) ?? location.pathname;
  params.delete(INTERNAL_ACTIVITY_PATH_PARAM);
  const search = params.toString();
  return { pathname, search: search ? `?${search}` : "", hash: location.hash };
}

export const page = definePage({
  ...routePageSpec("activity"),
  loaderDeps: (_context, source) => {
    const { pathname, search, hash } = sessionActivityRouteLocation(source);
    return `${pathname}\u0000${search}\u0000${hash}`;
  },
  loader: (_context, { location }) => sessionActivityRouteLocation(location),
  component: () => import("./activity-page.ts").then((module) => module.activityPageComponent),
});
