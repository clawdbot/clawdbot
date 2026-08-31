import type {
  NativeNotificationsRuntime,
  NativeNotificationsSnapshot,
} from "./native-notifications.runtime.ts";
import { isNativeWebChromeHost } from "./native-web-chrome.ts";
import type { NotificationsCapability } from "./notifications.ts";

export type {
  NativeNotificationsPermission,
  NativeNotificationsSnapshot,
} from "./native-notifications.runtime.ts";
export const NATIVE_NOTIFICATIONS_STATUS_EVENT = "openclaw:native-notifications-status";
export const NATIVE_BRIDGE_UPDATE_MESSAGE =
  "Update the OpenClaw app and Gateway, then reopen Notifications to manage native notifications.";

type NativeNotificationsPoster = {
  postMessage: Parameters<
    typeof import("./native-notifications.runtime.ts").createNativeNotificationsRuntime
  >[0]["post"];
};
type NativeNotificationsWindow = Window & {
  __OPENCLAW_NATIVE_NOTIFICATIONS__?: unknown;
  __OPENCLAW_NATIVE_NOTIFICATIONS_BRIDGE__?: NativeNotificationsPoster;
  webkit?: { messageHandlers?: { openclawNotifications?: NativeNotificationsPoster } };
};

export type NativeNotificationsCapability = NotificationsCapability & {
  readonly snapshot: NativeNotificationsSnapshot;
};

export function createNativeNotificationsCapability(): NativeNotificationsCapability | null {
  if (typeof window === "undefined") {
    return null;
  }
  const nativeWindow = window as NativeNotificationsWindow;
  const poster =
    nativeWindow["__OPENCLAW_NATIVE_NOTIFICATIONS_BRIDGE__"] ??
    nativeWindow.webkit?.messageHandlers?.openclawNotifications;
  if (
    !poster &&
    !isNativeWebChromeHost() &&
    !("__TAURI__" in window) &&
    !("__OPENCLAW_NATIVE_CONTROL_AUTH__" in window)
  ) {
    return null;
  }
  let snapshot: NativeNotificationsSnapshot = {
    kind: "native",
    supported: false,
    permission: "unknown",
    loading: Boolean(poster),
    error: poster ? null : NATIVE_BRIDGE_UPDATE_MESSAGE,
  };
  let disposed = false;
  let owner: NativeNotificationsRuntime | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: NativeNotificationsSnapshot) => {
    if (disposed) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };
  // Native status may arrive while its validator is loading. No action is
  // available yet, so the latest snapshot is the complete state to hand over.
  let initial: unknown = nativeWindow["__OPENCLAW_NATIVE_NOTIFICATIONS__"];
  const bufferStatus = (event: Event) => {
    initial = (event as CustomEvent<unknown>).detail;
  };
  const stopBuffering = () =>
    window.removeEventListener(NATIVE_NOTIFICATIONS_STATUS_EVENT, bufferStatus);
  if (poster) {
    window.addEventListener(NATIVE_NOTIFICATIONS_STATUS_EVENT, bufferStatus);
  }
  const runtime = poster
    ? import("./native-notifications.runtime.ts")
        .then(({ createNativeNotificationsRuntime }) => {
          stopBuffering();
          if (disposed) {
            return null;
          }
          const post = poster.postMessage.bind(poster);
          owner = createNativeNotificationsRuntime({
            initial,
            post(message) {
              if (!disposed) {
                post(message);
              }
            },
            publish,
          });
          if (disposed) {
            owner.dispose();
            return null;
          }
          return owner;
        })
        .catch(() => {
          stopBuffering();
          if (!disposed) {
            publish({
              kind: "native",
              supported: false,
              permission: "unknown",
              loading: false,
              error: "Native notifications could not be loaded. Reload the page to try again.",
            });
          }
          return null;
        })
    : null;
  return {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    run(action) {
      return disposed
        ? Promise.resolve()
        : owner
          ? owner.run(action)
          : runtime
            ? runtime.then((loaded) => loaded?.run(action))
            : Promise.resolve();
    },
    dispose() {
      disposed = true;
      stopBuffering();
      owner?.dispose();
      listeners.clear();
    },
  };
}
