import type { ApplicationContext } from "./context.ts";

const NOTIFICATIONS_AUTO_PROMPT_KEY = "openclaw.control.notificationsAutoPrompt.v1";

type NotificationsContext = Pick<ApplicationContext, "notifications">;

type NotificationsAutoPromptCandidate = {
  connected: boolean;
  directComposerSend: boolean;
  message: string;
  hasAttachments: boolean;
  isCommand: boolean;
};

export function hasActiveNotificationPromptGesture(): boolean {
  // User activation can survive awaited work. window.event exists only while
  // the originating input event is dispatching, so deferred sends stay out.
  return typeof window !== "undefined" && window.event !== undefined;
}

export function shouldAutoPromptNotificationsOnSend(
  candidate: NotificationsAutoPromptCandidate,
): boolean {
  return (
    candidate.connected &&
    candidate.directComposerSend &&
    !candidate.isCommand &&
    (candidate.message.trim().length > 0 || candidate.hasAttachments)
  );
}

function markAutoPrompted(storage: Storage): void {
  // Persist the one-shot contract before asking so re-entrant sends cannot prompt twice.
  try {
    storage.setItem(NOTIFICATIONS_AUTO_PROMPT_KEY, "1");
  } catch {
    // Permission state still prevents repeat prompts after a completed decision.
  }
}

export function autoPromptNotificationsOnSend(context: NotificationsContext): void {
  const snapshot = context.notifications.snapshot;
  // Native permission belongs to the explicit Settings action. Merely using
  // chat must not prompt, including when an embedded dashboard lacks support.
  if (snapshot.kind === "native") {
    return;
  }
  let storage: Storage;
  try {
    storage = localStorage;
    if (storage.getItem(NOTIFICATIONS_AUTO_PROMPT_KEY) !== null) {
      return;
    }
  } catch {
    return;
  }

  if (
    !snapshot.supported ||
    snapshot.permission !== "default" ||
    snapshot.subscription === "registered" ||
    snapshot.subscription === "vapid-mismatch" ||
    snapshot.loading
  ) {
    // Denied and granted permissions are terminal for automatic prompts.
    return;
  }
  markAutoPrompted(storage);
  try {
    // Invoke the browser prompt before leaving the user-gesture tick. Web-push
    // subscription can continue asynchronously after permission is granted.
    const permission = Notification.requestPermission();
    void permission
      .then((next) => {
        if (next === "granted") {
          void context.notifications.run({ kind: "enable" });
        }
      })
      .catch(() => {});
  } catch {
    // Notification prompting must never interrupt chat sending.
  }
}
