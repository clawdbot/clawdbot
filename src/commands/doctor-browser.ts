import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "../plugin-sdk/facade-loader.js";
import { note } from "../terminal/note.js";

type BrowserDoctorDeps = {
  platform?: NodeJS.Platform;
  noteFn?: typeof note;
  resolveChromeExecutable?: (platform: NodeJS.Platform) => { path: string } | null;
  readVersion?: (executablePath: string) => string | null;
};

type BrowserDoctorSurface = {
  noteChromeMcpBrowserReadiness: (cfg: OpenClawConfig, deps?: BrowserDoctorDeps) => Promise<void>;
};

function loadBrowserDoctorSurface(): BrowserDoctorSurface {
  return loadBundledPluginPublicSurfaceModuleSync<BrowserDoctorSurface>({
    dirName: "browser",
    artifactBasename: "browser-doctor.js",
  });
}

export async function noteChromeMcpBrowserReadiness(cfg: OpenClawConfig, deps?: BrowserDoctorDeps) {
  try {
    await loadBrowserDoctorSurface().noteChromeMcpBrowserReadiness(cfg, deps);
  } catch (error) {
    const noteFn = deps?.noteFn ?? note;
    const message = error instanceof Error ? error.message : String(error);
    noteFn(`- Browser health check is unavailable: ${message}`, "Browser");
  }
}
