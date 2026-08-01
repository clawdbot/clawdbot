/** Test-only reset for registry-owned interactive handler snapshots. */
import { requireActivePluginChannelRegistry } from "./runtime.js";

export function clearPluginInteractiveHandlerRegistrations(): void {
  requireActivePluginChannelRegistry().interactiveHandlers.length = 0;
}
