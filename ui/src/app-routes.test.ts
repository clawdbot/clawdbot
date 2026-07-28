import { describe, expect, it } from "vitest";
import { APP_ROUTE_DEFINITIONS, APP_ROUTE_IDS } from "./app-route-paths.ts";
import { APP_ROUTE_TREE } from "./app-routes.ts";

// Route paths and aliases are declared twice: APP_ROUTE_DEFINITIONS drives
// routeIdFromPath and base-path inference, while the page definitions in
// ui/src/pages/*/route.ts drive actual router matching. A drift between them
// means URLs resolve to a route id the router will not serve (or vice versa),
// which surfaces as silent deep-link breakage instead of a build error.
describe("APP_ROUTE_TREE vs APP_ROUTE_DEFINITIONS", () => {
  it("registers every route id exactly once", () => {
    const treeIds = APP_ROUTE_TREE.map((page) => page.id);
    expect([...treeIds].toSorted()).toEqual([...APP_ROUTE_IDS].toSorted());
  });

  it("declares identical paths and aliases on both sides", () => {
    for (const page of APP_ROUTE_TREE) {
      const definition = APP_ROUTE_DEFINITIONS[page.id];
      expect(page.path, `path for route "${page.id}"`).toBe(definition.path);
      const definitionAliases = "aliases" in definition ? definition.aliases : [];
      expect([...(page.aliases ?? [])], `aliases for route "${page.id}"`).toEqual([
        ...definitionAliases,
      ]);
    }
  });
});
