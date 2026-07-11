// Browser tests cover server context.hot reload profiles plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningChrome } from "./chrome.js";
import type { ResolvedBrowserProfile } from "./config.js";
import {
  createProfileRuntimeState,
  enqueueProfileStart,
  getProfileLifecycle,
  getOrCreateProfileRuntime,
  isProfileGenerationCurrent,
} from "./server-context.lifecycle.js";
import type { BrowserServerState } from "./server-context.types.js";

type TestProfileConfig = {
  cdpPort?: number;
  cdpUrl?: string;
  color?: string;
  headless?: boolean;
  executablePath?: string;
  driver?: "openclaw" | "existing-session" | "extension";
  mcpCommand?: string;
  mcpArgs?: string[];
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
const lifecycleMocks = vi.hoisted(() => ({
  closeChromeMcpSession: vi.fn(async () => false),
  closePlaywrightBrowserConnection: vi.fn(async (_opts: { cdpUrl: string }) => {}),
  retirePlaywrightBrowserConnection: vi.fn((_opts: { cdpUrl: string }) => true),
  stopOpenClawChrome: vi.fn(async () => {}),
}));

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
    getRuntimeConfigSnapshot: () => null,
    getRuntimeConfig: () => {
      // simulate stale getRuntimeConfig that doesn't see updates unless cache cleared
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

vi.mock("./chrome.js", () => ({
  stopOpenClawChrome: lifecycleMocks.stopOpenClawChrome,
}));

vi.mock("./chrome-mcp.runtime.js", () => ({
  getChromeMcpModule: async () => ({
    closeChromeMcpSession: lifecycleMocks.closeChromeMcpSession,
  }),
}));

vi.mock("./pw-ai-module.js", () => ({
  getLoadedPwAiModule: () => ({
    retirePlaywrightBrowserConnectionExact: (opts: { cdpUrl: string }) => ({
      retired: lifecycleMocks.retirePlaywrightBrowserConnection(opts),
      close: async () => await lifecycleMocks.closePlaywrightBrowserConnection(opts),
    }),
  }),
  getPwAiModule: async () => null,
}));

const { getRuntimeConfig } = await import("../config/config.js");
const { resolveBrowserConfig, resolveProfile } = await import("./config.js");
const { refreshResolvedBrowserConfigFromDisk, resolveBrowserProfileWithHotReload } =
  await import("./resolved-config-refresh.js");

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function runtimeState(
  profile: ResolvedBrowserProfile,
  running: RunningChrome | null,
  lastTargetId: string | null,
) {
  return { ...createProfileRuntimeState(profile), running, lastTargetId };
}

describe("server-context hot-reload profiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycleMocks.closeChromeMcpSession.mockResolvedValue(false);
    lifecycleMocks.closePlaywrightBrowserConnection.mockResolvedValue(undefined);
    lifecycleMocks.retirePlaywrightBrowserConnection.mockReturnValue(true);
    lifecycleMocks.stopOpenClawChrome.mockResolvedValue(undefined);
    mockState.cfgProfiles = {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
    };
    mockState.cachedConfig = null; // Clear simulated cache
  });

  it("forProfile hot-reloads newly added profiles from config", () => {
    // Start with only openclaw profile
    // 1. Prime the cache by calling getRuntimeConfig() first
    const cfg = getRuntimeConfig();
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

    // 3. Verify without clearConfigCache, getRuntimeConfig() still returns stale cached value
    const staleCfg = getRuntimeConfig();
    expect(staleCfg.browser?.profiles?.desktop).toBeUndefined(); // Cache is stale!

    // 4. Hot-reload uses the refresh source without flushing the global getRuntimeConfig cache.
    const profile = resolveBrowserProfileWithHotReload({
      current: state,
      refreshConfigFromDisk: true,
      name: "desktop",
    });
    expect(profile?.name).toBe("desktop");
    expect(profile?.cdpUrl).toBe("http://127.0.0.1:9222");

    // 5. Verify the new profile was merged into the cached state
    expect(state.resolved.profiles).toHaveProperty("desktop");

    // 6. Verify GLOBAL cache was NOT cleared - subsequent simple getRuntimeConfig() still sees STALE value
    // This confirms the fix: we read fresh config for the specific profile lookup without flushing the global cache
    const stillStaleCfg = getRuntimeConfig();
    expect(stillStaleCfg.browser?.profiles?.desktop).toBeUndefined();
  });

  it("forProfile still throws for profiles that don't exist in fresh config", () => {
    const cfg = getRuntimeConfig();
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

  it("forProfile refreshes existing profile config after getRuntimeConfig cache updates", () => {
    const cfg = getRuntimeConfig();
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

  it("listProfiles refreshes config before enumerating profiles", () => {
    const cfg = getRuntimeConfig();
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
    });
    expect(Object.keys(state.resolved.profiles)).toContain("desktop");
  });

  it("captures the old profile before adopting changed invariants", async () => {
    const cfg = getRuntimeConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const openclawProfile = requireValue(
      resolveProfile(resolved, "openclaw"),
      "openclaw profile missing",
    );
    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map([
        ["openclaw", runtimeState(openclawProfile, { pid: 123 } as never, "tab-1")],
      ]),
    };

    mockState.cfgProfiles.openclaw = { cdpPort: 19999, color: "#FF4500" };
    mockState.cachedConfig = null;
    const oldCdpUrl = openclawProfile.cdpUrl;

    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
    });

    const runtime = requireValue(state.profiles.get("openclaw"), "openclaw runtime missing");
    expect(runtime.profile.cdpPort).toBe(19999);
    expect(runtime.lastTargetId).toBeNull();
    expect(getProfileLifecycle(runtime).transitionReason).toContain("cdpPort");
    expect(lifecycleMocks.retirePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: oldCdpUrl,
    });
    await getProfileLifecycle(runtime).tail;
    expect(lifecycleMocks.closePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: oldCdpUrl,
    });
  });

  it("marks local managed runtime state for reconcile when profile headless changes", () => {
    const cfg = getRuntimeConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const openclawProfile = requireValue(
      resolveProfile(resolved, "openclaw"),
      "openclaw profile missing",
    );
    expect(openclawProfile.headless).toBe(true);
    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map([
        ["openclaw", runtimeState(openclawProfile, { pid: 123 } as never, "tab-1")],
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
    });

    const runtime = requireValue(state.profiles.get("openclaw"), "openclaw runtime missing");
    expect(runtime.profile.headless).toBe(false);
    expect(runtime.lastTargetId).toBeNull();
    expect(getProfileLifecycle(runtime).transitionReason).toContain("headless");
  });

  it("marks local managed runtime state for reconcile when profile executablePath changes", () => {
    mockState.cfgProfiles.openclaw = {
      cdpPort: 18800,
      color: "#FF4500",
      executablePath: "/usr/bin/chrome-old",
    };
    mockState.cachedConfig = null;
    const cfg = getRuntimeConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const openclawProfile = requireValue(
      resolveProfile(resolved, "openclaw"),
      "openclaw profile missing",
    );
    expect(openclawProfile.executablePath).toBe("/usr/bin/chrome-old");
    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map([
        ["openclaw", runtimeState(openclawProfile, { pid: 123 } as never, "tab-1")],
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
    });

    const runtime = requireValue(state.profiles.get("openclaw"), "openclaw runtime missing");
    expect(runtime.profile.executablePath).toBe("/usr/bin/chrome-new");
    expect(runtime.lastTargetId).toBeNull();
    expect(getProfileLifecycle(runtime).transitionReason).toContain("executablePath");
  });

  it("does not reconcile existing-session runtime when only headless changes", () => {
    mockState.cfgProfiles.remote = {
      cdpUrl: "http://127.0.0.1:9222",
      color: "#0066CC",
      headless: true,
      driver: "existing-session",
    };

    const cfg = getRuntimeConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const remoteProfile = requireValue(
      resolveProfile(resolved, "remote"),
      "remote profile missing",
    );
    expect(remoteProfile.driver).toBe("existing-session");
    expect(remoteProfile.attachOnly).toBe(true);
    expect(remoteProfile.headless).toBe(true);

    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map([
        ["remote", runtimeState(remoteProfile, { pid: 456 } as never, "tab-remote")],
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
    });

    const runtime = requireValue(state.profiles.get("remote"), "remote runtime missing");
    expect(runtime.profile.driver).toBe("existing-session");
    expect(runtime.profile.headless).toBe(false);
    expect(runtime.lastTargetId).toBe("tab-remote");
    expect(getProfileLifecycle(runtime).transitionReason).toBeNull();
  });

  it("does not reconcile remote cdp runtime when only headless changes", () => {
    mockState.cfgProfiles.remote = {
      cdpUrl: "http://10.0.0.42:9222",
      color: "#0066CC",
      headless: true,
    };

    const cfg = getRuntimeConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const remoteProfile = requireValue(
      resolveProfile(resolved, "remote"),
      "remote profile missing",
    );
    expect(remoteProfile.driver).toBe("openclaw");
    expect(remoteProfile.attachOnly).toBe(false);
    expect(remoteProfile.cdpIsLoopback).toBe(false);
    expect(remoteProfile.headless).toBe(true);

    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map([
        ["remote", runtimeState(remoteProfile, { pid: 789 } as never, "tab-remote-cdp")],
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
    });

    const runtime = requireValue(state.profiles.get("remote"), "remote runtime missing");
    expect(runtime.profile.driver).toBe("openclaw");
    expect(runtime.profile.cdpIsLoopback).toBe(false);
    expect(runtime.profile.headless).toBe(false);
    expect(runtime.lastTargetId).toBe("tab-remote-cdp");
    expect(getProfileLifecycle(runtime).transitionReason).toBeNull();
  });

  it("reconciles existing-session command and structural argument changes", () => {
    mockState.cfgProfiles.work = {
      cdpUrl: "http://127.0.0.1:9222",
      color: "#0066CC",
      driver: "existing-session",
      mcpCommand: "/old/mcp",
      mcpArgs: ["--one"],
    };
    const cfg = getRuntimeConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const work = requireValue(resolveProfile(resolved, "work"), "work profile missing");
    const runtime = createProfileRuntimeState(work);
    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map([["work", runtime]]),
    };

    mockState.cfgProfiles.work = {
      ...mockState.cfgProfiles.work,
      mcpCommand: "/new/mcp",
      mcpArgs: ["--one", "--two"],
    };
    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
    });

    expect(getProfileLifecycle(runtime).transitionReason).toContain("mcpCommand");
    expect(getProfileLifecycle(runtime).transitionReason).toContain("mcpArgs");
    expect(getProfileLifecycle(runtime).configRevision).toBe(1);
  });

  it("invalidates a pending A start before adopting B", async () => {
    mockState.cfgProfiles.work = { cdpPort: 18801, color: "#0066CC" };
    const cfg = getRuntimeConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const workA = requireValue(resolveProfile(resolved, "work"), "work A missing");
    const runtime = createProfileRuntimeState(workA);
    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map([["work", runtime]]),
    };
    const launchA = deferred();
    const launchAStarted = deferred();
    const adopted: string[] = [];
    const revisionA = getProfileLifecycle(runtime).configRevision;
    const pendingA = enqueueProfileStart({
      state,
      runtime,
      configRevision: revisionA,
      key: "default",
      run: async (signal, generation) => {
        launchAStarted.resolve();
        await launchA.promise;
        if (
          !isProfileGenerationCurrent({ state, runtime, configRevision: revisionA, generation })
        ) {
          throw signal.reason ?? new Error("A was superseded");
        }
        adopted.push(workA.cdpUrl);
      },
    });
    await launchAStarted.promise;

    mockState.cfgProfiles.work = { cdpPort: 18802, color: "#00AA00" };
    refreshResolvedBrowserConfigFromDisk({ current: state, refreshConfigFromDisk: true });
    const workB = requireValue(resolveProfile(state.resolved, "work"), "work B missing");
    expect(runtime.profile.cdpUrl).toBe(workB.cdpUrl);

    launchA.resolve();
    await expect(pendingA).rejects.toThrow(/profile invariants changed|superseded/i);
    await getProfileLifecycle(runtime).tail;
    await expect(
      enqueueProfileStart({
        state,
        runtime,
        configRevision: getProfileLifecycle(runtime).configRevision,
        key: "default",
        run: async () => {
          adopted.push(runtime.profile.cdpUrl);
        },
      }),
    ).resolves.toBeUndefined();

    expect(adopted).toEqual([workB.cdpUrl]);
  });

  it("rapid A to B to C closes both stale endpoints and adopts only C", async () => {
    mockState.cfgProfiles.work = { cdpPort: 18801, color: "#0066CC" };
    const cfg = getRuntimeConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const workA = requireValue(resolveProfile(resolved, "work"), "work A missing");
    const runtime = createProfileRuntimeState(workA);
    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map([["work", runtime]]),
    };
    const retired = new Set<string>();
    lifecycleMocks.retirePlaywrightBrowserConnection.mockImplementation(({ cdpUrl }) => {
      if (retired.has(cdpUrl)) {
        return false;
      }
      retired.add(cdpUrl);
      return true;
    });

    mockState.cfgProfiles.work = { cdpPort: 18802, color: "#00AA00" };
    refreshResolvedBrowserConfigFromDisk({ current: state, refreshConfigFromDisk: true });
    const workB = requireValue(resolveProfile(state.resolved, "work"), "work B missing");
    const adopted: string[] = [];
    const pendingB = enqueueProfileStart({
      state,
      runtime,
      configRevision: getProfileLifecycle(runtime).configRevision,
      key: "default",
      run: async () => {
        adopted.push(workB.cdpUrl);
      },
    });

    mockState.cfgProfiles.work = { cdpPort: 18803, color: "#AA00AA" };
    refreshResolvedBrowserConfigFromDisk({ current: state, refreshConfigFromDisk: true });
    const workC = requireValue(resolveProfile(state.resolved, "work"), "work C missing");
    expect(runtime.profile.cdpUrl).toBe(workC.cdpUrl);

    await expect(pendingB).rejects.toThrow(/profile config changed|superseded/i);
    await getProfileLifecycle(runtime).tail;
    await expect(
      enqueueProfileStart({
        state,
        runtime,
        configRevision: getProfileLifecycle(runtime).configRevision,
        key: "default",
        run: async () => {
          adopted.push(runtime.profile.cdpUrl);
        },
      }),
    ).resolves.toBeUndefined();

    expect(lifecycleMocks.closePlaywrightBrowserConnection.mock.calls).toEqual([
      [{ cdpUrl: workA.cdpUrl }],
      [{ cdpUrl: workB.cdpUrl }],
    ]);
    expect(adopted).toEqual([workC.cdpUrl]);
  });

  it("keeps a removed-name tombstone until a pending start cleans its late handle", async () => {
    mockState.cfgProfiles.work = { cdpPort: 18801, color: "#0066CC" };
    const cfg = getRuntimeConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const workA = requireValue(resolveProfile(resolved, "work"), "work profile missing");
    const oldRuntime = createProfileRuntimeState(workA);
    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map([["work", oldRuntime]]),
    };
    expect(oldRuntime.running).toBeNull();
    const lateRunning = { pid: 321 } as RunningChrome;
    const launch = deferred();
    const launchStarted = deferred();
    const pendingStart = enqueueProfileStart({
      state,
      runtime: oldRuntime,
      configRevision: getProfileLifecycle(oldRuntime).configRevision,
      key: "default",
      run: async () => {
        launchStarted.resolve();
        await launch.promise;
        getProfileLifecycle(oldRuntime).handles.add(lateRunning);
      },
    });
    await launchStarted.promise;

    delete mockState.cfgProfiles.work;
    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
    });
    expect(getProfileLifecycle(oldRuntime).terminal).toBe("config-removed");
    expect(state.profiles.get("work")).toBe(oldRuntime);

    mockState.cfgProfiles.work = { cdpPort: 18802, color: "#00AA00" };
    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
    });
    const workB = requireValue(resolveProfile(state.resolved, "work"), "work B missing");
    expect(getOrCreateProfileRuntime(state, workB)).toBe(oldRuntime);
    expect(() =>
      enqueueProfileStart({
        state,
        runtime: oldRuntime,
        configRevision: getProfileLifecycle(oldRuntime).configRevision,
        key: "default",
        run: async () => {},
      }),
    ).toThrow(/config-removed/);

    launch.resolve();
    await expect(pendingStart).rejects.toThrow(/config-removed|lifecycle changed/i);
    await getProfileLifecycle(oldRuntime).tail;
    await Promise.resolve();
    expect(state.profiles.has("work")).toBe(false);
    expect(lifecycleMocks.stopOpenClawChrome).toHaveBeenCalledOnce();
    expect(lifecycleMocks.stopOpenClawChrome).toHaveBeenCalledWith(lateRunning);
    const replacement = getOrCreateProfileRuntime(state, workB);
    expect(replacement).not.toBe(oldRuntime);
    await expect(
      enqueueProfileStart({
        state,
        runtime: replacement,
        configRevision: getProfileLifecycle(replacement).configRevision,
        key: "default",
        run: async () => {},
      }),
    ).resolves.toBeUndefined();
    expect(lifecycleMocks.closePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: workA.cdpUrl,
    });
  });

  it("retries a failed removal tombstone before admitting a same-name re-add", async () => {
    mockState.cfgProfiles.work = { cdpPort: 18801, color: "#0066CC" };
    const cfg = getRuntimeConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const workA = requireValue(resolveProfile(resolved, "work"), "work profile missing");
    const oldRuntime = createProfileRuntimeState(workA);
    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map([["work", oldRuntime]]),
    };
    lifecycleMocks.closePlaywrightBrowserConnection
      .mockRejectedValueOnce(new Error("close failed"))
      .mockResolvedValue(undefined);
    lifecycleMocks.retirePlaywrightBrowserConnection
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    delete mockState.cfgProfiles.work;
    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
    });
    await getProfileLifecycle(oldRuntime).tail;
    expect(getProfileLifecycle(oldRuntime).blockedReason).toContain("cleanup failed");
    expect(state.profiles.get("work")).toBe(oldRuntime);

    mockState.cfgProfiles.work = { cdpPort: 18802, color: "#00AA00" };
    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
    });
    await getProfileLifecycle(oldRuntime).tail;
    await Promise.resolve();

    expect(state.profiles.has("work")).toBe(false);
    expect(lifecycleMocks.closePlaywrightBrowserConnection).toHaveBeenCalledTimes(2);
  });

  it("retries failed invariant cleanup before admitting the updated profile", async () => {
    mockState.cfgProfiles.work = { cdpPort: 18801, color: "#0066CC" };
    const cfg = getRuntimeConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const workA = requireValue(resolveProfile(resolved, "work"), "work profile missing");
    const runtime = createProfileRuntimeState(workA);
    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map([["work", runtime]]),
    };
    lifecycleMocks.closePlaywrightBrowserConnection
      .mockRejectedValueOnce(new Error("close failed"))
      .mockResolvedValue(undefined);

    mockState.cfgProfiles.work = { cdpPort: 18802, color: "#00AA00" };
    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
    });
    await getProfileLifecycle(runtime).tail;
    expect(getProfileLifecycle(runtime).blockedReason).toContain("cleanup failed");

    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
    });
    await getProfileLifecycle(runtime).tail;

    expect(getProfileLifecycle(runtime).blockedReason).toBeNull();
    expect(runtime.profile.cdpPort).toBe(18802);
    expect(lifecycleMocks.retirePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: workA.cdpUrl,
    });
    expect(lifecycleMocks.closePlaywrightBrowserConnection).toHaveBeenCalledTimes(2);
    expect(lifecycleMocks.closePlaywrightBrowserConnection).toHaveBeenNthCalledWith(1, {
      cdpUrl: workA.cdpUrl,
    });
    expect(lifecycleMocks.closePlaywrightBrowserConnection).toHaveBeenNthCalledWith(2, {
      cdpUrl: workA.cdpUrl,
    });
    await expect(
      enqueueProfileStart({
        state,
        runtime,
        configRevision: getProfileLifecycle(runtime).configRevision,
        key: "default",
        run: async () => {},
      }),
    ).resolves.toBeUndefined();
  });
});
