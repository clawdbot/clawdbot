// Control UI tests cover sidebar pinned-route customization behavior.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_PINNED_ROUTES,
  SETTINGS_NAVIGATION_GROUPS,
  SIDEBAR_NAV_ROUTES,
  isSessionsHubRoute,
  isSettingsNavigationRoute,
  normalizeSidebarPinnedRoutes,
  sidebarMoreRoutes,
} from "./app-navigation.ts";

const settingsRoutes = SETTINGS_NAVIGATION_GROUPS.flatMap((group) => group.routes);

describe("sidebar pinned routes", () => {
  it("keeps operational destinations visible by default", () => {
    expect(DEFAULT_SIDEBAR_PINNED_ROUTES).toEqual(["custodian", "usage", "cron", "plugins"]);
  });

  it("drops the retired overview route from persisted pins", () => {
    expect(normalizeSidebarPinnedRoutes(["overview", "usage"])).toEqual(["usage"]);
  });

  it("keeps management surfaces in the workspace, not settings", () => {
    for (const routeId of ["sessions", "activity"] as const) {
      expect(SIDEBAR_NAV_ROUTES).toContain(routeId);
      expect(settingsRoutes).not.toContain(routeId);
    }
    expect(settingsRoutes).not.toContain("worktrees");
    expect(settingsRoutes).not.toContain("memory-import");
  });

  it("treats worktrees as a sessions hub tab without its own pin", () => {
    expect(SIDEBAR_NAV_ROUTES).not.toContain("worktrees");
    expect(isSessionsHubRoute("sessions")).toBe(true);
    expect(isSessionsHubRoute("worktrees")).toBe(true);
    expect(isSessionsHubRoute("chat")).toBe(false);
    expect(normalizeSidebarPinnedRoutes(["worktrees", "usage"])).toEqual(["usage"]);
  });

  it("keeps settings pages out of the customizable sidebar", () => {
    for (const routeId of [
      "channels",
      "config",
      "security",
      "notifications",
      "advanced",
    ] as const) {
      expect(SIDEBAR_NAV_ROUTES).not.toContain(routeId);
      expect(settingsRoutes).toContain(routeId);
    }
    expect(
      settingsRoutes
        .filter((routeId) => routeId !== "custodian")
        .every((routeId) => isSettingsNavigationRoute(routeId)),
    ).toBe(true);
    expect(isSettingsNavigationRoute("custodian")).toBe(false);
  });

  it("keeps model setup as a settings subpage without a sidebar entry", () => {
    expect(settingsRoutes).not.toContain("model-setup");
    expect(isSettingsNavigationRoute("model-setup")).toBe(true);
  });

  it("keeps devices in connection settings and drops stale pinned entries", () => {
    expect(SIDEBAR_NAV_ROUTES).not.toContain("nodes");
    expect(settingsRoutes).toContain("nodes");
    expect(normalizeSidebarPinnedRoutes(["nodes", "usage"])).toEqual(["usage"]);
  });

  it("keeps the plugin manager in customizable workspace routes", () => {
    expect(normalizeSidebarPinnedRoutes(["plugins", "usage", "plugins"])).toEqual([
      "plugins",
      "usage",
    ]);
    expect(sidebarMoreRoutes(["usage"])).toContain("plugins");
    expect(settingsRoutes).not.toContain("plugins");
  });

  it("keeps OpenClaw pinnable and linked from Settings without Settings chrome", () => {
    expect(SIDEBAR_NAV_ROUTES).toContain("custodian");
    expect(settingsRoutes).toContain("custodian");
    expect(isSettingsNavigationRoute("custodian")).toBe(false);
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
