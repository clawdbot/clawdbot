import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { inferControlUiPublicAssetPath } from "./public-assets.ts";

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

function serviceWorkerContainer(): ServiceWorkerContainer | null {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator
    ? navigator.serviceWorker
    : null;
}

export function installControlUiServiceWorker(production: boolean): void {
  const serviceWorker = serviceWorkerContainer();
  if (!serviceWorker) {
    return;
  }
  if (!production) {
    // Unregister any leftover dev SW to avoid stale cache issues.
    void serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) {
        void registration.unregister();
      }
    });
    return;
  }

  const currentBuildId = CONTROL_UI_BUILD_INFO.buildId;
  const swUrl = new URL(inferControlUiPublicAssetPath("sw.js"), window.location.origin);
  swUrl.searchParams.set("v", currentBuildId);
  serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "sw-updated" && event.data.version !== currentBuildId) {
      window.location.reload();
    }
  });
  registrationPromise = serviceWorker.register(swUrl, { updateViaCache: "none" }).catch(() => null);
}

/**
 * Rechecks the incumbent worker after a Gateway reconnect. A deployment can
 * restart the Gateway without changing the package version, so the socket's
 * version handshake alone cannot retire an already-open document.
 */
export async function refreshControlUiServiceWorker(): Promise<void> {
  const serviceWorker = serviceWorkerContainer();
  if (!serviceWorker) {
    return;
  }
  const registration = await (registrationPromise ?? serviceWorker.getRegistration());
  await registration?.update();
}
