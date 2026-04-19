import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

type CloseTrackedBrowserTabsParams = {
  sessionKeys: Array<string | undefined>;
  closeTab?: (tab: { targetId: string; baseUrl?: string; profile?: string }) => Promise<void>;
  onWarn?: (message: string) => void;
};

type BrowserMaintenanceSurface = {
  closeTrackedBrowserTabsForSessions: (params: CloseTrackedBrowserTabsParams) => Promise<number>;
};
type SecureRandomRuntime = typeof import("../infra/secure-random.js");
type ExecRuntime = typeof import("../process/exec.js");

let cachedBrowserMaintenanceSurface: BrowserMaintenanceSurface | undefined;
let secureRandomRuntimePromise: Promise<SecureRandomRuntime> | undefined;
let execRuntimePromise: Promise<ExecRuntime> | undefined;

function hasRequestedSessionKeys(sessionKeys: Array<string | undefined>): boolean {
  return sessionKeys.some((key) => Boolean(key?.trim()));
}

function loadBrowserMaintenanceSurface(): BrowserMaintenanceSurface {
  cachedBrowserMaintenanceSurface ??=
    loadBundledPluginPublicSurfaceModuleSync<BrowserMaintenanceSurface>({
      dirName: "browser",
      artifactBasename: "browser-maintenance.js",
    });
  return cachedBrowserMaintenanceSurface;
}

function loadSecureRandomRuntime(): Promise<SecureRandomRuntime> {
  secureRandomRuntimePromise ??= import("../infra/secure-random.js");
  return secureRandomRuntimePromise;
}

function loadExecRuntime(): Promise<ExecRuntime> {
  execRuntimePromise ??= import("../process/exec.js");
  return execRuntimePromise;
}

export async function closeTrackedBrowserTabsForSessions(
  params: CloseTrackedBrowserTabsParams,
): Promise<number> {
  if (!hasRequestedSessionKeys(params.sessionKeys)) {
    return 0;
  }

  let surface: BrowserMaintenanceSurface;
  try {
    surface = loadBrowserMaintenanceSurface();
  } catch (error) {
    params.onWarn?.(`browser cleanup unavailable: ${String(error)}`);
    return 0;
  }
  return await surface.closeTrackedBrowserTabsForSessions(params);
}

export async function movePathToTrash(targetPath: string): Promise<string> {
  const [{ generateSecureToken }, { runExec }] = await Promise.all([
    loadSecureRandomRuntime(),
    loadExecRuntime(),
  ]);
  try {
    await runExec("trash", [targetPath], { timeoutMs: 10_000 });
    return targetPath;
  } catch {
    const trashDir = path.join(os.homedir(), ".Trash");
    fs.mkdirSync(trashDir, { recursive: true });
    const base = path.basename(targetPath);
    let dest = path.join(trashDir, `${base}-${Date.now()}`);
    if (fs.existsSync(dest)) {
      dest = path.join(trashDir, `${base}-${Date.now()}-${generateSecureToken(6)}`);
    }
    fs.renameSync(targetPath, dest);
    return dest;
  }
}
