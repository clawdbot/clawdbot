import { definePage } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("agents-home"),
  component: () => import("./agents-home-page.ts"),
});
