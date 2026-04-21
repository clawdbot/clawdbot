import { expect, vi } from "vitest";

type FacadeLoaderMock = ReturnType<typeof vi.fn>;

type ChromeExecutableFixture = {
  kind: string;
  path: string;
};

const BROWSER_HOST_INSPECTION_ARTIFACT = {
  dirName: "browser",
  artifactBasename: "browser-host-inspection.js",
} as const;

const BROWSER_VERSION = "Google Chrome 144.0.7534.0";

export function mockBrowserHostInspectionFacade(
  loadBundledPluginPublicSurfaceModuleSync: FacadeLoaderMock,
  executable: ChromeExecutableFixture,
) {
  const resolveGoogleChromeExecutableForPlatform = vi.fn().mockReturnValue(executable);
  const readBrowserVersion = vi.fn().mockReturnValue(BROWSER_VERSION);
  const parseBrowserMajorVersion = vi.fn().mockReturnValue(144);

  loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
    resolveGoogleChromeExecutableForPlatform,
    readBrowserVersion,
    parseBrowserMajorVersion,
  });
}

export function expectBrowserHostInspectionDelegation(params: {
  executable: ChromeExecutableFixture;
  hostInspection: typeof import("./browser-host-inspection.js");
  loadBundledPluginPublicSurfaceModuleSync: FacadeLoaderMock;
}) {
  expect(params.hostInspection.resolveGoogleChromeExecutableForPlatform("linux")).toEqual(
    params.executable,
  );
  expect(params.hostInspection.readBrowserVersion(params.executable.path)).toBe(BROWSER_VERSION);
  expect(params.hostInspection.parseBrowserMajorVersion(BROWSER_VERSION)).toBe(144);
  expect(params.loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith(
    BROWSER_HOST_INSPECTION_ARTIFACT,
  );
}

export async function expectBrowserHostInspectionFacadeUnavailable(
  loadBundledPluginPublicSurfaceModuleSync: FacadeLoaderMock,
) {
  loadBundledPluginPublicSurfaceModuleSync.mockImplementation(() => {
    throw new Error("missing browser host inspection facade");
  });

  const hostInspection = await import("./browser-host-inspection.js");

  expect(() => hostInspection.resolveGoogleChromeExecutableForPlatform("linux")).toThrow(
    "missing browser host inspection facade",
  );
}
