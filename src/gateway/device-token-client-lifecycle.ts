import type { GatewayRequestContext } from "./server-methods/types.js";

/** Retire the connected authority held by replaced or revoked role tokens. */
export function retireDeviceTokenClients(
  context: Pick<GatewayRequestContext, "invalidateClientsForDevice" | "disconnectClientsForDevice">,
  deviceId: string,
  roles: readonly string[],
  reason: "device-token-rotated" | "device-token-revoked",
): void {
  // Fence buffered requests synchronously; defer socket closure so the caller
  // can finish an in-band rotation response in this same synchronous turn.
  for (const role of roles) {
    context.invalidateClientsForDevice?.(deviceId, { role, reason });
  }
  queueMicrotask(() => {
    for (const role of roles) {
      context.disconnectClientsForDevice?.(deviceId, { role });
    }
  });
}
