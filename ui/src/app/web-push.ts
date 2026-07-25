// Application-owned browser push subscription lifecycle.
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGateway } from "./gateway.ts";

type WebPushSnapshot = {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  loading: boolean;
  error: string | null;
};

export type WebPushCapability = {
  readonly snapshot: WebPushSnapshot;
  subscribe: (listener: (snapshot: WebPushSnapshot) => void) => () => void;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  sendTest: () => Promise<void>;
  dispose: () => void;
};

function isWebPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function webPushError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWebPushCapability(gateway: ApplicationGateway): WebPushCapability {
  const supported = isWebPushSupported();
  let snapshot: WebPushSnapshot = {
    supported,
    permission: supported ? Notification.permission : "unsupported",
    subscribed: false,
    loading: false,
    error: null,
  };
  let disposed = false;
  let wasConnected = false;
  let operation: Promise<void> | null = null;
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

  const readExistingSubscription = async () => {
    if (!supported) {
      return null;
    }
    const { getExistingSubscription } = await import("./web-push.runtime.ts");
    const subscription = await getExistingSubscription();
    publish({ subscribed: subscription !== null });
    return subscription;
  };

  const reconcile = async (client: GatewayBrowserClient) => {
    try {
      const subscription = await readExistingSubscription();
      const json = subscription?.toJSON();
      if (!json?.endpoint || !json.keys?.p256dh || !json.keys.auth) {
        return;
      }
      await client.request("push.web.subscribe", {
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      });
    } catch {
      // Existing subscriptions are reconciled best-effort after reconnect.
    }
  };

  const run = (action: (client: GatewayBrowserClient) => Promise<void>) => {
    const client = gateway.snapshot.client;
    if (!supported || !client || operation) {
      return operation ?? Promise.resolve();
    }
    publish({ loading: true, error: null });
    operation = action(client)
      .catch((error: unknown) => {
        publish({ error: webPushError(error) });
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

  void readExistingSubscription().catch(() => {});
  const stopGateway = gateway.subscribe((gatewaySnapshot) => {
    const client = gatewaySnapshot.client;
    const connected = gatewaySnapshot.phase === "connected" && client !== null;
    if (connected && !wasConnected && client) {
      void reconcile(client);
    }
    wasConnected = connected;
  });

  return {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    enable: () =>
      run(async (client) => {
        const { subscribeToWebPush } = await import("./web-push.runtime.ts");
        await subscribeToWebPush(client);
        publish({ subscribed: true });
      }),
    disable: () =>
      run(async (client) => {
        const { unsubscribeFromWebPush } = await import("./web-push.runtime.ts");
        await unsubscribeFromWebPush(client);
        publish({ subscribed: false });
      }),
    sendTest: () =>
      run(async (client) => {
        const { sendTestWebPush } = await import("./web-push.runtime.ts");
        await sendTestWebPush(client);
      }),
    dispose() {
      disposed = true;
      stopGateway();
      listeners.clear();
    },
  };
}
