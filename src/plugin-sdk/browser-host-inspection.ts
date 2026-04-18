import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

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

export function resolveGoogleChromeExecutableForPlatform(
  platform: NodeJS.Platform,
): BrowserExecutable | null {
  return loadBrowserHostInspectionSurface().resolveGoogleChromeExecutableForPlatform(platform);
}

export function readBrowserVersion(executablePath: string): string | null {
  return loadBrowserHostInspectionSurface().readBrowserVersion(executablePath);
}

export function parseBrowserMajorVersion(rawVersion: string | null | undefined): number | null {
  return loadBrowserHostInspectionSurface().parseBrowserMajorVersion(rawVersion);
}
