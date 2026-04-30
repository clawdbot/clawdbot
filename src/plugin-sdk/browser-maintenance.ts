import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";
export { movePathToTrash, type MovePathToTrashOptions } from "./browser-trash.js";

type CloseTrackedBrowserTabsParams = {
  sessionKeys: Array<string | undefined>;
  closeTab?: (tab: { targetId: string; baseUrl?: string; profile?: string }) => Promise<void>;
  onWarn?: (message: string) => void;
};

type BrowserMaintenanceSurface = {
  closeTrackedBrowserTabsForSessions: (params: CloseTrackedBrowserTabsParams) => Promise<number>;
};

let cachedBrowserMaintenanceSurface: BrowserMaintenanceSurface | undefined;

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
