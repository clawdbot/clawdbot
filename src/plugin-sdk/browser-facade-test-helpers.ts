/**
 * Shared test helpers for browser facade delegation tests.
 */
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

/** Installs a mocked browser host inspection public surface. */
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

/** Asserts browser host inspection calls delegate through the browser public facade. */
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

/** Asserts host inspection helpers surface facade load failures to callers. */
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
