import { shouldPreserveMaintenanceEntry } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

export function countSessionEntryMaintenanceEligibleEntries(
  store: Record<string, SessionEntry>,
  preserveKeys?: ReadonlySet<string>,
): number {
  let count = 0;
  for (const [key, entry] of Object.entries(store)) {
    if (!shouldPreserveMaintenanceEntry({ key, entry, preserveKeys })) {
      count++;
    }
  }
  return count;
}
