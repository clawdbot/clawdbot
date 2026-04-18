import { beforeEach, describe, expect, it, vi } from "vitest";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());

vi.mock("./facade-loader.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync,
}));

describe("plugin-sdk browser facades", () => {
  beforeEach(() => {
    // Facade wrappers cache successful loads; each case needs a clean wrapper module.
    vi.resetModules();
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
  });

  it("delegates browser profile helpers to the browser facade", async () => {
    const resolvedConfig = {
      marker: "resolved-config",
    } as unknown as import("./browser-profiles.js").ResolvedBrowserConfig;
    const resolvedProfile = {
      marker: "resolved-profile",
    } as unknown as import("./browser-profiles.js").ResolvedBrowserProfile;

    const resolveBrowserConfig = vi.fn().mockReturnValue(resolvedConfig);
    const resolveProfile = vi.fn().mockReturnValue(resolvedProfile);
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      resolveBrowserConfig,
      resolveProfile,
    });

    const browserProfiles = await import("./browser-profiles.js");
    const cfg = { enabled: true } as unknown as import("../config/config.js").BrowserConfig;
    const rootConfig = { gateway: { port: 18789 } } as import("../config/config.js").OpenClawConfig;

    expect(browserProfiles.resolveBrowserConfig(cfg, rootConfig)).toBe(resolvedConfig);
    expect(browserProfiles.resolveProfile(resolvedConfig, "openclaw")).toBe(resolvedProfile);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "browser",
      artifactBasename: "browser-profiles.js",
    });
    expect(resolveBrowserConfig).toHaveBeenCalledWith(cfg, rootConfig);
    expect(resolveProfile).toHaveBeenCalledWith(resolvedConfig, "openclaw");
  });

  it("hard-fails when browser profile facade is unavailable", async () => {
    loadBundledPluginPublicSurfaceModuleSync.mockImplementation(() => {
      throw new Error("missing browser profiles facade");
    });

    const browserProfiles = await import("./browser-profiles.js");

    expect(() => browserProfiles.resolveBrowserConfig(undefined, undefined)).toThrow(
      "missing browser profiles facade",
    );
  });

  it("delegates browser control auth helpers to the browser facade", async () => {
    const resolvedAuth = {
      token: "token-1",
      password: undefined,
    } as import("./browser-control-auth.js").BrowserControlAuth;
    const ensuredAuth = {
      auth: resolvedAuth,
      generatedToken: "token-1",
    };

    const resolveBrowserControlAuth = vi.fn().mockReturnValue(resolvedAuth);
    const shouldAutoGenerateBrowserAuth = vi.fn().mockReturnValue(true);
    const ensureBrowserControlAuth = vi.fn().mockResolvedValue(ensuredAuth);
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      resolveBrowserControlAuth,
      shouldAutoGenerateBrowserAuth,
      ensureBrowserControlAuth,
    });

    const controlAuth = await import("./browser-control-auth.js");
    const cfg = {
      gateway: { auth: { token: "token-1" } },
    } as import("../config/config.js").OpenClawConfig;
    const env = {} as NodeJS.ProcessEnv;

    expect(controlAuth.resolveBrowserControlAuth(cfg, env)).toBe(resolvedAuth);
    expect(controlAuth.shouldAutoGenerateBrowserAuth(env)).toBe(true);
    await expect(controlAuth.ensureBrowserControlAuth({ cfg, env })).resolves.toEqual(ensuredAuth);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "browser",
      artifactBasename: "browser-control-auth.js",
    });
  });

  it("hard-fails when browser control auth facade is unavailable", async () => {
    loadBundledPluginPublicSurfaceModuleSync.mockImplementation(() => {
      throw new Error("missing browser control auth facade");
    });

    const controlAuth = await import("./browser-control-auth.js");

    expect(() => controlAuth.resolveBrowserControlAuth(undefined, {} as NodeJS.ProcessEnv)).toThrow(
      "missing browser control auth facade",
    );
  });

  it("delegates browser host inspection helpers to the browser facade", async () => {
    const executable: import("./browser-host-inspection.js").BrowserExecutable = {
      kind: "chrome",
      path: "/usr/bin/google-chrome",
    };

    const resolveGoogleChromeExecutableForPlatform = vi.fn().mockReturnValue(executable);
    const readBrowserVersion = vi.fn().mockReturnValue("Google Chrome 144.0.7534.0");
    const parseBrowserMajorVersion = vi.fn().mockReturnValue(144);
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      resolveGoogleChromeExecutableForPlatform,
      readBrowserVersion,
      parseBrowserMajorVersion,
    });

    const hostInspection = await import("./browser-host-inspection.js");

    expect(hostInspection.resolveGoogleChromeExecutableForPlatform("linux")).toEqual(executable);
    expect(hostInspection.readBrowserVersion(executable.path)).toBe("Google Chrome 144.0.7534.0");
    expect(hostInspection.parseBrowserMajorVersion("Google Chrome 144.0.7534.0")).toBe(144);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "browser",
      artifactBasename: "browser-host-inspection.js",
    });
  });

  it("hard-fails when browser host inspection facade is unavailable", async () => {
    loadBundledPluginPublicSurfaceModuleSync.mockImplementation(() => {
      throw new Error("missing browser host inspection facade");
    });

    const hostInspection = await import("./browser-host-inspection.js");

    expect(() => hostInspection.resolveGoogleChromeExecutableForPlatform("linux")).toThrow(
      "missing browser host inspection facade",
    );
  });
});
