// Control UI tests cover sidebar pinned-route customization behavior.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_PINNED_ROUTES,
  SETTINGS_NAVIGATION_GROUPS,
  SIDEBAR_NAV_ROUTES,
  isSettingsNavigationRoute,
  normalizeSidebarPinnedRoutes,
  sidebarMoreRoutes,
} from "./app-navigation.ts";

const settingsRoutes = SETTINGS_NAVIGATION_GROUPS.flatMap((group) => group.routes);

describe("sidebar pinned routes", () => {
  it("keeps operational destinations visible by default", () => {
    expect(DEFAULT_SIDEBAR_PINNED_ROUTES).toEqual(["usage", "cron", "plugins"]);
  });

  it("drops the retired overview route from persisted pins", () => {
    expect(normalizeSidebarPinnedRoutes(["overview", "usage"])).toEqual(["usage"]);
  });

  it("keeps settings-only routes out of customizable pins", () => {
    expect(SIDEBAR_NAV_ROUTES).not.toContain("worktrees");
    expect(SIDEBAR_NAV_ROUTES).not.toContain("activity");
    expect(settingsRoutes).toContain("activity");
    expect(normalizeSidebarPinnedRoutes(["activity", "usage"])).toEqual(["usage"]);
  });

  it("moves session management into settings and drops stale pinned entries", () => {
    expect(SIDEBAR_NAV_ROUTES).not.toContain("sessions");
    expect(settingsRoutes).toContain("sessions");
    expect(normalizeSidebarPinnedRoutes(["sessions", "usage"])).toEqual(["usage"]);
  });

  it("moves devices into system settings and drops stale pinned entries", () => {
    expect(SIDEBAR_NAV_ROUTES).not.toContain("nodes");
    expect(settingsRoutes).toContain("nodes");
    expect(normalizeSidebarPinnedRoutes(["nodes", "usage"])).toEqual(["usage"]);
  });

  it("keeps channel management and settings slices out of the customizable sidebar", () => {
    expect(SIDEBAR_NAV_ROUTES).not.toContain("channels");
    expect(SIDEBAR_NAV_ROUTES).not.toContain("config");
    expect(settingsRoutes).toEqual(
      expect.arrayContaining(["worktrees", "activity", "channels", "config"]),
    );
    expect(settingsRoutes.every((routeId) => isSettingsNavigationRoute(routeId))).toBe(true);
    expect(normalizeSidebarPinnedRoutes(["activity", "worktrees", "usage"])).toEqual(["usage"]);
  });

  it("keeps the plugin manager in customizable workspace routes", () => {
    expect(normalizeSidebarPinnedRoutes(["plugins", "usage", "plugins"])).toEqual([
      "plugins",
      "usage",
    ]);
    expect(sidebarMoreRoutes(["usage"])).toContain("plugins");
    expect(settingsRoutes).not.toContain("plugins");
  });

  it("normalizes persisted pinned routes, dropping unknown and duplicate entries", () => {
    expect(
      normalizeSidebarPinnedRoutes(["usage", "tasks", "usage", "worktrees", "instances", 7]),
    ).toEqual(["usage", "tasks"]);
    expect(normalizeSidebarPinnedRoutes([])).toEqual([]);
  });

  it("falls back to null for non-list values so callers use defaults", () => {
    expect(normalizeSidebarPinnedRoutes(undefined)).toBeNull();
    expect(normalizeSidebarPinnedRoutes({ usage: true })).toBeNull();
    expect(normalizeSidebarPinnedRoutes("usage")).toBeNull();
  });

  it("puts every unpinned nav route into the More section", () => {
    const pinned = ["tasks", "usage"] as const;
    const more = sidebarMoreRoutes(pinned);
    expect(more).not.toContain("tasks");
    expect(more).not.toContain("usage");
    expect(new Set([...pinned, ...more])).toEqual(new Set(SIDEBAR_NAV_ROUTES));
  });
});
