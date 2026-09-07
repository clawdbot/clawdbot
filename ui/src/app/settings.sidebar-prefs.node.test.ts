// @vitest-environment node
// Sidebar zone and session-section persistence split from the settings suites
// to keep each file under the lint size budget.
import { describe, expect, it } from "vitest";
import {
  expectedGatewayUrl,
  installSettingsStorageLifecycle,
  makeUiSettings,
  setTestLocation,
} from "../test-helpers/settings-node.ts";
import { loadSettings, saveSettings } from "./settings.ts";

describe("sidebar preference persistence", () => {
  installSettingsStorageLifecycle();

  it("defaults old or invalid agent modes to chip and persists explicit roster mode", () => {
    setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
    const gatewayUrl = expectedGatewayUrl("");
    const key = `openclaw.control.settings.v1:${gatewayUrl}`;
    expect(loadSettings().sidebarAgentsMode).toBe("chip");
    for (const mode of ["roster", "chip"]) {
      saveSettings(
        makeUiSettings(gatewayUrl, { sidebarAgentsMode: mode === "roster" ? "roster" : "chip" }),
      );
      expect(loadSettings().sidebarAgentsMode).toBe(mode);
    }
    for (const mode of [undefined, true, "invalid", null]) {
      localStorage.setItem(
        key,
        JSON.stringify({ ...makeUiSettings(gatewayUrl), sidebarAgentsMode: mode }),
      );
      expect(loadSettings().sidebarAgentsMode).toBe("chip");
    }
  });

  it("persists sidebar width without leaking tab-local visibility across reloads", () => {
    setTestLocation({ protocol: "https:", host: "gateway.example:8443", pathname: "/" });
    const gatewayUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:${gatewayUrl}`;

    saveSettings(makeUiSettings(gatewayUrl, { navCollapsed: true, navWidth: 320 }));

    const persisted = JSON.parse(localStorage.getItem(scopedKey) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(persisted).not.toHaveProperty("navCollapsed");
    expect(persisted.navWidth).toBe(320);
    expect(loadSettings()).toMatchObject({ navCollapsed: false, navWidth: 320 });

    localStorage.setItem(scopedKey, JSON.stringify({ ...persisted, navCollapsed: true }));
    expect(loadSettings()).toMatchObject({ navCollapsed: false, navWidth: 320 });
  });

  it("persists sidebar entries across save and load, normalizing bad values", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    saveSettings(
      makeUiSettings(gwUrl, {
        sidebarEntries: ["route:tasks", "route:cron"],
        textScale: 100,
      }),
    );

    expect(loadSettings().sidebarEntries).toEqual(["route:tasks", "route:cron"]);
    expect(loadSettings().navWidth).toBe(258);

    // Corrupt the persisted list; load falls back to the default pinned set.
    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    const persisted = JSON.parse(localStorage.getItem(scopedKey) ?? "{}") as Record<
      string,
      unknown
    >;
    persisted.sidebarEntries = "route:tasks";
    persisted.navWidth = 220;
    localStorage.setItem(scopedKey, JSON.stringify(persisted));

    expect(loadSettings().sidebarEntries).toEqual([
      "route:agents-home",
      "route:dashboards",
      "route:cron",
      "route:plugins",
    ]);
    expect(loadSettings().navWidth).toBe(258);
  });

  it("migrates the legacy route-only list once and writes only sidebarEntries", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    const gwUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    const legacy = makeUiSettings(gwUrl) as unknown as Record<string, unknown>;
    delete legacy.sidebarEntries;
    legacy.sidebarPinnedRoutes = ["workboard", "usage", "tasks", "usage", "worktrees", 7];
    localStorage.setItem(scopedKey, JSON.stringify(legacy));

    expect(loadSettings().sidebarEntries).toEqual([
      "plugin:workboard/workboard",
      "route:usage",
      "route:tasks",
    ]);
    const migrated = JSON.parse(localStorage.getItem(scopedKey) ?? "{}") as Record<string, unknown>;
    expect(migrated.sidebarEntries).toEqual([
      "plugin:workboard/workboard",
      "route:usage",
      "route:tasks",
    ]);
    expect(migrated).not.toHaveProperty("sidebarPinnedRoutes");
  });
});
