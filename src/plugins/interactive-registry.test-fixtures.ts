/** Test-only reset for registry-owned interactive handler snapshots. */
import { clearPluginInteractiveHandlerRegistrationsState } from "./interactive-state.js";

export function clearPluginInteractiveHandlerRegistrations(): void {
  clearPluginInteractiveHandlerRegistrationsState();
}
