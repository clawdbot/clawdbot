import type { GatewayBrowserClient } from "../api/gateway.ts";

const SW_READY_TIMEOUT = 10_000;
const VAPID_MISMATCH_MESSAGE =
  "This browser push subscription belongs to another Gateway. Open this Gateway's own Control UI, or configure every mutually trusted Gateway behind this PWA with the same VAPID keypair.";

type WebPushReconcileResult =
  | { state: "missing" }
  | { state: "registered" }
  | { state: "vapid-mismatch"; error: string };

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
  return await registration.pushManager.getSubscription();
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

export async function subscribeToWebPush(
  client: GatewayBrowserClient,
): Promise<{ subscriptionId: string }> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(`Notification permission ${permission}`);
  }

  const registration = await swReady();
  const vapidPublicKey = await resolveGatewayVapidPublicKey(client);
  const existingSubscription = await registration.pushManager.getSubscription();
  if (existingSubscription) {
    if (!subscriptionUsesVapidKey(existingSubscription, vapidPublicKey)) {
      await clearMismatchedGatewaySubscription(client, existingSubscription);
      throw new Error(VAPID_MISMATCH_MESSAGE);
    }
    return await registerPushSubscription(client, existingSubscription);
  }
  const pushSubscription = await registration.pushManager.subscribe({
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
  const subscription = await registration.pushManager.getSubscription();
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
