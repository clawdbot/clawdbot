import "./server-context.chrome-test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isChromeReachable, launchOpenClawChrome, stopOpenClawChrome } from "./chrome.js";
import { resolveBrowserConfig } from "./config.js";
import { createBrowserRouteContext, type BrowserServerState } from "./server-context.js";
import { mockLaunchedChrome } from "./server-context.test-harness.js";

const config = vi.hoisted(() => ({ current: {} as OpenClawConfig }));

vi.mock("./config-refresh-source.js", () => ({
  loadBrowserConfigForRuntimeRefresh: () => config.current,
}));

vi.mock("./pw-ai-module.js", () => ({
  getLoadedPwAiModule: () => null,
  getPwAiModule: async () => null,
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("browser inherited launch settings reload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(launchOpenClawChrome).mockReset();
    config.current = {
      browser: {
        headless: true,
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500" },
          attached: { cdpPort: 18801, color: "#0066CC", attachOnly: true },
          remote: { cdpUrl: "http://192.0.2.10:9222", color: "#00CC66" },
        },
      },
    };
  });

  it("keeps restart-owned controls while refreshing launch settings", async () => {
    config.current.browser = {
      ...config.current.browser,
      ssrfPolicy: { allowedHostnames: ["192.0.2.10"] },
    };
    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved: resolveBrowserConfig(config.current.browser, config.current),
      profiles: new Map(),
    };
    const startup = state.resolved;
    const ctx = createBrowserRouteContext({ getState: () => state, refreshConfigFromDisk: true });
    vi.mocked(isChromeReachable).mockResolvedValue(true);
    await ctx.forProfile("remote").isHttpReachable();
    const startupProbePolicy = vi.mocked(isChromeReachable).mock.calls[0]?.[2];
    expect(startupProbePolicy).toMatchObject({ allowedHostnames: ["192.0.2.10"] });

    config.current.browser = {
      ...config.current.browser,
      noSandbox: true,
      enabled: false,
      evaluateEnabled: false,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      extensionRelay: { allowLegacyAuth: false },
      tabCleanup: { enabled: false },
    };
    await ctx.forProfile("remote").isHttpReachable();

    expect(vi.mocked(isChromeReachable).mock.lastCall?.[2]).toEqual(startupProbePolicy);
    expect(ctx.state().resolved).toMatchObject({
      noSandbox: true,
      enabled: startup.enabled,
      evaluateEnabled: startup.evaluateEnabled,
      extensionRelay: startup.extensionRelay,
      tabCleanup: startup.tabCleanup,
    });
  });

  it.each([
    { setting: "noSandbox", change: { noSandbox: true } },
    { setting: "extraArgs", change: { extraArgs: ["--disable-dev-shm-usage"] } },
  ])("relaunches only owned Chrome when $setting changes", async ({ change }) => {
    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved: resolveBrowserConfig(config.current.browser, config.current),
      profiles: new Map(),
    };
    const ctx = createBrowserRouteContext({ getState: () => state, refreshConfigFromDisk: true });
    let managedReachable = false;
    vi.mocked(isChromeReachable).mockImplementation(async (url) =>
      url.includes(":18800") ? managedReachable : true,
    );
    vi.mocked(stopOpenClawChrome).mockImplementation(async () => {
      managedReachable = false;
    });
    const original = mockLaunchedChrome(vi.mocked(launchOpenClawChrome), 101);
    const replacement = mockLaunchedChrome(vi.mocked(launchOpenClawChrome), 102);
    vi.mocked(launchOpenClawChrome)
      .mockImplementationOnce(async () => {
        managedReachable = true;
        return original;
      })
      .mockImplementationOnce(async () => {
        managedReachable = true;
        return replacement;
      });
    const attached = ctx.forProfile("attached");
    const remote = ctx.forProfile("remote");
    await attached.ensureBrowserAvailable();
    await remote.ensureBrowserAvailable();
    await ctx.forProfile().ensureBrowserAvailable();

    config.current = { ...config.current, browser: { ...config.current.browser, ...change } };
    await ctx.forProfile().ensureBrowserAvailable();

    expect(stopOpenClawChrome).toHaveBeenCalledExactlyOnceWith(original);
    expect(launchOpenClawChrome).toHaveBeenCalledTimes(2);
    expect(vi.mocked(launchOpenClawChrome).mock.calls[1]?.[0]).toMatchObject(change);
    expect(state.profiles.get("openclaw")?.running).toBe(replacement);
    await expect(attached.isReachable()).resolves.toBe(true);
    await expect(remote.isReachable()).resolves.toBe(true);
  });

  it.each([
    { setting: "noSandbox", change: { noSandbox: true } },
    { setting: "extraArgs", change: { extraArgs: ["--disable-dev-shm-usage"] } },
  ])("rejects a pending managed launch after $setting changes", async ({ change }) => {
    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved: resolveBrowserConfig(config.current.browser, config.current),
      profiles: new Map(),
    };
    const ctx = createBrowserRouteContext({ getState: () => state, refreshConfigFromDisk: true });
    let managedReachable = false;
    vi.mocked(isChromeReachable).mockImplementation(async () => managedReachable);
    vi.mocked(stopOpenClawChrome).mockImplementation(async () => {
      managedReachable = false;
    });
    const started = deferred();
    const release = deferred();
    const stale = mockLaunchedChrome(vi.mocked(launchOpenClawChrome), 201);
    const replacement = mockLaunchedChrome(vi.mocked(launchOpenClawChrome), 202);
    vi.mocked(launchOpenClawChrome)
      .mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        managedReachable = true;
        return stale;
      })
      .mockImplementationOnce(async () => {
        managedReachable = true;
        return replacement;
      });
    const initialStart = ctx.forProfile().ensureBrowserAvailable();
    const outcome = initialStart.then(
      () => null,
      (error: unknown) => error,
    );
    await started.promise;
    config.current = { ...config.current, browser: { ...config.current.browser, ...change } };
    const nextProfile = ctx.forProfile();
    release.resolve();

    expect(await outcome).toBeInstanceOf(Error);
    expect(state.profiles.get("openclaw")?.running).not.toBe(stale);
    await nextProfile.ensureBrowserAvailable();
    expect(stopOpenClawChrome).toHaveBeenCalledExactlyOnceWith(stale);
    expect(vi.mocked(launchOpenClawChrome).mock.calls[1]?.[0]).toMatchObject(change);
    expect(state.profiles.get("openclaw")?.running).toBe(replacement);
  });
});
