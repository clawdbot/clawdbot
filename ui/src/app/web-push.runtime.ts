import type {
  WebPushDevicePreferences,
  WebPushNotificationPreferences,
} from "../../../packages/gateway-protocol/src/schema/push.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { ApplicationGateway } from "./gateway.ts";

const SW_READY_TIMEOUT = 10_000;
const VAPID_MISMATCH_MESSAGE =
  "This browser push subscription belongs to another Gateway. Open this Gateway's own Control UI, or configure every mutually trusted Gateway behind this PWA with the same VAPID keypair.";
const WEB_PUSH_USER_PREFERENCES_KEY = "notifications.web.v1";

type WebPushReconcileResult =
  | { state: "missing" }
  | { state: "registered" }
  | { state: "vapid-mismatch"; error: string };

export type WebPushPreferencesResult = {
  durableIdentity: boolean;
  user: WebPushNotificationPreferences;
  device: WebPushDevicePreferences;
  effective: WebPushNotificationPreferences & { enabled: boolean; label: string };
};

export type WebPushCapabilityAction =
  | { kind: "enable" | "disable" | "test" }
  | {
      kind: "set";
      scope: "user" | "device";
      preferences: WebPushNotificationPreferences | WebPushDevicePreferences;
    };

export type WebPushCapabilityPatch = {
  error?: string | null;
  subscribed?: boolean;
  preferences?: WebPushPreferencesResult | null;
};

function swReady(): Promise<ServiceWorkerRegistration> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("Service worker not ready (timed out)")),
      SW_READY_TIMEOUT,
    );
  });
  return Promise.race([navigator.serviceWorker.ready, timeoutPromise]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}

function pushManagerFor(registration: ServiceWorkerRegistration): PushManager | null {
  const manager = registration.pushManager;
  return manager && typeof manager.getSubscription === "function" ? manager : null;
}

function requirePushManager(registration: ServiceWorkerRegistration): PushManager {
  const manager = pushManagerFor(registration);
  if (!manager || typeof manager.subscribe !== "function") {
    throw new Error(
      "Web Push is unavailable in this browser. On iPhone or iPad, add OpenClaw to the Home Screen and open the installed app.",
    );
  }
  return manager;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) {
    return null;
  }
  const registration = await swReady();
  return (await pushManagerFor(registration)?.getSubscription()) ?? null;
}

async function resolveGatewayVapidPublicKey(client: GatewayBrowserClient): Promise<Uint8Array> {
  const vapidRes = await client.request("push.web.vapidPublicKey", {});
  const vapidPublicKey = (vapidRes as { vapidPublicKey: string }).vapidPublicKey;
  if (!vapidPublicKey) {
    throw new Error("Failed to retrieve VAPID public key");
  }
  return urlBase64ToUint8Array(vapidPublicKey);
}

function subscriptionUsesVapidKey(
  subscription: PushSubscription,
  vapidPublicKey: Uint8Array,
): boolean {
  const applicationServerKey = subscription.options.applicationServerKey;
  if (!applicationServerKey) {
    return false;
  }
  const currentKey = new Uint8Array(applicationServerKey);
  return (
    currentKey.length === vapidPublicKey.length &&
    currentKey.every((value, index) => value === vapidPublicKey[index])
  );
}

function serializePushSubscription(subscription: PushSubscription) {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error("Invalid push subscription from browser");
  }
  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
}

async function registerPushSubscription(
  client: GatewayBrowserClient,
  subscription: PushSubscription,
): Promise<{ subscriptionId: string }> {
  return (await client.request("push.web.subscribe", serializePushSubscription(subscription))) as {
    subscriptionId: string;
  };
}

async function clearMismatchedGatewaySubscription(
  client: GatewayBrowserClient,
  subscription: PushSubscription,
): Promise<void> {
  // Remove only this Gateway's unusable row. Keep the browser subscription so
  // the Gateway that owns its VAPID identity continues receiving notifications.
  await client
    .request("push.web.unsubscribe", { endpoint: subscription.endpoint })
    .catch(() => undefined);
}

export async function reconcileExistingWebPushSubscription(
  client: GatewayBrowserClient,
): Promise<WebPushReconcileResult> {
  const subscription = await getExistingSubscription();
  if (!subscription) {
    return { state: "missing" };
  }
  const vapidPublicKey = await resolveGatewayVapidPublicKey(client);
  if (!subscriptionUsesVapidKey(subscription, vapidPublicKey)) {
    await clearMismatchedGatewaySubscription(client, subscription);
    return { state: "vapid-mismatch", error: VAPID_MISMATCH_MESSAGE };
  }
  await registerPushSubscription(client, subscription);
  return { state: "registered" };
}

export async function reconcileWebPushCapability(
  client: GatewayBrowserClient,
): Promise<WebPushCapabilityPatch> {
  const result = await reconcileExistingWebPushSubscription(client);
  return {
    subscribed: result.state !== "missing",
    preferences: result.state === "registered" ? await getWebPushPreferences(client) : null,
    error: result.state === "vapid-mismatch" ? result.error : null,
  };
}

export function startWebPushReconciliation(params: {
  gateway: ApplicationGateway;
  publish: (patch: WebPushCapabilityPatch) => void;
}): () => void {
  let connectedClient: GatewayBrowserClient | null = null;
  let generation = 0;
  let disposed = false;
  const reconcile = async (client: GatewayBrowserClient, currentGeneration: number) => {
    let patch: WebPushCapabilityPatch;
    try {
      patch = await reconcileWebPushCapability(client);
    } catch (error) {
      patch = { error: formatUiError(error) };
    }
    if (
      !disposed &&
      currentGeneration === generation &&
      params.gateway.snapshot.phase === "connected" &&
      params.gateway.snapshot.client === client
    ) {
      params.publish(patch);
    }
  };
  void getExistingSubscription()
    .then((subscription) => params.publish({ subscribed: subscription !== null }))
    .catch(() => {});
  const handleGateway = (snapshot: ApplicationGateway["snapshot"]) => {
    const client = snapshot.phase === "connected" ? snapshot.client : null;
    if (client === connectedClient) {
      return;
    }
    connectedClient = client;
    const currentGeneration = ++generation;
    if (client) {
      void reconcile(client, currentGeneration);
    }
  };
  const stopGateway = params.gateway.subscribe(handleGateway);
  const stopEvents = params.gateway.subscribeEvents((event) => {
    const payload = event.payload;
    const client = params.gateway.snapshot.client;
    if (
      event.event !== "users.prefs.changed" ||
      !client ||
      !payload ||
      typeof payload !== "object" ||
      !("profileId" in payload) ||
      payload.profileId !== params.gateway.snapshot.selfUser?.id ||
      !("keys" in payload) ||
      !Array.isArray(payload.keys) ||
      !payload.keys.includes(WEB_PUSH_USER_PREFERENCES_KEY)
    ) {
      return;
    }
    void reconcile(client, ++generation);
  });
  handleGateway(params.gateway.snapshot);
  return () => {
    disposed = true;
    generation += 1;
    stopGateway();
    stopEvents();
  };
}

export async function subscribeToWebPush(
  client: GatewayBrowserClient,
): Promise<{ subscriptionId: string }> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(`Notification permission ${permission}`);
  }

  const registration = await swReady();
  const pushManager = requirePushManager(registration);
  const vapidPublicKey = await resolveGatewayVapidPublicKey(client);
  const existingSubscription = await pushManager.getSubscription();
  if (existingSubscription) {
    if (!subscriptionUsesVapidKey(existingSubscription, vapidPublicKey)) {
      await clearMismatchedGatewaySubscription(client, existingSubscription);
      throw new Error(VAPID_MISMATCH_MESSAGE);
    }
    return await registerPushSubscription(client, existingSubscription);
  }
  const pushSubscription = await pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidPublicKey.buffer as ArrayBuffer,
  });

  try {
    return await registerPushSubscription(client, pushSubscription);
  } catch (error) {
    try {
      await pushSubscription.unsubscribe();
    } catch {
      // The Gateway error remains the actionable failure.
    }
    throw error;
  }
}

export async function unsubscribeFromWebPush(client: GatewayBrowserClient): Promise<void> {
  const registration = await swReady();
  const subscription = (await pushManagerFor(registration)?.getSubscription()) ?? null;
  if (!subscription) {
    return;
  }
  try {
    await client.request("push.web.unsubscribe", {
      endpoint: subscription.endpoint,
    });
  } catch {
    // Local unsubscribe still prevents a stale browser subscription.
  }
  await subscription.unsubscribe();
}

export async function sendTestWebPush(client: GatewayBrowserClient): Promise<void> {
  await client.request("push.web.test", {});
}

async function requireExistingSubscription(): Promise<PushSubscription> {
  const subscription = await getExistingSubscription();
  if (!subscription) {
    throw new Error("Enable notifications before changing notification preferences.");
  }
  return subscription;
}

export async function getWebPushPreferences(
  client: GatewayBrowserClient,
): Promise<WebPushPreferencesResult> {
  const subscription = await requireExistingSubscription();
  const result = await client.request("push.web.preferences.get", {
    endpoint: subscription.endpoint,
  });
  // SAFETY: the Gateway validates and owns the closed preferences result contract.
  return result as WebPushPreferencesResult;
}

export async function setWebPushPreferences(
  client: GatewayBrowserClient,
  scope: "user" | "device",
  preferences: WebPushNotificationPreferences | WebPushDevicePreferences,
): Promise<WebPushPreferencesResult> {
  const subscription = await requireExistingSubscription();
  await client.request("push.web.preferences.set", {
    endpoint: subscription.endpoint,
    scope,
    preferences,
  });
  return await getWebPushPreferences(client);
}

export async function runWebPushCapabilityAction(
  client: GatewayBrowserClient,
  action: WebPushCapabilityAction,
): Promise<WebPushCapabilityPatch> {
  switch (action.kind) {
    case "enable":
      await subscribeToWebPush(client);
      return { subscribed: true, preferences: await getWebPushPreferences(client) };
    case "disable":
      await unsubscribeFromWebPush(client);
      return { subscribed: false, preferences: null };
    case "test":
      await sendTestWebPush(client);
      return {};
    case "set":
      return {
        preferences: await setWebPushPreferences(client, action.scope, action.preferences),
      };
    default:
      return action satisfies never;
  }
}
