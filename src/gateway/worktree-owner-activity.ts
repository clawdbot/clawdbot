// Shared owner-activity guard for every managed-worktree cleanup entry point.
// Chat runs avoid registry acquire/bump writes, so recent session metadata
// substitutes for worktree activity; without this check manual gc could evict
// a checkout still used by an active session.
import { IDLE_GC_MS } from "../agents/worktrees/service.js";
import type { ManagedWorktreeOwnerKind } from "../agents/worktrees/types.js";
import { loadSessionEntry } from "./session-utils.js";

export function isManagedWorktreeOwnerActive(
  ownerKind: ManagedWorktreeOwnerKind,
  ownerId: string,
): boolean {
  if (ownerKind !== "session") {
    return false;
  }
  try {
    const entry = loadSessionEntry(ownerId, { clone: false }).entry;
    const activityAt = Math.max(entry?.lastInteractionAt ?? 0, entry?.updatedAt ?? 0);
    return activityAt > 0 && Date.now() - activityAt <= IDLE_GC_MS;
  } catch {
    return false;
  }
}
