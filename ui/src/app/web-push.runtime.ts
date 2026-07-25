import type { GatewayBrowserClient } from "../api/gateway.ts";

const SW_READY_TIMEOUT = 10_000;

function swReady(): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Service worker not ready (timed out)")), SW_READY_TIMEOUT);
    }),
  ]);
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

export async function subscribeToWebPush(
  client: GatewayBrowserClient,
): Promise<{ subscriptionId: string }> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(`Notification permission ${permission}`);
  }

  const vapidRes = await client.request("push.web.vapidPublicKey", {});
  const vapidPublicKey = (vapidRes as { vapidPublicKey: string }).vapidPublicKey;
  if (!vapidPublicKey) {
    throw new Error("Failed to retrieve VAPID public key");
  }

  const registration = await swReady();
  const pushSubscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey).buffer as ArrayBuffer,
  });
  const subscription = pushSubscription.toJSON();
  if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys.auth) {
    throw new Error("Invalid push subscription from browser");
  }

  try {
    return (await client.request("push.web.subscribe", {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
    })) as { subscriptionId: string };
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
