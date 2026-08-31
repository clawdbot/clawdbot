import { controlUiWorkerActivationRetires } from "../build-info.ts";

function waitForReplacementWorker(worker: ServiceWorker): Promise<boolean> {
  if (worker.state === "activated" || worker.state === "redundant") {
    return Promise.resolve(worker.state === "activated");
  }
  return new Promise((resolve) => {
    const onStateChange = () => {
      if (worker.state !== "activated" && worker.state !== "redundant") {
        return;
      }
      worker.removeEventListener("statechange", onStateChange);
      resolve(worker.state === "activated");
    };
    worker.addEventListener("statechange", onStateChange);
    onStateChange();
  });
}

/**
 * Reports whether a service worker update retires this document, so callers can
 * hold work back for the reload it is about to take. A deployment can restart
 * the Gateway without changing the package version, so the socket's version
 * handshake alone cannot retire an already-open document.
 */
export async function refreshControlUiServiceWorker(): Promise<boolean> {
  const serviceWorker =
    typeof navigator !== "undefined" && "serviceWorker" in navigator
      ? navigator.serviceWorker
      : null;
  if (!serviceWorker) {
    return false;
  }
  const registration = await serviceWorker.getRegistration();
  if (!registration) {
    return false;
  }
  // `registration.update()` is not a synchronization primitive: when an
  // install is already in flight it may reject or briefly hide that worker.
  // Fence against the document's controller before starting another check.
  const incumbent = serviceWorker.controller ?? registration.active;
  const pendingReplacement =
    registration.installing ??
    registration.waiting ??
    (registration.active && registration.active !== incumbent ? registration.active : null);
  if (pendingReplacement) {
    return replacementRetiresDocument(serviceWorker, pendingReplacement);
  }
  await registration.update();
  const replacement =
    registration.installing ??
    registration.waiting ??
    (registration.active !== incumbent ? registration.active : null);
  return replacement ? replacementRetiresDocument(serviceWorker, replacement) : false;
}

async function replacementRetiresDocument(
  serviceWorker: ServiceWorkerContainer,
  worker: ServiceWorker,
): Promise<boolean> {
  // `activate` announces the served build before the worker reports `activated`
  // (ui/public/sw.js), so listening from here catches the only signal that
  // separates a replacement which reloads this document from one that does not.
  // Activation alone cannot: a worker serving this document's own build
  // activates whenever the document reloaded onto the new bundle first, and
  // calling that a pending reload strands every fenced caller for good.
  let retiresDocument = false;
  const onWorkerMessage = (event: MessageEvent) => {
    retiresDocument ||= controlUiWorkerActivationRetires(event.data);
  };
  serviceWorker.addEventListener("message", onWorkerMessage);
  try {
    return (await waitForReplacementWorker(worker)) && retiresDocument;
  } finally {
    serviceWorker.removeEventListener("message", onWorkerMessage);
  }
}
