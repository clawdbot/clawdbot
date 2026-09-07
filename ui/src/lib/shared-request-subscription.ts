/** Subscriber identity and producer cancellation remain owned by the caller. */
export async function subscribeToSharedRequest<T, Subscriber extends object>(
  pending: {
    controller?: AbortController;
    promise: Promise<T>;
    subscribers: Set<Subscriber>;
  },
  subscriber: Subscriber,
  signal?: AbortSignal,
  onRelease?: () => void,
): Promise<T> {
  pending.subscribers.add(subscriber);
  let onAbort: (() => void) | undefined;
  try {
    if (!signal) {
      return await pending.promise;
    }
    let rejectAbort: (reason: unknown) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    onAbort = () => {
      pending.subscribers.delete(subscriber);
      if (pending.subscribers.size === 0) {
        pending.controller?.abort(signal.reason);
      }
      rejectAbort(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    return await Promise.race([pending.promise, aborted]);
  } finally {
    if (onAbort) {
      signal?.removeEventListener("abort", onAbort);
    }
    pending.subscribers.delete(subscriber);
    onRelease?.();
  }
}
