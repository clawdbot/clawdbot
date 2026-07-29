/**
 * Public SDK facade for browser executable lookup and browser version inspection.
 */
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

/** Browser executable candidate discovered on the host platform. */
export type BrowserExecutable = {
  kind: "brave" | "canary" | "chromium" | "chrome" | "custom" | "edge";
  path: string;
};

type BrowserHostInspectionSurface = {
  resolveGoogleChromeExecutableForPlatform: (platform: NodeJS.Platform) => BrowserExecutable | null;
  readBrowserVersion: (executablePath: string) => string | null;
  parseBrowserMajorVersion: (rawVersion: string | null | undefined) => number | null;
};

let cachedBrowserHostInspectionSurface: BrowserHostInspectionSurface | undefined;

function loadBrowserHostInspectionSurface(): BrowserHostInspectionSurface {
  cachedBrowserHostInspectionSurface ??=
    loadBundledPluginPublicSurfaceModuleSync<BrowserHostInspectionSurface>({
      dirName: "browser",
      artifactBasename: "browser-host-inspection.js",
    });
  return cachedBrowserHostInspectionSurface;
}

/** Resolves the preferred local Chrome-compatible executable for a platform. */
export function resolveGoogleChromeExecutableForPlatform(
  platform: NodeJS.Platform,
): BrowserExecutable | null {
  return loadBrowserHostInspectionSurface().resolveGoogleChromeExecutableForPlatform(platform);
}

/** Reads a browser executable version string through the activated browser facade. */
export function readBrowserVersion(executablePath: string): string | null {
  return loadBrowserHostInspectionSurface().readBrowserVersion(executablePath);
}

/** Parses a browser major version from raw command output. */
export function parseBrowserMajorVersion(rawVersion: string | null | undefined): number | null {
  return loadBrowserHostInspectionSurface().parseBrowserMajorVersion(rawVersion);
}
