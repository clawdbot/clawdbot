import { beforeEach, describe, expect, it, vi } from "vitest";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());

vi.mock("./facade-loader.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync,
}));

describe("browser host inspection", () => {
  beforeEach(() => {
    // Facade wrappers cache successful loads; each case needs a clean wrapper module.
    vi.resetModules();
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
  });

  it("delegates browser host inspection helpers through the browser facade", async () => {
    const resolveGoogleChromeExecutableForPlatform = vi.fn().mockReturnValue({
      kind: "canary",
      path: "/usr/bin/google-chrome-beta",
    });
    const readBrowserVersion = vi.fn().mockReturnValue("Google Chrome 144.0.7534.0");
    const parseBrowserMajorVersion = vi.fn().mockReturnValue(144);

    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      resolveGoogleChromeExecutableForPlatform,
      readBrowserVersion,
      parseBrowserMajorVersion,
    });

    const hostInspection = await import("./browser-host-inspection.js");

    expect(hostInspection.resolveGoogleChromeExecutableForPlatform("linux")).toEqual({
      kind: "canary",
      path: "/usr/bin/google-chrome-beta",
    });
    expect(hostInspection.readBrowserVersion("/usr/bin/google-chrome-beta")).toBe(
      "Google Chrome 144.0.7534.0",
    );
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
