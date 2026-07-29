/**
 * Browser maintenance API barrel. It exposes tab cleanup and trash helpers for
 * runtime and doctor flows.
 */
export { closeTrackedBrowserTabsForSessions } from "./src/browser/session-tab-registry.js";
export { movePathToTrash } from "./src/browser/trash.js";
