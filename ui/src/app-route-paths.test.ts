// @vitest-environment node
import type { RouteLocation, RouterHistory } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import {
  inferBasePathFromPathname,
  memoryTabFromPath,
  pathForMemoryTab,
  routeIdFromPath,
  type MemoryRouteTab,
} from "./app-route-paths.ts";
import { createApplicationRouter, startApplicationRouter } from "./app-routes.ts";
import type { ApplicationContext } from "./app/context.ts";

describe("Memory tab route paths", () => {
  it.each([
    ["overview", "/settings/memory"],
    ["memories", "/settings/memory/memories"],
    ["dreams", "/settings/memory/dreams"],
    ["settings", "/settings/memory/settings"],
  ] as const)("round-trips %s through its canonical path", (tab, pathname) => {
    expect(pathForMemoryTab(tab)).toBe(pathname);
    expect(memoryTabFromPath(pathname)).toBe(tab);
    expect(routeIdFromPath(pathname)).toBe("memory");
  });

  it.each(["overview", "memories", "dreams", "settings"] as const)(
    "round-trips %s under a configured base path",
    (tab: MemoryRouteTab) => {
      const pathname = pathForMemoryTab(tab, "/ui");
      expect(memoryTabFromPath(pathname, "/ui")).toBe(tab);
      expect(routeIdFromPath(pathname, "/ui")).toBe("memory");
      expect(inferBasePathFromPathname(pathname)).toBe("/ui");
    },
  );

  it("rejects unknown and nested Memory tab segments", () => {
    expect(memoryTabFromPath("/settings/memory/unknown")).toBeNull();
    expect(memoryTabFromPath("/settings/memory/dreams/extra")).toBeNull();
    expect(routeIdFromPath("/settings/memory/unknown")).toBeNull();
    expect(routeIdFromPath("/settings/memory/dreams/extra")).toBeNull();
  });

  it("publishes the real dynamic pathname after the exact-match startup bridge", async () => {
    let location: RouteLocation = {
      pathname: "/settings/memory/settings",
      search: "",
      hash: "#memory-backend",
    };
    const push = vi.fn((next: RouteLocation) => {
      location = next;
    });
    const replace = vi.fn((next: RouteLocation) => {
      location = next;
    });
    const history: RouterHistory = {
      location: () => location,
      push,
      replace,
      listen: () => () => undefined,
    };
    const router = createApplicationRouter();
    const memoryRoute = router.getRoute("memory");
    if (!memoryRoute) {
      throw new Error("Memory route missing");
    }
    memoryRoute.component = async () => ({ render: () => null });
    const context = {
      basePath: "",
      runtimeConfig: {
        ensureLoaded: () => Promise.resolve(),
        ensureSchemaLoaded: () => Promise.resolve(),
      },
    } as unknown as ApplicationContext;

    await startApplicationRouter(router, history, "", context);

    expect(router.getState().location).toEqual(location);
    expect(router.getState().matches[0]?.location).toEqual(location);
    expect(location.pathname).toBe("/settings/memory/settings");
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    router.stop();
  });
});
