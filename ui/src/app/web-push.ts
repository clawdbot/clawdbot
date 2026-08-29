import type {
  WebPushDevicePreferences,
  WebPushNotificationPreferences,
} from "../../../packages/gateway-protocol/src/schema/push.ts";
// Application-owned browser push subscription lifecycle.
import { formatUiError } from "../lib/format-error.ts";
import type { ApplicationGateway } from "./gateway.ts";
import type { WebPushCapabilityAction, WebPushPreferencesResult } from "./web-push.runtime.ts";

type WebPushSnapshot = {
  supported: boolean;
  permission: NotificationPermission | "install-required" | "unsupported";
  subscribed: boolean;
  loading: boolean;
  error: string | null;
  preferences?: WebPushPreferencesResult | null;
};

export type WebPushCapability = {
  readonly snapshot: WebPushSnapshot;
  subscribe: (listener: (snapshot: WebPushSnapshot) => void) => () => void;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  sendTest: () => Promise<void>;
  setPreferences: (
    scope: "user" | "device",
    preferences: WebPushNotificationPreferences | WebPushDevicePreferences,
  ) => Promise<void>;
  dispose: () => void;
};

function resolveWebPushSupport(): Pick<WebPushSnapshot, "supported" | "permission"> {
  const nav = globalThis.navigator;
  const ios =
    /iPad|iPhone|iPod/u.test(nav.userAgent) ||
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  // SAFETY: iOS Safari's non-standard standalone flag is optional and read-only.
  const iosNavigator = nav as Navigator & { standalone?: boolean };
  if (ios && iosNavigator.standalone !== true) {
    return { supported: false, permission: "install-required" };
  }
  const supported =
    "serviceWorker" in nav && "PushManager" in globalThis && "Notification" in globalThis;
  return {
    supported,
    permission: supported ? Notification.permission : "unsupported",
  };
}

export function createWebPushCapability(gateway: ApplicationGateway): WebPushCapability {
  const runtime = import("./web-push.runtime.ts");
  let snapshot: WebPushSnapshot = {
    ...resolveWebPushSupport(),
    subscribed: false,
    loading: false,
    error: null,
  };
  let disposed = false;
  let operation: Promise<void> | null = null;
  let stopReconciliation: (() => void) | undefined;
  const listeners = new Set<(snapshot: WebPushSnapshot) => void>();

  const publish = (patch: Partial<WebPushSnapshot>) => {
    if (disposed) {
      return;
    }
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const runAction = (action: WebPushCapabilityAction) => {
    const client = gateway.snapshot.client;
    if (!snapshot.supported || !client) {
      return Promise.resolve();
    }
    if (!operation) {
      publish({ loading: true, error: null });
    }
    const previous = operation;
    const actionRun = (previous ?? Promise.resolve())
      .then(async () => {
        publish({ error: null });
        if (gateway.snapshot.client !== client) {
          throw new Error("Gateway changed before the notification change could be saved.");
        }
        const { runWebPushCapabilityAction } = await runtime;
        return await runWebPushCapabilityAction(client, action);
      })
      .then(publish)
      .catch((error: unknown) => {
        publish({ error: formatUiError(error) });
      });
    const next = actionRun.finally(() => {
      if (operation === next) {
        operation = null;
        publish({
          loading: false,
          permission: "Notification" in window ? Notification.permission : "unsupported",
        });
      }
    });
    operation = next;
    return next;
  };

  void runtime.then(
    ({ startWebPushReconciliation }) => {
      if (!disposed && snapshot.supported) {
        stopReconciliation = startWebPushReconciliation({ gateway, publish });
      }
    },
    (error: unknown) => publish({ error: formatUiError(error) }),
  );

  return {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    enable: () => runAction({ kind: "enable" }),
    disable: () => runAction({ kind: "disable" }),
    sendTest: () => runAction({ kind: "test" }),
    setPreferences: (scope, preferences) => runAction({ kind: "set", scope, preferences }),
    dispose() {
      disposed = true;
      stopReconciliation?.();
      listeners.clear();
    },
  };
}
