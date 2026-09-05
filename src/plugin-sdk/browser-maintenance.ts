/**
 * Public SDK facade for browser cleanup and trash operations.
 */
import { tryLoadActivatedBundledPluginPublicSurfaceModule } from "./facade-runtime.js";
export { movePathToTrash, type MovePathToTrashOptions } from "./browser-trash.js";

type CloseTrackedBrowserTabsParams = {
  sessionKeys: Array<string | undefined>;
  closeTab?: (tab: { targetId: string; baseUrl?: string; profile?: string }) => Promise<void>;
  onWarn?: (message: string) => void;
};

type BrowserMaintenanceSurface = {
  closeTrackedBrowserTabsForSessions: (params: CloseTrackedBrowserTabsParams) => Promise<number>;
};

function hasRequestedSessionKeys(sessionKeys: Array<string | undefined>): boolean {
  return sessionKeys.some((key) => Boolean(key?.trim()));
}

/** Closes tracked browser tabs for requested session keys when the browser plugin is active. */
export async function closeTrackedBrowserTabsForSessions(
  params: CloseTrackedBrowserTabsParams,
): Promise<number> {
  if (!hasRequestedSessionKeys(params.sessionKeys)) {
    return 0;
  }

  let surface: BrowserMaintenanceSurface | null;
  try {
    // Cleanup is already async; keep cold activation off the synchronous source loader.
    surface = await tryLoadActivatedBundledPluginPublicSurfaceModule<BrowserMaintenanceSurface>({
      dirName: "browser",
      artifactBasename: "browser-maintenance.js",
    });
  } catch (error) {
    params.onWarn?.(`browser cleanup unavailable: ${String(error)}`);
    return 0;
  }
  if (!surface) {
    return 0;
  }
  return await surface.closeTrackedBrowserTabsForSessions(params);
}
