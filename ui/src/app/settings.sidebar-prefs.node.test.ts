// @vitest-environment node
// Sidebar zone and session-section persistence split from settings.node.test.ts
// to keep both files under the lint size budget.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { loadSettings, saveSettings, type UiSettings } from "./settings.ts";

function setTestLocation(params: { protocol: string; host: string; pathname: string }) {
  vi.stubGlobal("location", {
    protocol: params.protocol,
    host: params.host,
    hostname: params.host.replace(/:\d+$/, ""),
    pathname: params.pathname,
  } as Location);
}

function expectedGatewayUrl(basePath: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${basePath}`;
}

function makeSettings(gatewayUrl: string, overrides: Partial<UiSettings> = {}): UiSettings {
  return {
    gatewayUrl,
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "system",
    chatShowThinking: true,
    chatShowToolCalls: true,
    navCollapsed: false,
    navWidth: 258,
    sidebarEntries: [],
    ...overrides,
  };
}

describe("sidebar preference persistence", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
    saveSettings(loadSettings());
    vi.unstubAllGlobals();
  });

  it("persists sidebar entries across save and load, normalizing bad values", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    saveSettings(
      makeSettings(gwUrl, {
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

    expect(loadSettings().sidebarEntries).toEqual(["route:cron", "route:plugins"]);
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
    const legacy = makeSettings(gwUrl) as unknown as Record<string, unknown>;
    delete legacy.sidebarEntries;
    legacy.sidebarPinnedRoutes = ["workboard", "usage", "tasks", "usage", "worktrees", 7];
    localStorage.setItem(scopedKey, JSON.stringify(legacy));

    expect(loadSettings().sidebarEntries).toEqual([
      "route:workboard",
      "route:usage",
      "route:tasks",
    ]);
    const migrated = JSON.parse(localStorage.getItem(scopedKey) ?? "{}") as Record<string, unknown>;
    expect(migrated.sidebarEntries).toEqual(["route:workboard", "route:usage", "route:tasks"]);
    expect(migrated).not.toHaveProperty("sidebarPinnedRoutes");
  });
});
