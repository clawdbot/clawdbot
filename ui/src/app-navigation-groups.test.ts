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
  isSettingsNavigationRouteVisible,
} from "./app-navigation.ts";
import type { NativeDeviceSettingsCapability } from "./app/native-device-settings.ts";
import { readGatewayOperatorAccess } from "./app/operator-access.ts";
import { getStaticCommandPaletteCatalogItems } from "./components/command-palette-catalog-search.ts";
import { findSettingsSearchBlocks } from "./pages/config/settings-search.ts";
import {
  createIosNativeDeviceSettingsSnapshot,
  createNativeDeviceSettingsSnapshot,
} from "./test-helpers/native-device-settings.ts";

const settingsGroups = visibleSettingsNavigationGroups(true);
const settingsRoutes = settingsGroups.flatMap((group) => group.routes);

describe("sidebar entries", () => {
  it.each([true, false])("shows device settings only with the capability, admin=%s", (canAdmin) => {
    const capability: NativeDeviceSettingsCapability = {
      snapshot: createNativeDeviceSettingsSnapshot(),
      subscribe: () => () => undefined,
      set: () => undefined,
      requestPermission: () => undefined,
      openSystemSettings: () => undefined,
      openPanel: () => undefined,
      checkForUpdates: () => undefined,
      installChromeExtension: async () => ({
        nativeHostRegistered: false,
        installRequested: false,
        discoveredProfiles: 0,
      }),
      refresh: () => undefined,
      dispose: () => undefined,
    };
    const search = (query: string, nativeDeviceSettings: NativeDeviceSettingsCapability | null) =>
      findSettingsSearchBlocks({
        query,
        schema: null,
        value: null,
        uiHints: {},
        canAdmin,
        nativeDeviceSettings,
      });
    expect(search("Dock icon", null)).toEqual([]);
    expect(search("Dock icon", capability)).toContainEqual(
      expect.objectContaining({ routeId: "device" }),
    );
    expect(search("computer presence", null)).toEqual([]);
    expect(search("computer presence", capability)).toContainEqual(
      expect.objectContaining({ routeId: "device-permissions" }),
    );
    const browserGroups = visibleSettingsNavigationGroups(canAdmin);
    const nativeGroups = visibleSettingsNavigationGroups(canAdmin, capability);
    expect(browserGroups.flatMap((group) => group.routes).includes("updates")).toBe(canAdmin);
    expect(nativeGroups.flatMap((group) => group.routes)).toContain("updates");
    expect(isSettingsNavigationRouteVisible("updates", canAdmin)).toBe(canAdmin);
    expect(isSettingsNavigationRouteVisible("updates", canAdmin, capability)).toBe(true);
    expect(search("Check for updates", capability)).toContainEqual(
      expect.objectContaining({ routeId: "updates" }),
    );
    expect(
      getStaticCommandPaletteCatalogItems(canAdmin, capability).some(
        (item) => item.routeId === "updates",
      ),
    ).toBe(true);
    expect(browserGroups.some((group) => group.labelKey === "nav.settingsGroupDevice")).toBe(false);
    expect(nativeGroups[1]).toEqual({
      labelKey: "nav.settingsGroupDevice",
      routes: ["device", "device-permissions"],
    });
    expect(
      visibleSettingsNavigationGroups(canAdmin, { ...capability, snapshot: null })[1]?.labelKey,
    ).toBe("nav.settingsGroupThisDevice");
    const iosSnapshot = createIosNativeDeviceSettingsSnapshot();
    iosSnapshot.voice.speakerphoneEnabled = false;
    for (const [formFactor, labelKey] of [
      ["phone", "nav.settingsGroupThisIPhone"],
      ["pad", "nav.settingsGroupThisIPad"],
      ["desktop", "nav.settingsGroupThisDevice"],
      [undefined, "nav.settingsGroupThisDevice"],
    ] as const) {
      iosSnapshot.device.formFactor = formFactor;
      expect(
        visibleSettingsNavigationGroups(canAdmin, { ...capability, snapshot: iosSnapshot })[1]
          ?.labelKey,
      ).toBe(labelKey);
    }
    const iosCapability = { ...capability, snapshot: iosSnapshot };
    for (const [query, routeId] of [
      ["Health summaries", "device"],
      ["Apple Watch", "device"],
      ["Contacts", "device-permissions"],
      ["Photos", "device-permissions"],
      ["Use speakerphone", "talk"],
      ["Talk in the background", "talk"],
    ] as const) {
      expect(search(query, iosCapability)).toContainEqual(expect.objectContaining({ routeId }));
      expect(search(query, null)).toEqual([]);
      expect(search(query, capability)).toEqual([]);
      expect(search(query, { ...capability, snapshot: null })).toEqual([]);
    }
    for (const query of [
      "Dock icon",
      "Launch at login",
      "Quick Chat",
      "Cookie sync",
      "computer presence",
    ]) {
      expect(search(query, capability)).not.toEqual([]);
      expect(search(query, iosCapability)).toEqual([]);
    }
    const sparseIosSnapshot = createIosNativeDeviceSettingsSnapshot();
    sparseIosSnapshot.capabilities!.healthSummaryAvailable = false;
    delete sparseIosSnapshot.voice.speakerphoneEnabled;
    sparseIosSnapshot.permissions.entries = sparseIosSnapshot.permissions.entries.filter(
      (entry) => entry.id !== "contacts",
    );
    for (const query of ["Health summaries", "Use speakerphone", "Contacts"]) {
      expect(search(query, { ...capability, snapshot: sparseIosSnapshot })).toEqual([]);
    }
    for (const route of ["device", "device-permissions"] as const) {
      expect(isSettingsNavigationRouteVisible(route, canAdmin)).toBe(false);
      expect(isSettingsNavigationRouteVisible(route, canAdmin, capability)).toBe(true);
      expect(browserGroups.flatMap((group) => group.routes)).not.toContain(route);
      expect(
        getStaticCommandPaletteCatalogItems(canAdmin).some((item) => item.routeId === route),
      ).toBe(false);
      expect(
        getStaticCommandPaletteCatalogItems(canAdmin, capability).some(
          (item) => item.routeId === route,
        ),
      ).toBe(true);
    }
  });
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
      "plugin:workboard/workboard",
      "plugin:workboard/board-ops",
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
    expect(parseSidebarEntry("workboard:ops")).toEqual({
      type: "plugin",
      key: "workboard/board-ops",
    });
    expect(serializeSidebarEntry({ type: "route", route: "plugins" })).toBe("route:plugins");
    expect(serializeSidebarEntry({ type: "session", key: "agent:main:test" })).toBe(
      "session:agent:main:test",
    );
    expect(serializeSidebarEntry({ type: "plugin", key: "workboard/board-ops" })).toBe(
      "plugin:workboard/board-ops",
    );
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
