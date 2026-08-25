// Browser tests cover server context.hot reload profiles plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningChrome } from "./chrome.js";
import type { ResolvedBrowserProfile } from "./config.js";
import type { ExtensionRelayHandle } from "./extension-relay/relay-server.js";
import {
  beginProfileTransition,
  enqueueProfileStart,
  getProfileLifecycle,
  getOrCreateProfileRuntime,
  isProfileGenerationCurrent,
} from "./server-context.lifecycle.js";
import type { BrowserServerState, ProfileRuntimeState } from "./server-context.types.js";

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
  const runtime = { profile, running, lastTargetId };
  getProfileLifecycle(runtime);
  return runtime;
}

function createBrowserState() {
  const cfg = getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const state: BrowserServerState = {
    server: null,
    port: 18791,
    resolved,
    profiles: new Map(),
  };
  return { cfg, state };
}

function createProfileFixture(
  options: {
    name?: string;
    config?: TestProfileConfig;
    running?: RunningChrome | null;
    lastTargetId?: string | null;
  } = {},
) {
  const name = options.name ?? "openclaw";
  if (options.config) {
    mockState.cfgProfiles[name] = options.config;
    mockState.cachedConfig = null;
  }
  const { state } = createBrowserState();
  const profile = requireValue(resolveProfile(state.resolved, name), `${name} profile missing`);
  const runtime = runtimeState(profile, options.running ?? null, options.lastTargetId ?? null);
  state.profiles.set(name, runtime);
  return { state, profile, runtime };
}

function createExtensionRelayFixture(name = "chrome") {
  const fixture = createProfileFixture({
    name,
    config: { cdpPort: 18799, driver: "extension" },
    lastTargetId: "shared-tab",
  });
  const relay = {
    port: 18799,
    token: "persistent-relay-test-key",
    allowLegacyAuth: true,
    internalToken: `${name}-process-only-credential`,
    bridge: {} as ExtensionRelayHandle["bridge"],
    close: vi.fn(async () => {}),
  } satisfies ExtensionRelayHandle;
  fixture.state.extensionRelays = new Map([[name, relay]]);
  fixture.state.resolved = {
    ...fixture.state.resolved,
    extensionRelayInternalTokens: { [name]: relay.internalToken },
  };
  fixture.runtime.profile = requireValue(
    resolveProfile(fixture.state.resolved, name),
    `${name} extension profile missing`,
  );
  return { ...fixture, relay };
}

function refreshProfiles(state: BrowserServerState) {
  refreshResolvedBrowserConfigFromDisk({ current: state, refreshConfigFromDisk: true });
}

function updateProfile(
  state: BrowserServerState,
  name: string,
  config: TestProfileConfig,
  clearCachedConfig = false,
) {
  mockState.cfgProfiles[name] = config;
  if (clearCachedConfig) {
    mockState.cachedConfig = null;
  }
  refreshProfiles(state);
}

function enqueueCurrentProfileStart(
  state: BrowserServerState,
  runtime: ProfileRuntimeState,
  run: (signal: AbortSignal, generation: number) => Promise<void>,
) {
  return enqueueProfileStart({
    state,
    runtime,
    configRevision: getProfileLifecycle(runtime).configRevision,
    key: "default",
    run,
  });
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
    mockState.cachedConfig = null;
  });

  it("forProfile hot-reloads newly added profiles from config", () => {
    const { cfg, state } = createBrowserState();

    expect(cfg.browser?.profiles?.desktop).toBeUndefined();

    expect(
      resolveBrowserProfileWithHotReload({
        current: state,
        refreshConfigFromDisk: true,
        name: "desktop",
      }),
    ).toBeNull();

    mockState.cfgProfiles.desktop = { cdpUrl: "http://127.0.0.1:9222", color: "#0066CC" };

    const staleCfg = getRuntimeConfig();
    expect(staleCfg.browser?.profiles?.desktop).toBeUndefined();

    const profile = resolveBrowserProfileWithHotReload({
      current: state,
      refreshConfigFromDisk: true,
      name: "desktop",
    });
    expect(profile?.name).toBe("desktop");
    expect(profile?.cdpUrl).toBe("http://127.0.0.1:9222");

    expect(state.resolved.profiles).toHaveProperty("desktop");

    const stillStaleCfg = getRuntimeConfig();
    expect(stillStaleCfg.browser?.profiles?.desktop).toBeUndefined();
  });

  it("forProfile still throws for profiles that don't exist in fresh config", () => {
    const { state } = createBrowserState();

    // Profile that doesn't exist anywhere should still throw
    expect(
      resolveBrowserProfileWithHotReload({
        current: state,
        refreshConfigFromDisk: true,
        name: "nonexistent",
      }),
    ).toBeNull();
  });

  it.each(["constructor", "prototype"] as const)(
    "treats removed %s profiles as absent during hot reload",
    (profileName) => {
      mockState.cfgProfiles = {};
      const { state, runtime } = createProfileFixture({
        name: profileName,
        config: { cdpPort: 18801, color: "#0066CC" },
        running: { pid: 123 } as never,
        lastTargetId: "tab-1",
      });

      mockState.cfgProfiles = {};
      mockState.cachedConfig = null;
      refreshProfiles(state);

      expect(resolveProfile(state.resolved, profileName)).toBeNull();
      const actor = getProfileLifecycle(runtime);
      expect(actor.terminal).toBe("config-removed");
      expect(actor.transitionReason).toBe("profile removed from config");
    },
  );

  it("forProfile refreshes existing profile config after getRuntimeConfig cache updates", () => {
    const { state } = createBrowserState();

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

  it("keeps only exact live relay credentials stable across repeated profile refreshes", () => {
    const { state, runtime, relay } = createExtensionRelayFixture();
    const expectedUrl = runtime.profile.cdpUrl;
    const freshPersistentKey = resolveBrowserConfig(buildConfig().browser).extensionRelayToken;
    state.resolved = {
      ...state.resolved,
      extensionRelayToken: "stale-persistent-key",
      extensionRelayInternalTokens: {
        chrome: relay.internalToken,
        orphaned: "closed-relay-credential",
      },
    };

    for (let request = 0; request < 3; request += 1) {
      const resolved = resolveBrowserProfileWithHotReload({
        current: state,
        refreshConfigFromDisk: true,
        name: "chrome",
      });

      expect(resolved?.cdpUrl).toBe(expectedUrl);
      expect(state.extensionRelays?.get("chrome")).toBe(relay);
      expect(state.resolved.extensionRelayInternalTokens).toEqual({
        chrome: relay.internalToken,
      });
      expect(state.resolved.extensionRelayToken).toBe(freshPersistentKey);
      expect(getProfileLifecycle(runtime).configRevision).toBe(0);
      expect(runtime.lastTargetId).toBe("shared-tab");
    }
    expect(relay.close).not.toHaveBeenCalled();
  });

  it("does not carry a relay credential across a configured profile-port change", async () => {
    const { state, runtime, relay } = createExtensionRelayFixture();

    updateProfile(state, "chrome", { cdpPort: 18801, driver: "extension" });

    expect(state.resolved.extensionRelayInternalTokens).not.toHaveProperty("chrome");
    expect(runtime.profile.cdpPort).toBe(18801);
    expect(getProfileLifecycle(runtime).transitionReason).toContain("cdpPort");
    await getProfileLifecycle(runtime).tail;
    expect(relay.close).toHaveBeenCalledOnce();
    expect(state.extensionRelays?.has("chrome")).toBe(false);
  });

  it("revokes only the exact closed relay credential after lifecycle cleanup", async () => {
    const { state, runtime, relay } = createExtensionRelayFixture();
    state.resolved.extensionRelayInternalTokens.work = "other-live-profile-credential";

    await beginProfileTransition({
      state,
      runtime,
      reason: "extension relay stopped",
      closeRelay: true,
    });

    expect(relay.close).toHaveBeenCalledOnce();
    expect(state.extensionRelays?.has("chrome")).toBe(false);
    expect(state.resolved.extensionRelayInternalTokens).toEqual({
      work: "other-live-profile-credential",
    });
  });

  it("preserves a replacement relay credential when an older handle finishes closing", async () => {
    const { state, runtime, relay } = createExtensionRelayFixture();
    const replacement = {
      ...relay,
      internalToken: "replacement-process-only-credential",
      close: vi.fn(async () => {}),
    } satisfies ExtensionRelayHandle;
    relay.close.mockImplementationOnce(async () => {
      state.extensionRelays?.set("chrome", replacement);
      state.resolved = {
        ...state.resolved,
        extensionRelayInternalTokens: { chrome: replacement.internalToken },
      };
    });

    await beginProfileTransition({
      state,
      runtime,
      reason: "superseded extension relay",
      closeRelay: true,
    });

    expect(state.extensionRelays?.get("chrome")).toBe(replacement);
    expect(state.resolved.extensionRelayInternalTokens.chrome).toBe(replacement.internalToken);
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it("retains the exact relay credential when its lifecycle close fails", async () => {
    const { state, runtime, relay } = createExtensionRelayFixture();
    relay.close.mockRejectedValueOnce(new Error("relay still listening"));

    await expect(
      beginProfileTransition({
        state,
        runtime,
        reason: "extension relay stopped",
        closeRelay: true,
      }),
    ).rejects.toThrow("relay still listening");

    expect(state.extensionRelays?.get("chrome")).toBe(relay);
    expect(state.resolved.extensionRelayInternalTokens.chrome).toBe(relay.internalToken);
  });

  it("never re-adopts a relay credential while an unexposed close is still pending", async () => {
    const { state, runtime, relay } = createExtensionRelayFixture();
    const closeStarted = deferred();
    const closeReleased = deferred();
    relay.close.mockImplementationOnce(async () => {
      closeStarted.resolve();
      await closeReleased.promise;
    });

    const closing = beginProfileTransition({
      state,
      runtime,
      reason: "extension relay stopped",
      closeRelay: true,
    });
    await closeStarted.promise;
    expect(getProfileLifecycle(runtime).transitionReason).toBeNull();

    refreshProfiles(state);
    expect(state.resolved.extensionRelayInternalTokens).not.toHaveProperty("chrome");

    closeReleased.resolve();
    await closing;
    await getProfileLifecycle(runtime).tail;
    expect(relay.close).toHaveBeenCalledOnce();
  });

  it("listProfiles refreshes config before enumerating profiles", () => {
    const { state } = createBrowserState();

    mockState.cfgProfiles.desktop = { cdpPort: 19999, color: "#0066CC" };
    mockState.cachedConfig = null;

    refreshProfiles(state);
    expect(Object.keys(state.resolved.profiles)).toContain("desktop");
  });

  it("captures the old profile before adopting changed invariants", async () => {
    const { state, profile, runtime } = createProfileFixture({
      running: { pid: 123 } as never,
      lastTargetId: "tab-1",
    });
    const oldCdpUrl = profile.cdpUrl;
    updateProfile(state, "openclaw", { cdpPort: 19999, color: "#FF4500" }, true);

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
    const { state, profile, runtime } = createProfileFixture({
      running: { pid: 123 } as never,
      lastTargetId: "tab-1",
    });
    expect(profile.headless).toBe(true);

    updateProfile(state, "openclaw", { cdpPort: 18800, color: "#FF4500", headless: false }, true);

    expect(runtime.profile.headless).toBe(false);
    expect(runtime.lastTargetId).toBeNull();
    expect(getProfileLifecycle(runtime).transitionReason).toContain("headless");
  });

  it("marks local managed runtime state for reconcile when profile executablePath changes", () => {
    const { state, profile, runtime } = createProfileFixture({
      config: {
        cdpPort: 18800,
        color: "#FF4500",
        executablePath: "/usr/bin/chrome-old",
      },
      running: { pid: 123 } as never,
      lastTargetId: "tab-1",
    });
    expect(profile.executablePath).toBe("/usr/bin/chrome-old");

    updateProfile(
      state,
      "openclaw",
      { cdpPort: 18800, color: "#FF4500", executablePath: "/usr/bin/chrome-new" },
      true,
    );

    expect(runtime.profile.executablePath).toBe("/usr/bin/chrome-new");
    expect(runtime.lastTargetId).toBeNull();
    expect(getProfileLifecycle(runtime).transitionReason).toContain("executablePath");
  });

  it("does not reconcile existing-session runtime when only headless changes", () => {
    const { state, profile, runtime } = createProfileFixture({
      name: "remote",
      config: {
        cdpUrl: "http://127.0.0.1:9222",
        color: "#0066CC",
        headless: true,
        driver: "existing-session",
      },
      running: { pid: 456 } as never,
      lastTargetId: "tab-remote",
    });
    expect(profile.driver).toBe("existing-session");
    expect(profile.attachOnly).toBe(true);
    expect(profile.headless).toBe(true);

    updateProfile(
      state,
      "remote",
      {
        cdpUrl: "http://127.0.0.1:9222",
        color: "#0066CC",
        headless: false,
        driver: "existing-session",
      },
      true,
    );

    expect(runtime.profile.driver).toBe("existing-session");
    expect(runtime.profile.headless).toBe(false);
    expect(runtime.lastTargetId).toBe("tab-remote");
    expect(getProfileLifecycle(runtime).transitionReason).toBeNull();
  });

  it("does not reconcile remote cdp runtime when only headless changes", () => {
    const { state, profile, runtime } = createProfileFixture({
      name: "remote",
      config: {
        cdpUrl: "http://10.0.0.42:9222",
        color: "#0066CC",
        headless: true,
      },
      running: { pid: 789 } as never,
      lastTargetId: "tab-remote-cdp",
    });
    expect(profile.driver).toBe("openclaw");
    expect(profile.attachOnly).toBe(false);
    expect(profile.cdpIsLoopback).toBe(false);
    expect(profile.headless).toBe(true);

    updateProfile(
      state,
      "remote",
      { cdpUrl: "http://10.0.0.42:9222", color: "#0066CC", headless: false },
      true,
    );

    expect(runtime.profile.driver).toBe("openclaw");
    expect(runtime.profile.cdpIsLoopback).toBe(false);
    expect(runtime.profile.headless).toBe(false);
    expect(runtime.lastTargetId).toBe("tab-remote-cdp");
    expect(getProfileLifecycle(runtime).transitionReason).toBeNull();
  });

  it("reconciles existing-session command and structural argument changes", () => {
    const { state, runtime } = createProfileFixture({
      name: "work",
      config: {
        cdpUrl: "http://127.0.0.1:9222",
        color: "#0066CC",
        driver: "existing-session",
        mcpCommand: "/old/mcp",
        mcpArgs: ["--one"],
      },
    });

    updateProfile(state, "work", {
      ...mockState.cfgProfiles.work,
      mcpCommand: "/new/mcp",
      mcpArgs: ["--one", "--two"],
    });

    expect(getProfileLifecycle(runtime).transitionReason).toContain("mcpCommand");
    expect(getProfileLifecycle(runtime).transitionReason).toContain("mcpArgs");
    expect(getProfileLifecycle(runtime).configRevision).toBe(1);
  });

  it("invalidates a pending A start before adopting B", async () => {
    const { state, profile, runtime } = createProfileFixture({
      name: "work",
      config: { cdpPort: 18801, color: "#0066CC" },
    });
    const launchA = deferred();
    const launchAStarted = deferred();
    const adopted: string[] = [];
    const revisionA = getProfileLifecycle(runtime).configRevision;
    const pendingA = enqueueCurrentProfileStart(state, runtime, async (signal, generation) => {
      launchAStarted.resolve();
      await launchA.promise;
      if (!isProfileGenerationCurrent({ state, runtime, configRevision: revisionA, generation })) {
        throw signal.reason ?? new Error("A was superseded");
      }
      adopted.push(profile.cdpUrl);
    });
    await launchAStarted.promise;

    updateProfile(state, "work", { cdpPort: 18802, color: "#00AA00" });
    const workB = requireValue(resolveProfile(state.resolved, "work"), "work B missing");
    expect(runtime.profile.cdpUrl).toBe(workB.cdpUrl);

    launchA.resolve();
    await expect(pendingA).rejects.toThrow(/profile invariants changed|superseded/i);
    await getProfileLifecycle(runtime).tail;
    await expect(
      enqueueCurrentProfileStart(state, runtime, async () => {
        adopted.push(runtime.profile.cdpUrl);
      }),
    ).resolves.toBeUndefined();

    expect(adopted).toEqual([workB.cdpUrl]);
  });

  it("rapid A to B to C closes both stale endpoints and adopts only C", async () => {
    const { state, profile, runtime } = createProfileFixture({
      name: "work",
      config: { cdpPort: 18801, color: "#0066CC" },
    });
    const retired = new Set<string>();
    lifecycleMocks.retirePlaywrightBrowserConnection.mockImplementation(({ cdpUrl }) => {
      if (retired.has(cdpUrl)) {
        return false;
      }
      retired.add(cdpUrl);
      return true;
    });

    updateProfile(state, "work", { cdpPort: 18802, color: "#00AA00" });
    const workB = requireValue(resolveProfile(state.resolved, "work"), "work B missing");
    const adopted: string[] = [];
    const pendingB = enqueueCurrentProfileStart(state, runtime, async () => {
      adopted.push(workB.cdpUrl);
    });

    updateProfile(state, "work", { cdpPort: 18803, color: "#AA00AA" });
    const workC = requireValue(resolveProfile(state.resolved, "work"), "work C missing");
    expect(runtime.profile.cdpUrl).toBe(workC.cdpUrl);

    await expect(pendingB).rejects.toThrow(/profile config changed|superseded/i);
    await getProfileLifecycle(runtime).tail;
    await expect(
      enqueueCurrentProfileStart(state, runtime, async () => {
        adopted.push(runtime.profile.cdpUrl);
      }),
    ).resolves.toBeUndefined();

    expect(lifecycleMocks.closePlaywrightBrowserConnection.mock.calls).toEqual([
      [{ cdpUrl: profile.cdpUrl }],
      [{ cdpUrl: workB.cdpUrl }],
    ]);
    expect(adopted).toEqual([workC.cdpUrl]);
  });

  it("keeps a removed-name tombstone until a pending start cleans its late handle", async () => {
    const {
      state,
      profile,
      runtime: oldRuntime,
    } = createProfileFixture({
      name: "work",
      config: { cdpPort: 18801, color: "#0066CC" },
    });
    expect(oldRuntime.running).toBeNull();
    const lateRunning = { pid: 321 } as RunningChrome;
    const launch = deferred();
    const launchStarted = deferred();
    const pendingStart = enqueueCurrentProfileStart(state, oldRuntime, async () => {
      launchStarted.resolve();
      await launch.promise;
      getProfileLifecycle(oldRuntime).handles.add(lateRunning);
    });
    await launchStarted.promise;

    delete mockState.cfgProfiles.work;
    refreshProfiles(state);
    expect(getProfileLifecycle(oldRuntime).terminal).toBe("config-removed");
    expect(state.profiles.get("work")).toBe(oldRuntime);

    updateProfile(state, "work", { cdpPort: 18802, color: "#00AA00" });
    const workB = requireValue(resolveProfile(state.resolved, "work"), "work B missing");
    expect(getOrCreateProfileRuntime(state, workB)).toBe(oldRuntime);
    expect(() => enqueueCurrentProfileStart(state, oldRuntime, async () => {})).toThrow(
      /config-removed/,
    );

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
      enqueueCurrentProfileStart(state, replacement, async () => {}),
    ).resolves.toBeUndefined();
    expect(lifecycleMocks.closePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: profile.cdpUrl,
    });
  });

  it("retries a failed removal tombstone before admitting a same-name re-add", async () => {
    const { state, runtime: oldRuntime } = createProfileFixture({
      name: "work",
      config: { cdpPort: 18801, color: "#0066CC" },
    });
    lifecycleMocks.closePlaywrightBrowserConnection
      .mockRejectedValueOnce(new Error("close failed"))
      .mockResolvedValue(undefined);
    lifecycleMocks.retirePlaywrightBrowserConnection
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    delete mockState.cfgProfiles.work;
    refreshProfiles(state);
    await getProfileLifecycle(oldRuntime).tail;
    expect(getProfileLifecycle(oldRuntime).blockedReason).toContain("cleanup failed");
    expect(state.profiles.get("work")).toBe(oldRuntime);

    updateProfile(state, "work", { cdpPort: 18802, color: "#00AA00" });
    await getProfileLifecycle(oldRuntime).tail;
    await Promise.resolve();

    expect(state.profiles.has("work")).toBe(false);
    expect(lifecycleMocks.closePlaywrightBrowserConnection).toHaveBeenCalledTimes(2);
  });

  it("retries failed invariant cleanup before admitting the updated profile", async () => {
    const { state, profile, runtime } = createProfileFixture({
      name: "work",
      config: { cdpPort: 18801, color: "#0066CC" },
    });
    lifecycleMocks.closePlaywrightBrowserConnection
      .mockRejectedValueOnce(new Error("close failed"))
      .mockResolvedValue(undefined);

    updateProfile(state, "work", { cdpPort: 18802, color: "#00AA00" });
    await getProfileLifecycle(runtime).tail;
    expect(getProfileLifecycle(runtime).blockedReason).toContain("cleanup failed");

    refreshProfiles(state);
    await getProfileLifecycle(runtime).tail;

    expect(getProfileLifecycle(runtime).blockedReason).toBeNull();
    expect(runtime.profile.cdpPort).toBe(18802);
    expect(lifecycleMocks.retirePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: profile.cdpUrl,
    });
    expect(lifecycleMocks.closePlaywrightBrowserConnection).toHaveBeenCalledTimes(2);
    expect(lifecycleMocks.closePlaywrightBrowserConnection).toHaveBeenNthCalledWith(1, {
      cdpUrl: profile.cdpUrl,
    });
    expect(lifecycleMocks.closePlaywrightBrowserConnection).toHaveBeenNthCalledWith(2, {
      cdpUrl: profile.cdpUrl,
    });
    await expect(
      enqueueCurrentProfileStart(state, runtime, async () => {}),
    ).resolves.toBeUndefined();
  });
});
