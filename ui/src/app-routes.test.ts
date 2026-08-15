import { describe, expect, it } from "vitest";
import { APP_ROUTE_IDS, pathForRoute, routeIdFromPath } from "./app-route-paths.ts";
import { createApplicationRouter } from "./app-routes.ts";

// Page definitions derive path/aliases from the route table via routePageSpec,
// so router matching cannot disagree with routeIdFromPath/base-path inference
// about a registered page. This guards the remaining seam: every table id must
// be registered with the router exactly once, and no page may reintroduce
// hand-written paths that shadow the table.
describe("application router registration", () => {
  const router = createApplicationRouter();

  it("registers every route id exactly once", () => {
    const routeIds = router.routes.map((route) => route.id);
    expect(routeIds).toContain("portals");
    expect([...routeIds].toSorted()).toEqual([...APP_ROUTE_IDS].toSorted());
  });

  it("serves the table's canonical paths and aliases", () => {
    for (const route of router.routes) {
      expect(route.path, `path for route "${route.id}"`).toBe(pathForRoute(route.id));
      for (const alias of route.aliases ?? []) {
        expect(routeIdFromPath(alias, ""), `alias "${alias}"`).toBe(route.id);
      }
    }
  });
});
