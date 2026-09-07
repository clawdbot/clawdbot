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
