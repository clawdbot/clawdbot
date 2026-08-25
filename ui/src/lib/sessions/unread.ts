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
    markedUnreadAt?: number,
  ): boolean {
    const key = activeSessionKey.trim();
    if (key !== this.activeSessionKey) {
      this.beginActivation(key);
    }
    if (!key) {
      return false;
    }
    if (!this.activationObserved) {
      this.activationObserved = true;
      this.activationMarkedUnreadAt = markedUnreadAt;
    }
    if (unread === false) {
      this.activationMarkedUnreadAt = undefined;
      this.requested = false;
      return false;
    }
    if (markedUnreadAt !== undefined && markedUnreadAt !== this.activationMarkedUnreadAt) {
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
