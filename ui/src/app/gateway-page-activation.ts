import type { GatewayBrowserClient } from "../api/gateway.ts";

type PageActivationGateway = {
  readonly snapshot: { readonly client: Pick<GatewayBrowserClient, "needsWakeReconnect"> | null };
  connect: () => void;
};

/** Revalidates process-backed browser state after Safari resumes a suspended tab. */
export function startGatewayPageActivation(
  gateway: PageActivationGateway,
  documentTarget: Document,
  windowTarget: Window,
): () => void {
  let disposed = false;
  let queued = false;
  let forceRecovery = false;
  let wasHidden = documentTarget.visibilityState === "hidden";

  const schedule = (force: boolean) => {
    if (documentTarget.visibilityState === "hidden") {
      return;
    }
    forceRecovery ||= force;
    if (queued) {
      return;
    }
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const forceQueuedRecovery = forceRecovery;
      forceRecovery = false;
      if (disposed || documentTarget.visibilityState === "hidden") {
        return;
      }
      const client = gateway.snapshot.client;
      if (client && (forceQueuedRecovery || client.needsWakeReconnect)) {
        // Replacing the client retires Safari's ghost socket synchronously. A
        // socket close would depend on the suspended transport firing `close`.
        gateway.connect();
      }
      void import("./sw-refresh.runtime.ts")
        .then(({ refreshControlUiServiceWorker }) => refreshControlUiServiceWorker())
        .catch((error: unknown) => {
          console.warn("OpenClaw service worker refresh failed after page activation.", error);
        });
    });
  };
  const onVisibilityChange = () => {
    if (documentTarget.visibilityState === "hidden") {
      wasHidden = true;
      return;
    }
    if (wasHidden) {
      wasHidden = false;
      schedule(false);
    }
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      schedule(true);
    }
  };
  const onOnline = () => schedule(false);

  documentTarget.addEventListener("visibilitychange", onVisibilityChange);
  windowTarget.addEventListener("pageshow", onPageShow);
  windowTarget.addEventListener("online", onOnline);
  return () => {
    disposed = true;
    documentTarget.removeEventListener("visibilitychange", onVisibilityChange);
    windowTarget.removeEventListener("pageshow", onPageShow);
    windowTarget.removeEventListener("online", onOnline);
  };
}
