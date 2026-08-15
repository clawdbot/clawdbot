/**
 * Acknowledges unread state at most once per unread episode: the pending flag
 * clears when the server-confirmed read (unread=false) is observed, so fresh
 * activity while the session stays open re-acknowledges without patch loops.
 */
export class SessionUnreadPatchGuard {
  private activeSessionKey = "";
  private requested = false;

  shouldPatch(activeSessionKey: string, unread: boolean | undefined): boolean {
    const key = activeSessionKey.trim();
    if (key !== this.activeSessionKey) {
      this.activeSessionKey = key;
      this.requested = false;
    }
    if (!key) {
      return false;
    }
    if (unread === false) {
      this.requested = false;
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
