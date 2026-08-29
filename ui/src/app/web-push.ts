// Application-owned browser push subscription lifecycle.
import { formatUiError } from "../lib/format-error.ts";
import type { ApplicationGateway } from "./gateway.ts";
import type {
  WebPushCapabilityAction,
  WebPushCapabilityPatch,
  WebPushCapabilityRuntime,
  WebPushPreferencesResult,
} from "./web-push.runtime.ts";

type WebPushSnapshot = {
  supported: boolean;
  permission: NotificationPermission | "install-required" | "unsupported";
  subscribed: boolean;
  loading: boolean;
  error?: string | null;
  preferences?: WebPushPreferencesResult | null;
};

export type WebPushCapability = {
  readonly snapshot: WebPushSnapshot;
  subscribe: (listener: () => void) => () => void;
  run: (action: WebPushCapabilityAction) => Promise<void>;
  dispose: () => void;
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
    supported,
    permission: installed
      ? supported
        ? Notification.permission
        : "unsupported"
      : "install-required",
    subscribed: false,
    loading: false,
  };
  const listeners = new Set<() => void>();

  const publish = (patch: WebPushCapabilityPatch) => {
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
          publish({ error: formatUiError(error) });
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
