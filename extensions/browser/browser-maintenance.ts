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
  const { getBrowserControlState } = await import("./src/browser-control-state.js");
  return await closeTrackedBrowserTabs({
    ...params,
    getResolvedBrowserConfig: () => getBrowserControlState()?.resolved ?? null,
  });
}

export { movePathToTrash } from "./src/browser/trash.js";
