import { definePage } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("meetings"),
  loaderDeps: (_context, { search }) => search,
  loader: (_context, { deps }) => deps,
  component: () => import("./meetings-page.ts").then((module) => module.meetingsPageComponent),
});
