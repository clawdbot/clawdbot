import {
  parseSidebarEntry,
  serializeSidebarEntry,
  type SidebarNavRoute,
  type SidebarZoneEntry,
} from "../app-navigation.ts";
import type { SidebarWorkboardBoard } from "../components/app-sidebar-workboard.ts";

type SidebarPinnedSession = { key: string };

/**
 * Reconcile the persisted zone order against the sessions we can actually see.
 * `entries` is the render list; `sidebarEntries` is the canonical list callers
 * may persist after a mutation. Session entries outside `knownUnpinnedKeys`
 * whose rows are not loaded (other agents, still-loading caches) are preserved
 * in place: pruning them here would corrupt the synced prefs of every session
 * the current view cannot vouch for.
 */
export function reconcileSidebarZone(
  sidebarEntries: readonly string[],
  pinnedSessions: readonly SidebarPinnedSession[],
  validRoutes: readonly SidebarNavRoute[],
  knownUnpinnedKeys: ReadonlySet<string> = new Set(),
  workboardBoards: readonly SidebarWorkboardBoard[] = [],
  workboardEnabled = false,
  workboardBoardsReady = false,
): { entries: SidebarZoneEntry[]; sidebarEntries: string[] } {
  const pinnedKeys = new Set(pinnedSessions.map((session) => session.key));
  const validRouteSet = new Set(validRoutes);
  const validBoardIds = new Set(workboardBoards.map((board) => board.id));
  const seen = new Set<string>();
  const entries: SidebarZoneEntry[] = [];
  const canonical: string[] = [];

  for (const serialized of sidebarEntries) {
    const entry = parseSidebarEntry(serialized);
    if (!entry) {
      continue;
    }
    const canonicalKey = serializeSidebarEntry(entry);
    if (seen.has(canonicalKey)) {
      continue;
    }
    if (entry.type === "route") {
      if (!validRouteSet.has(entry.route)) {
        continue;
      }
      seen.add(canonicalKey);
      entries.push(entry);
      canonical.push(canonicalKey);
      continue;
    }
    if (entry.type === "workboard") {
      if (!workboardEnabled) {
        continue;
      }
      seen.add(canonicalKey);
      canonical.push(canonicalKey);
      // An unloaded catalog cannot distinguish deletion from startup. Preserve
      // the slot but render nothing until the active plugin returns its ids.
      if (!workboardBoardsReady) {
        continue;
      }
      if (!validBoardIds.has(entry.boardId)) {
        canonical.pop();
        continue;
      }
      entries.push(entry);
      continue;
    }
    if (pinnedKeys.has(entry.key)) {
      seen.add(canonicalKey);
      entries.push(entry);
      canonical.push(canonicalKey);
      continue;
    }
    if (knownUnpinnedKeys.has(entry.key)) {
      continue;
    }
    // Unknown state: keep the position, render nothing.
    seen.add(canonicalKey);
    canonical.push(canonicalKey);
  }

  for (const session of pinnedSessions) {
    const entry = { type: "session", key: session.key } as const;
    const serialized = serializeSidebarEntry(entry);
    if (!seen.has(serialized)) {
      seen.add(serialized);
      entries.push(entry);
      canonical.push(serialized);
    }
  }

  return { entries, sidebarEntries: canonical };
}
