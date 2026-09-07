import type { GatewayClient } from "../server-methods/client-types.js";

export type DesktopObserveRequester = {
  connId?: string;
  signal?: AbortSignal;
  isCurrent: () => boolean;
};

export function resolveDesktopObserveRequester(options: {
  client: GatewayClient | null;
  hasCurrentClientAuthority?: () => boolean;
}): DesktopObserveRequester | undefined {
  const { client, hasCurrentClientAuthority } = options;
  if (!client) {
    return undefined;
  }
  // Invalidation precedes the transport close event and its abort signal.
  return {
    connId: client.connId,
    signal: client.connectionSignal,
    isCurrent: () =>
      client.invalidated !== true &&
      !client.connectionSignal?.aborted &&
      hasCurrentClientAuthority?.() !== false,
  };
}

/** True when no requester constraint applies, or the requester is still live. */
export function isDesktopObserveRequesterCurrent(
  requester: DesktopObserveRequester | undefined,
): boolean {
  if (!requester) {
    return true;
  }
  return requester.isCurrent() !== false && requester.signal?.aborted !== true;
}

/**
 * Invokes `onGone` when the Gateway requester aborts (or is already gone).
 * Returns an unsubscribe that is safe to call more than once.
 */
export function watchDesktopObserveRequesterGone(
  requester: DesktopObserveRequester | undefined,
  onGone: () => void,
): () => void {
  if (!requester) {
    return () => {};
  }
  if (!isDesktopObserveRequesterCurrent(requester)) {
    onGone();
    return () => {};
  }
  const signal = requester.signal;
  if (!signal) {
    return () => {};
  }
  const onAbort = () => onGone();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
