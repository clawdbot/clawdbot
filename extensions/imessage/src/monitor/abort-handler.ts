export type IMessageMonitorClient = {
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  stop: () => Promise<void>;
};

export function attachIMessageMonitorAbortHandler(params: {
  abortSignal?: AbortSignal;
  client: IMessageMonitorClient;
  getSubscriptionId: () => number | null;
}): () => void {
  const abort = params.abortSignal;
  if (!abort) {
    return () => {};
  }

  const onAbort = () => {
    const subscriptionId = params.getSubscriptionId();
    if (subscriptionId) {
      void params.client
        .request("watch.unsubscribe", {
          subscription: subscriptionId,
        })
        .catch(() => {
          // Ignore disconnect errors during shutdown.
        });
    }
    void params.client.stop().catch(() => {
      // Ignore disconnect errors during shutdown.
    });
  };

  abort.addEventListener("abort", onAbort, { once: true });
  return () => abort.removeEventListener("abort", onAbort);
}
