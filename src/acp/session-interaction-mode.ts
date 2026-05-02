import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

type AcpSessionInteractionMode = "interactive" | "parent-owned-background";

type SessionInteractionEntry = Pick<SessionEntry, "spawnedBy" | "parentSessionKey" | "acp">;

export function resolveAcpSessionInteractionMode(
  entry?: SessionInteractionEntry | null,
): AcpSessionInteractionMode {
  // Parent-owned ACP sessions are background work delegated from another session.
  // They should report back through the parent task notifier instead of speaking directly
  // on the user-facing channel themselves.
  if (!entry?.acp) {
    return "interactive";
  }
  if (normalizeOptionalString(entry.spawnedBy) || normalizeOptionalString(entry.parentSessionKey)) {
    return "parent-owned-background";
  }
  return "interactive";
}

export function isParentOwnedBackgroundAcpSession(entry?: SessionInteractionEntry | null): boolean {
  return resolveAcpSessionInteractionMode(entry) === "parent-owned-background";
}

/**
 * Returns true when `entry` is a parent-owned background ACP session AND the
 * given `requesterSessionKey` is the session that spawned/owns it. This is a
 * strictly narrower check than {@link isParentOwnedBackgroundAcpSession}: the
 * target must match *and* the caller must be the parent.
 *
 * Used to gate behaviors that only make sense for the parent↔own-child pair
 * (e.g. skipping the A2A ping-pong flow in `sessions_send`), so that an
 * unrelated session with broad visibility (e.g. `tools.sessions.visibility=all`)
 * sending to the same target is still routed through the normal A2A path.
 */
export function isRequesterParentOfBackgroundAcpSession(
  entry: SessionInteractionEntry | null | undefined,
  requesterSessionKey: string | null | undefined,
): boolean {
  if (!isParentOwnedBackgroundAcpSession(entry)) {
    return false;
  }
  const requester = normalizeOptionalString(requesterSessionKey);
  if (!requester) {
    return false;
  }
  const spawnedBy = normalizeOptionalString(entry?.spawnedBy);
  const parentSessionKey = normalizeOptionalString(entry?.parentSessionKey);
  return requester === spawnedBy || requester === parentSessionKey;
}
