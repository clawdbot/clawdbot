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
 * Rechecks the incumbent worker after a Gateway reconnect. A deployment can
 * restart the Gateway without changing the package version, so the socket's
 * version handshake alone cannot retire an already-open document.
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
  const incumbent = registration.active;
  await registration.update();
  const replacement =
    registration.installing ??
    registration.waiting ??
    (registration.active !== incumbent ? registration.active : null);
  return replacement ? waitForReplacementWorker(replacement) : false;
}
