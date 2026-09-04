// Control UI tests cover sidebar entry customization behavior.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_ENTRIES,
  SIDEBAR_NAV_ROUTES,
  isSessionsHubRoute,
  isSettingsNavigationRoute,
  normalizeSidebarEntries,
  parseSidebarEntry,
  serializeSidebarEntry,
  settingsNavigationOwnerRoute,
  sidebarMoreRoutes,
  visibleSettingsNavigationGroups,
} from "./app-navigation.ts";
import { readGatewayOperatorAccess } from "./app/operator-access.ts";

const settingsGroups = visibleSettingsNavigationGroups(true);
const settingsRoutes = settingsGroups.flatMap((group) => group.routes);

describe("sidebar entries", () => {
  it("keeps operational destinations visible by default", () => {
    expect(DEFAULT_SIDEBAR_ENTRIES).toEqual(["route:dashboards", "route:cron", "route:plugins"]);
  });

  it("drops retired routes from persisted entries", () => {
    expect(normalizeSidebarEntries(["route:overview", "route:usage"])).toEqual(["route:usage"]);
  });

  it("treats worktrees as a sessions hub tab without its own pin", () => {
    expect(isSessionsHubRoute("sessions")).toBe(true);
    expect(isSessionsHubRoute("worktrees")).toBe(true);
    expect(isSessionsHubRoute("chat")).toBe(false);
    expect(normalizeSidebarEntries(["route:worktrees", "route:usage"])).toEqual(["route:usage"]);
  });

  it("preserves the shipped Workboard placement slot outside customizable routes", () => {
    expect(normalizeSidebarEntries(["route:workboard", "workboard:ops"])).toEqual([
      "route:workboard",
      "workboard:ops",
    ]);
    expect(sidebarMoreRoutes([])).not.toContain("workboard");
  });

  it("recognizes every settings navigation route", () => {
    expect(settingsRoutes.every((routeId) => isSettingsNavigationRoute(routeId))).toBe(true);
  });

  it("places Updates in the System group immediately before About", () => {
    const system = settingsGroups.find((group) => group.labelKey === "nav.settingsGroupSystem");
    expect(system?.routes.slice(-2)).toEqual(["updates", "about"]);
  });

  it("places team secrets between Privacy & Security and Approvals", () => {
    const security = settingsGroups.find((group) => group.labelKey === "nav.settingsGroupSecurity");
    expect(security?.routes).toEqual(["security", "secrets", "approvals"]);
  });

  it("keeps model setup as a settings subpage without a sidebar entry", () => {
    expect(isSettingsNavigationRoute("model-setup")).toBe(true);
    expect(settingsNavigationOwnerRoute("model-setup")).toBe("model-providers");
  });

  it("keeps Agent Defaults routed as an Agents subpage without a sidebar entry", () => {
    expect(isSettingsNavigationRoute("ai-agents")).toBe(true);
    expect(settingsNavigationOwnerRoute("ai-agents")).toBe("agents");
  });

  it("filters admin-only settings while preserving legacy fail-open visibility", () => {
    const nonAdminRoutes = visibleSettingsNavigationGroups(false).flatMap((group) => group.routes);
    expect(nonAdminRoutes).toContain("approvals");
    expect(nonAdminRoutes).toContain("channels");
    expect(nonAdminRoutes).not.toContain("security");
    expect(nonAdminRoutes).not.toContain("communications");

    const legacyCanAdmin = readGatewayOperatorAccess({
      hello: { auth: { role: "operator" } },
    } as Parameters<typeof readGatewayOperatorAccess>[0]).canAdmin;
    expect(legacyCanAdmin).toBe(true);
    expect(visibleSettingsNavigationGroups(legacyCanAdmin)).toEqual(
      visibleSettingsNavigationGroups(true),
    );
  });

  it("drops stale device pins", () => {
    expect(normalizeSidebarEntries(["route:nodes", "route:usage"])).toEqual(["route:usage"]);
  });

  it("keeps the apps promo page available in More", () => {
    expect(sidebarMoreRoutes(DEFAULT_SIDEBAR_ENTRIES)).toContain("apps");
    expect(isSettingsNavigationRoute("apps")).toBe(false);
  });

  it("keeps Portals available in More", () => {
    expect(sidebarMoreRoutes(DEFAULT_SIDEBAR_ENTRIES)).toContain("portals");
    expect(isSettingsNavigationRoute("portals")).toBe(false);
  });

  it("keeps the plugin manager in customizable workspace routes", () => {
    expect(normalizeSidebarEntries(["route:plugins", "route:usage", "route:plugins"])).toEqual([
      "route:plugins",
      "route:usage",
    ]);
    expect(sidebarMoreRoutes(["route:usage", "session:agent:main:test"])).toContain("plugins");
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

  it("recognizes OpenClaw settings and drops stale sidebar pins", () => {
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
