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
  it("defaults to no pinned routes so sessions stay the sidebar's core content", () => {
    expect(DEFAULT_SIDEBAR_PINNED_ROUTES).toEqual([]);
  });

  it("drops the retired overview route from persisted pins", () => {
    expect(normalizeSidebarPinnedRoutes(["overview", "usage"])).toEqual(["usage"]);
  });

  it("keeps managed worktrees in settings, not the customizable sidebar", () => {
    expect(SIDEBAR_NAV_ROUTES).not.toContain("worktrees");
    expect(SETTINGS_NAVIGATION_ROUTES).toContain("worktrees");
  });

  it("moves activity into system settings and drops stale pinned entries", () => {
    expect(SIDEBAR_NAV_ROUTES).not.toContain("activity");
    expect(SETTINGS_NAVIGATION_ROUTES).toContain("activity");
    expect(normalizeSidebarPinnedRoutes(["activity", "usage"])).toEqual(["usage"]);
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
    expect(
      normalizeSidebarPinnedRoutes(["usage", "sessions", "usage", "worktrees", "instances", 7]),
    ).toEqual(["usage", "sessions"]);
    expect(normalizeSidebarPinnedRoutes([])).toEqual([]);
  });

  it("keeps the plugin manager in the customizable workspace routes", () => {
    expect(normalizeSidebarPinnedRoutes(["plugins", "usage", "plugins"])).toEqual([
      "plugins",
      "usage",
    ]);
    expect(sidebarMoreRoutes(["usage"])).toContain("plugins");
    expect(SETTINGS_NAVIGATION_ROUTES).not.toContain("plugins");
  });

  it("falls back to null for non-list values so callers use defaults", () => {
    expect(normalizeSidebarPinnedRoutes(undefined)).toBeNull();
    expect(normalizeSidebarPinnedRoutes({ usage: true })).toBeNull();
    expect(normalizeSidebarPinnedRoutes("usage")).toBeNull();
  });

  it("puts every unpinned nav route into the More section", () => {
    const pinned = ["sessions", "usage"] as const;
    const more = sidebarMoreRoutes(pinned);
    expect(more).not.toContain("sessions");
    expect(more).not.toContain("usage");
    expect(new Set([...pinned, ...more])).toEqual(new Set(SIDEBAR_NAV_ROUTES));
  });
});
