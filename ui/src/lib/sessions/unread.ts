/**
 * Acknowledges unread state at most once per unread episode: the pending flag
 * clears when the server-confirmed read (unread=false) is observed, so fresh
 * activity while the session stays open re-acknowledges without patch loops.
 */
export class SessionUnreadPatchGuard {
  private activeSessionKey = "";
  private activationObserved = false;
  private activationMarkedUnreadAt: number | undefined;
  private requested = false;

  beginActivation(activeSessionKey: string) {
    this.activeSessionKey = activeSessionKey.trim();
    this.activationObserved = false;
    this.activationMarkedUnreadAt = undefined;
    this.requested = false;
  }

  shouldPatch(
    activeSessionKey: string,
    unread: boolean | undefined,
    markedUnreadAt?: number | null,
  ): boolean {
    const key = activeSessionKey.trim();
    const marker = markedUnreadAt ?? undefined;
    if (key !== this.activeSessionKey) {
      this.beginActivation(key);
    }
    if (!key) {
      return false;
    }
    if (!this.activationObserved) {
      this.activationObserved = true;
      this.activationMarkedUnreadAt = marker;
    }
    if (unread === false) {
      // An optimistic read keeps the observed marker until the Gateway confirms it.
      // Clearing the latch here would let rollback synchronously dispatch a duplicate.
      if (marker !== undefined) {
        return false;
      }
      this.activationMarkedUnreadAt = undefined;
      this.requested = false;
      return false;
    }
    if (marker !== undefined && marker !== this.activationMarkedUnreadAt) {
      return false;
    }
    if (unread !== true || this.requested) {
      return false;
    }
    this.requested = true;
    return true;
  }

  /** A failed read patch must unlatch the episode so later snapshots retry. */
  patchFailed(activeSessionKey: string) {
    if (activeSessionKey.trim() === this.activeSessionKey) {
      this.requested = false;
    }
  }
}
