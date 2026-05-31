import fs from "node:fs";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "../plugin-sdk/facade-loader.js";
import { resolveConfigDir } from "../utils.js";

type BrowserDoctorDeps = {
  platform?: NodeJS.Platform;
  noteFn?: typeof note;
  env?: NodeJS.ProcessEnv;
  getUid?: () => number;
  resolveManagedExecutable?: (
    resolved: unknown,
    platform: NodeJS.Platform,
  ) => { path: string } | null;
  resolveChromeExecutable?: (platform: NodeJS.Platform) => { path: string } | null;
  readVersion?: (executablePath: string) => string | null;
  configDir?: string;
  pathExists?: (targetPath: string) => boolean;
};

export type BrowserDoctorRepairDeps = {
  env?: NodeJS.ProcessEnv;
  configDir?: string;
  pathExists?: (targetPath: string) => boolean;
  movePathToTrash?: (targetPath: string) => Promise<string>;
};

export type LegacyClawdBrowserProfileResidue = {
  legacyProfileDir: string;
  legacyUserDataDir: string;
  canonicalUserDataDir: string;
};

type BrowserDoctorSurface = {
  noteChromeMcpBrowserReadiness: (cfg: OpenClawConfig, deps?: BrowserDoctorDeps) => Promise<void>;
  detectLegacyClawdBrowserProfileResidue?: (
    cfg: OpenClawConfig,
    deps?: BrowserDoctorRepairDeps,
  ) => LegacyClawdBrowserProfileResidue | null;
  maybeArchiveLegacyClawdBrowserProfileResidue?: (
    cfg: OpenClawConfig,
    deps?: BrowserDoctorRepairDeps,
  ) => Promise<{ changes: string[]; warnings: string[] }>;
};

function loadBrowserDoctorSurface(): BrowserDoctorSurface {
  return loadBundledPluginPublicSurfaceModuleSync<BrowserDoctorSurface>({
    dirName: "browser",
    artifactBasename: "browser-doctor.js",
  });
}

function mayHaveLegacyClawdBrowserProfileResidue(deps?: BrowserDoctorRepairDeps): boolean {
  const configDir = deps?.configDir ?? resolveConfigDir(deps?.env ?? process.env);
  const legacyProfileDir = path.join(configDir, "browser", "clawd");
  const legacyUserDataDir = path.join(legacyProfileDir, "user-data");
  const pathExists = deps?.pathExists ?? fs.existsSync;
  try {
    return pathExists(legacyProfileDir) || pathExists(legacyUserDataDir);
  } catch {
    return true;
  }
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

export async function detectLegacyClawdBrowserProfileResidue(
  cfg: OpenClawConfig,
  deps?: BrowserDoctorRepairDeps,
): Promise<LegacyClawdBrowserProfileResidue | null> {
  if (!mayHaveLegacyClawdBrowserProfileResidue(deps)) {
    return null;
  }
  const detect = loadBrowserDoctorSurface().detectLegacyClawdBrowserProfileResidue;
  if (!detect) {
    return null;
  }
  return detect(cfg, deps);
}

export async function maybeArchiveLegacyClawdBrowserProfileResidue(
  cfg: OpenClawConfig,
  deps?: BrowserDoctorRepairDeps,
): Promise<{ changes: string[]; warnings: string[] }> {
  if (!mayHaveLegacyClawdBrowserProfileResidue(deps)) {
    return { changes: [], warnings: [] };
  }
  try {
    const repair = loadBrowserDoctorSurface().maybeArchiveLegacyClawdBrowserProfileResidue;
    if (!repair) {
      return { changes: [], warnings: [] };
    }
    return await repair(cfg, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      changes: [],
      warnings: [`Browser profile cleanup is unavailable: ${message}`],
    };
  }
}
