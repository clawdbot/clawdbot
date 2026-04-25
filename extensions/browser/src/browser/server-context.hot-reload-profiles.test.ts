import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserServerState } from "./server-context.types.js";

type TestProfileConfig = {
  cdpPort?: number;
  cdpUrl?: string;
  color?: string;
  headless?: boolean;
  executablePath?: string;
  driver?: "openclaw" | "existing-session";
};
type TestConfig = {
  browser: {
    enabled: true;
    color: string;
    headless: true;
    defaultProfile: string;
    profiles: Record<string, TestProfileConfig>;
  };
};

const mockState = vi.hoisted(
  () =>
    ({
      cfgProfiles: {} as Record<string, TestProfileConfig>,
      cachedConfig: null as TestConfig | null,
    }) satisfies {
      cfgProfiles: Record<string, TestProfileConfig>;
      cachedConfig: TestConfig | null;
    },
);

function buildConfig(): TestConfig {
  return {
    browser: {
      enabled: true,
      color: "#FF4500",
      headless: true,
      defaultProfile: "openclaw",
      profiles: { ...mockState.cfgProfiles },
    },
  };
}

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    createConfigIO: () => ({
      loadConfig: () => {
        // Always return fresh config for createConfigIO to simulate fresh disk read
        return buildConfig();
      },
    }),
    getRuntimeConfigSnapshot: () => null,
    loadConfig: () => {
      // simulate stale loadConfig that doesn't see updates unless cache cleared
      if (!mockState.cachedConfig) {
        mockState.cachedConfig = buildConfig();
      }
      return mockState.cachedConfig;
    },
    writeConfigFile: vi.fn(async () => {}),
  };
});

vi.mock("./config-refresh-source.js", () => ({
  loadBrowserConfigForRuntimeRefresh: () => buildConfig(),
}));

const { loadConfig } = await import("../config/config.js");
const { resolveBrowserConfig, resolveProfile } = await import("./config.js");
const { refreshResolvedBrowserConfigFromDisk, resolveBrowserProfileWithHotReload } =
  await import("./resolved-config-refresh.js");

describe("server-context hot-reload profiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.cfgProfiles = {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
    };
    mockState.cachedConfig = null; // Clear simulated cache
  });

  it("forProfile hot-reloads newly added profiles from config", async () => {
    // Start with only openclaw profile
    // 1. Prime the cache by calling loadConfig() first
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);

    // Verify cache is primed (without desktop)
    expect(cfg.browser?.profiles?.desktop).toBeUndefined();
    const state = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map(),
    };

    // Initially, "desktop" profile should not exist
    expect(
      resolveBrowserProfileWithHotReload({
        current: state,
        refreshConfigFromDisk: true,
        name: "desktop",
      }),
    ).toBeNull();

    // 2. Simulate adding a new profile to config (like user editing openclaw.json)
    mockState.cfgProfiles.desktop = { cdpUrl: "http://127.0.0.1:9222", color: "#0066CC" };

    // 3. Verify without clearConfigCache, loadConfig() still returns stale cached value
    const staleCfg = loadConfig();
    expect(staleCfg.browser?.profiles?.desktop).toBeUndefined(); // Cache is stale!

    // 4. Hot-reload should read fresh config for the lookup (createConfigIO().loadConfig()),
    // without flushing the global loadConfig cache.
    const profile = resolveBrowserProfileWithHotReload({
      current: state,
      refreshConfigFromDisk: true,
      name: "desktop",
    });
    expect(profile?.name).toBe("desktop");
    expect(profile?.cdpUrl).toBe("http://127.0.0.1:9222");

    // 5. Verify the new profile was merged into the cached state
    expect(state.resolved.profiles.desktop).toBeDefined();

    // 6. Verify GLOBAL cache was NOT cleared - subsequent simple loadConfig() still sees STALE value
    // This confirms the fix: we read fresh config for the specific profile lookup without flushing the global cache
    const stillStaleCfg = loadConfig();
    expect(stillStaleCfg.browser?.profiles?.desktop).toBeUndefined();
  });

  it("forProfile still throws for profiles that don't exist in fresh config", async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const state = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map(),
    };

    // Profile that doesn't exist anywhere should still throw
    expect(
      resolveBrowserProfileWithHotReload({
        current: state,
        refreshConfigFromDisk: true,
        name: "nonexistent",
      }),
    ).toBeNull();
  });

  it("forProfile refreshes existing profile config after loadConfig cache updates", async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const state = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map(),
    };

    mockState.cfgProfiles.openclaw = { cdpPort: 19999, color: "#FF4500" };
    mockState.cachedConfig = null;

    const after = resolveBrowserProfileWithHotReload({
      current: state,
      refreshConfigFromDisk: true,
      name: "openclaw",
    });
    expect(after?.cdpPort).toBe(19999);
    expect(state.resolved.profiles.openclaw?.cdpPort).toBe(19999);
  });

  it("listProfiles refreshes config before enumerating profiles", async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const state = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map(),
    };

    mockState.cfgProfiles.desktop = { cdpPort: 19999, color: "#0066CC" };
    mockState.cachedConfig = null;

    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
      mode: "cached",
    });
    expect(Object.keys(state.resolved.profiles)).toContain("desktop");
  });

  it("marks existing runtime state for reconcile when profile invariants change", async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const openclawProfile = resolveProfile(resolved, "openclaw");
    expect(openclawProfile).toBeTruthy();
    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map([
        [
          "openclaw",
          {
            profile: openclawProfile!,
            running: { pid: 123 } as never,
            lastTargetId: "tab-1",
            reconcile: null,
          },
        ],
      ]),
    };

    mockState.cfgProfiles.openclaw = { cdpPort: 19999, color: "#FF4500" };
    mockState.cachedConfig = null;

    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
      mode: "cached",
    });

    const runtime = state.profiles.get("openclaw");
    expect(runtime).toBeTruthy();
    expect(runtime?.profile.cdpPort).toBe(19999);
    expect(runtime?.lastTargetId).toBeNull();
    expect(runtime?.reconcile?.reason).toContain("cdpPort");
  });

  it("marks local managed runtime state for reconcile when profile headless changes", async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const openclawProfile = resolveProfile(resolved, "openclaw");
    expect(openclawProfile).toBeTruthy();
    expect(openclawProfile?.headless).toBe(true);
    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map([
        [
          "openclaw",
          {
            profile: openclawProfile!,
            running: { pid: 123 } as never,
            lastTargetId: "tab-1",
            reconcile: null,
          },
        ],
      ]),
    };

    mockState.cfgProfiles.openclaw = {
      cdpPort: 18800,
      color: "#FF4500",
      headless: false,
    };
    mockState.cachedConfig = null;

    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
      mode: "cached",
    });

    const runtime = state.profiles.get("openclaw");
    expect(runtime).toBeTruthy();
    expect(runtime?.profile.headless).toBe(false);
    expect(runtime?.lastTargetId).toBeNull();
    expect(runtime?.reconcile?.reason).toContain("headless");
  });

  it("marks local managed runtime state for reconcile when profile executablePath changes", async () => {
    mockState.cfgProfiles.openclaw = {
      cdpPort: 18800,
      color: "#FF4500",
      executablePath: "/usr/bin/chrome-old",
    };
    mockState.cachedConfig = null;
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const openclawProfile = resolveProfile(resolved, "openclaw");
    expect(openclawProfile).toBeTruthy();
    expect(openclawProfile?.executablePath).toBe("/usr/bin/chrome-old");
    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map([
        [
          "openclaw",
          {
            profile: openclawProfile!,
            running: { pid: 123 } as never,
            lastTargetId: "tab-1",
            reconcile: null,
          },
        ],
      ]),
    };

    mockState.cfgProfiles.openclaw = {
      cdpPort: 18800,
      color: "#FF4500",
      executablePath: "/usr/bin/chrome-new",
    };
    mockState.cachedConfig = null;

    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
      mode: "cached",
    });

    const runtime = state.profiles.get("openclaw");
    expect(runtime).toBeTruthy();
    expect(runtime?.profile.executablePath).toBe("/usr/bin/chrome-new");
    expect(runtime?.lastTargetId).toBeNull();
    expect(runtime?.reconcile?.reason).toContain("executablePath");
  });

  it("does not reconcile existing-session runtime when only headless changes", async () => {
    mockState.cfgProfiles.remote = {
      cdpUrl: "http://127.0.0.1:9222",
      color: "#0066CC",
      headless: true,
      driver: "existing-session",
    };

    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const remoteProfile = resolveProfile(resolved, "remote");
    expect(remoteProfile).toBeTruthy();
    expect(remoteProfile?.driver).toBe("existing-session");
    expect(remoteProfile?.attachOnly).toBe(true);
    expect(remoteProfile?.headless).toBe(true);

    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map([
        [
          "remote",
          {
            profile: remoteProfile!,
            running: { pid: 456 } as never,
            lastTargetId: "tab-remote",
            reconcile: null,
          },
        ],
      ]),
    };

    mockState.cfgProfiles.remote = {
      cdpUrl: "http://127.0.0.1:9222",
      color: "#0066CC",
      headless: false,
      driver: "existing-session",
    };
    mockState.cachedConfig = null;

    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
      mode: "cached",
    });

    const runtime = state.profiles.get("remote");
    expect(runtime).toBeTruthy();
    expect(runtime?.profile.driver).toBe("existing-session");
    expect(runtime?.profile.headless).toBe(false);
    expect(runtime?.lastTargetId).toBe("tab-remote");
    expect(runtime?.reconcile).toBeNull();
  });

  it("does not reconcile remote cdp runtime when only headless changes", async () => {
    mockState.cfgProfiles.remote = {
      cdpUrl: "http://10.0.0.42:9222",
      color: "#0066CC",
      headless: true,
    };

    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const remoteProfile = resolveProfile(resolved, "remote");
    expect(remoteProfile).toBeTruthy();
    expect(remoteProfile?.driver).toBe("openclaw");
    expect(remoteProfile?.attachOnly).toBe(false);
    expect(remoteProfile?.cdpIsLoopback).toBe(false);
    expect(remoteProfile?.headless).toBe(true);

    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map([
        [
          "remote",
          {
            profile: remoteProfile!,
            running: { pid: 789 } as never,
            lastTargetId: "tab-remote-cdp",
            reconcile: null,
          },
        ],
      ]),
    };

    mockState.cfgProfiles.remote = {
      cdpUrl: "http://10.0.0.42:9222",
      color: "#0066CC",
      headless: false,
    };
    mockState.cachedConfig = null;

    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
      mode: "cached",
    });

    const runtime = state.profiles.get("remote");
    expect(runtime).toBeTruthy();
    expect(runtime?.profile.driver).toBe("openclaw");
    expect(runtime?.profile.cdpIsLoopback).toBe(false);
    expect(runtime?.profile.headless).toBe(false);
    expect(runtime?.lastTargetId).toBe("tab-remote-cdp");
    expect(runtime?.reconcile).toBeNull();
  });
});
