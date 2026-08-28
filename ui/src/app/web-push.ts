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

export function createWebPushCapability(gateway: ApplicationGateway): WebPushCapability {
  const runtime = import("./web-push.runtime.ts");
  let snapshot: WebPushSnapshot = {
    supported: false,
    permission: "unsupported",
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
    if (!snapshot.supported || !client || operation) {
      return operation ?? Promise.resolve();
    }
    publish({ loading: true, error: null });
    operation = runtime
      .then(({ runWebPushCapabilityAction }) => runWebPushCapabilityAction(client, action))
      .then(publish)
      .catch((error: unknown) => {
        publish({ error: formatUiError(error) });
      })
      .finally(() => {
        operation = null;
        publish({
          loading: false,
          permission: "Notification" in window ? Notification.permission : "unsupported",
        });
      });
    return operation;
  };

  void runtime.then(
    ({ resolveWebPushSupport, startWebPushReconciliation }) => {
      if (!disposed) {
        const support = resolveWebPushSupport();
        publish(support);
        if (support.supported) {
          stopReconciliation = startWebPushReconciliation({ gateway, publish });
        }
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
