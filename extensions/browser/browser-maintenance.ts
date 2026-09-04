/**
 * Browser maintenance API barrel. It exposes tab cleanup and trash helpers for
 * runtime and doctor flows.
 */
import { closeTrackedBrowserTabsForSessions as closeTrackedBrowserTabs } from "./src/browser/session-tab-registry.js";

type CloseTrackedBrowserTabsParams = Parameters<typeof closeTrackedBrowserTabs>[0];

/** Route lifecycle cleanup through the currently running Browser runtime when available. */
export async function closeTrackedBrowserTabsForSessions(
  params: CloseTrackedBrowserTabsParams,
): Promise<number> {
  return await closeTrackedBrowserTabs({
    ...params,
    getResolvedBrowserConfig: async () => {
      const { getBrowserControlState } = await import("./src/browser-control-state.js");
      return getBrowserControlState()?.resolved ?? null;
    },
  });
}

export { movePathToTrash } from "./src/browser/trash.js";
