// Control UI tests cover sidebar pinned-route customization behavior.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_PINNED_ROUTES,
  SETTINGS_NAVIGATION_ROUTES,
  SIDEBAR_NAV_ROUTES,
  isSettingsNavigationRoute,
  normalizeSidebarPinnedRoutes,
  sidebarMoreRoutes,
} from "./app-navigation.ts";

describe("sidebar pinned routes", () => {
  it("defaults to a small pinned set drawn from the customizable routes", () => {
    expect(DEFAULT_SIDEBAR_PINNED_ROUTES.length).toBeLessThan(SIDEBAR_NAV_ROUTES.length);
    for (const routeId of DEFAULT_SIDEBAR_PINNED_ROUTES) {
      expect(SIDEBAR_NAV_ROUTES).toContain(routeId);
    }
  });

  it("keeps managed worktrees in settings, not the customizable sidebar", () => {
    expect(SIDEBAR_NAV_ROUTES).not.toContain("worktrees");
    expect(SETTINGS_NAVIGATION_ROUTES).toContain("worktrees");
  });

  it("keeps channel management and settings slices out of the customizable sidebar", () => {
    expect(SIDEBAR_NAV_ROUTES).not.toContain("channels");
    expect(SIDEBAR_NAV_ROUTES).not.toContain("config");
    expect(SETTINGS_NAVIGATION_ROUTES).toContain("channels");
    expect(SETTINGS_NAVIGATION_ROUTES.every((routeId) => isSettingsNavigationRoute(routeId))).toBe(
      true,
    );
  });

  it("normalizes persisted pinned routes, dropping unknown and duplicate entries", () => {
    expect(normalizeSidebarPinnedRoutes(["usage", "overview", "usage", "worktrees", 7])).toEqual([
      "usage",
      "overview",
    ]);
    expect(normalizeSidebarPinnedRoutes([])).toEqual([]);
  });

  it("keeps the plugin manager in the customizable workspace routes", () => {
    expect(normalizeSidebarPinnedRoutes(["plugins", "overview", "plugins"])).toEqual([
      "plugins",
      "overview",
    ]);
    expect(sidebarMoreRoutes(["overview"])).toContain("plugins");
    expect(SETTINGS_NAVIGATION_ROUTES).not.toContain("plugins");
  });

  it("falls back to null for non-list values so callers use defaults", () => {
    expect(normalizeSidebarPinnedRoutes(undefined)).toBeNull();
    expect(normalizeSidebarPinnedRoutes({ overview: true })).toBeNull();
    expect(normalizeSidebarPinnedRoutes("overview")).toBeNull();
  });

  it("puts every unpinned nav route into the More section", () => {
    const pinned = ["overview", "usage"] as const;
    const more = sidebarMoreRoutes(pinned);
    expect(more).not.toContain("overview");
    expect(more).not.toContain("usage");
    expect(new Set([...pinned, ...more])).toEqual(new Set(SIDEBAR_NAV_ROUTES));
  });
});
