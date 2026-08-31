// Application-owned browser push subscription lifecycle.
import { formatUiError } from "../lib/format-error.ts";
import type { ApplicationGateway } from "./gateway.ts";
import type { NotificationPreferences, NotificationsCapability } from "./notifications.ts";
import type { WebPushCapabilityRuntime, WebPushSubscriptionState } from "./web-push.runtime.ts";

export type WebPushSnapshot = {
  kind: "web";
  supported: boolean;
  permission: NotificationPermission | "install-required" | "unsupported";
  subscription: WebPushSubscriptionState;
  loading: boolean;
  error?: string | null;
  preferences?: NotificationPreferences | null;
};

export type WebPushCapability = NotificationsCapability & {
  readonly snapshot: WebPushSnapshot;
};

export function createWebPushCapability(gateway: ApplicationGateway): WebPushCapability {
  const nav = globalThis.navigator;
  const ios =
    /iPad|iPhone|iPod/u.test(nav.userAgent) ||
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  // SAFETY: iOS Safari's non-standard standalone flag is optional and read-only.
  const installed = !ios || (nav as Navigator & { standalone?: boolean }).standalone === true;
  const supported =
    installed &&
    "serviceWorker" in nav &&
    "PushManager" in globalThis &&
    "Notification" in globalThis;
  const snapshot: WebPushSnapshot = {
    kind: "web",
    supported,
    permission: installed
      ? supported
        ? Notification.permission
        : "unsupported"
      : "install-required",
    subscription: "unknown",
    loading: false,
  };
  const listeners = new Set<() => void>();

  const publish = (patch: Partial<WebPushSnapshot>) => {
    Object.assign(snapshot, patch);
    for (const listener of listeners) {
      listener();
    }
  };
  const runtime: Promise<WebPushCapabilityRuntime | null> | null = snapshot.supported
    ? import("./web-push.runtime.ts")
        .then(({ createWebPushCapabilityRuntime }) =>
          createWebPushCapabilityRuntime({ gateway, publish }),
        )
        .catch((error: unknown) => {
          publish({
            supported: false,
            permission: "unsupported",
            subscription: "unknown",
            preferences: null,
            error: `Notifications could not be loaded. Reload the page to try again. ${formatUiError(error)}`,
          });
          return null;
        })
    : null;
  return {
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    run: (action) => (runtime ? runtime.then((owner) => owner?.run(action)) : Promise.resolve()),
    dispose() {
      void runtime?.then((owner) => owner?.dispose());
      listeners.clear();
    },
  };
}
