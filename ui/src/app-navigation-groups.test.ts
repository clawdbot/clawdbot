// Control UI tests cover sidebar entry customization behavior.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_ENTRIES,
  SETTINGS_NAVIGATION_GROUPS,
  SIDEBAR_NAV_ROUTES,
  isSessionsHubRoute,
  isSettingsNavigationRoute,
  normalizeSidebarEntries,
  parseSidebarEntry,
  serializeSidebarEntry,
  sidebarMoreRoutes,
} from "./app-navigation.ts";

const settingsRoutes = SETTINGS_NAVIGATION_GROUPS.flatMap((group) => group.routes);

describe("sidebar entries", () => {
  it("keeps operational destinations visible by default", () => {
    expect(DEFAULT_SIDEBAR_ENTRIES).toEqual(["route:cron", "route:plugins"]);
    expect(DEFAULT_SIDEBAR_ENTRIES).not.toContain("route:usage");
  });

  it("drops retired routes from persisted entries", () => {
    expect(normalizeSidebarEntries(["route:overview", "route:usage"])).toEqual(["route:usage"]);
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
    expect(normalizeSidebarEntries(["route:worktrees", "route:usage"])).toEqual(["route:usage"]);
  });

  it("keeps settings pages out of the customizable sidebar", () => {
    for (const routeId of [
      "custodian",
      "channels",
      "config",
      "security",
      "notifications",
      "advanced",
    ] as const) {
      expect(SIDEBAR_NAV_ROUTES).not.toContain(routeId);
      expect(settingsRoutes).toContain(routeId);
    }
    expect(settingsRoutes.every((routeId) => isSettingsNavigationRoute(routeId))).toBe(true);
  });

  it("keeps model setup as a settings subpage without a sidebar entry", () => {
    expect(settingsRoutes).not.toContain("model-setup");
    expect(isSettingsNavigationRoute("model-setup")).toBe(true);
  });

  it("keeps devices in connection settings and drops stale pinned entries", () => {
    expect(SIDEBAR_NAV_ROUTES).not.toContain("nodes");
    expect(settingsRoutes).toContain("nodes");
    expect(normalizeSidebarEntries(["route:nodes", "route:usage"])).toEqual(["route:usage"]);
  });

  it("keeps the apps promo page unpinned by default but customizable", () => {
    expect(SIDEBAR_NAV_ROUTES).toContain("apps");
    expect(DEFAULT_SIDEBAR_ENTRIES).not.toContain("route:apps");
    expect(sidebarMoreRoutes(DEFAULT_SIDEBAR_ENTRIES)).toContain("apps");
    expect(settingsRoutes).not.toContain("apps");
    expect(isSettingsNavigationRoute("apps")).toBe(false);
  });

  it("keeps the plugin manager in customizable workspace routes", () => {
    expect(normalizeSidebarEntries(["route:plugins", "route:usage", "route:plugins"])).toEqual([
      "route:plugins",
      "route:usage",
    ]);
    expect(sidebarMoreRoutes(["route:usage", "session:agent:main:test"])).toContain("plugins");
    expect(settingsRoutes).not.toContain("plugins");
  });

  it("round-trips route, Workboard, and session entries", () => {
    expect(parseSidebarEntry("route:usage")).toEqual({ type: "route", route: "usage" });
    expect(parseSidebarEntry("session:agent:main:test")).toEqual({
      type: "session",
      key: "agent:main:test",
    });
    expect(parseSidebarEntry("workboard:ops")).toEqual({ type: "workboard", boardId: "ops" });
    expect(serializeSidebarEntry({ type: "route", route: "plugins" })).toBe("route:plugins");
    expect(serializeSidebarEntry({ type: "session", key: "agent:main:test" })).toBe(
      "session:agent:main:test",
    );
    expect(serializeSidebarEntry({ type: "workboard", boardId: "ops" })).toBe("workboard:ops");
  });

  it("normalizes persisted entries, dropping malformed and duplicate values", () => {
    expect(
      normalizeSidebarEntries([
        "route:usage",
        "session:agent:main:test",
        "route:tasks",
        "route:usage",
        "route:worktrees",
        "session:",
        "usage",
        7,
      ]),
    ).toEqual(["route:usage", "session:agent:main:test", "route:tasks"]);
    expect(normalizeSidebarEntries([])).toEqual([]);
  });

  it("keeps OpenClaw only in Settings and drops stale sidebar pins", () => {
    expect(SIDEBAR_NAV_ROUTES).not.toContain("custodian");
    expect(settingsRoutes).toContain("custodian");
    expect(isSettingsNavigationRoute("custodian")).toBe(true);
    expect(normalizeSidebarEntries(["route:custodian", "route:usage"])).toEqual(["route:usage"]);
  });

  it("falls back to null for non-list values so callers use defaults", () => {
    expect(normalizeSidebarEntries(undefined)).toBeNull();
    expect(normalizeSidebarEntries({ usage: true })).toBeNull();
    expect(normalizeSidebarEntries("route:usage")).toBeNull();
  });

  it("puts every hidden nav route into the More section", () => {
    const entries = ["route:tasks", "session:agent:main:test", "route:usage"] as const;
    const more = sidebarMoreRoutes(entries);
    expect(more).not.toContain("tasks");
    expect(more).not.toContain("usage");
    expect(new Set(["tasks", "usage", ...more])).toEqual(new Set(SIDEBAR_NAV_ROUTES));
  });
});
