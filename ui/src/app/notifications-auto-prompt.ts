import type { ApplicationContext } from "./context.ts";

const NOTIFICATIONS_AUTO_PROMPT_KEY = "openclaw.control.notificationsAutoPrompt.v1";

type NotificationsContext = Pick<ApplicationContext, "nativeNotifications" | "webPush">;

function markAutoPrompted(storage: Storage): void {
  // Persist the one-shot contract before asking so re-entrant sends cannot prompt twice.
  try {
    storage.setItem(NOTIFICATIONS_AUTO_PROMPT_KEY, "1");
  } catch {
    // Permission state still prevents repeat prompts after a completed decision.
  }
}

export function autoPromptNotificationsOnSend(context: NotificationsContext): void {
  let storage: Storage;
  try {
    storage = localStorage;
    if (storage.getItem(NOTIFICATIONS_AUTO_PROMPT_KEY) !== null) {
      return;
    }
  } catch {
    return;
  }

  const nativeNotifications = context.nativeNotifications;
  if (nativeNotifications) {
    // Denied is terminal for auto-asks; the manual path may open System Settings.
    if (nativeNotifications.snapshot.permission !== "notDetermined") {
      return;
    }
    markAutoPrompted(storage);
    // Keep the permission request in the user-gesture tick for Safari transient activation.
    try {
      nativeNotifications.requestPermission();
    } catch {
      // Notification prompting must never interrupt chat sending.
    }
    return;
  }

  const snapshot = context.webPush.snapshot;
  if (
    !snapshot.supported ||
    snapshot.permission !== "default" ||
    snapshot.subscribed ||
    snapshot.loading
  ) {
    // Denied and granted permissions are terminal for automatic prompts.
    return;
  }
  markAutoPrompted(storage);
  try {
    void context.webPush.enable();
  } catch {
    // Notification prompting must never interrupt chat sending.
  }
}
