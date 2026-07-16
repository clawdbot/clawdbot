import type { GatewayPlugin } from "@buape/carbon/gateway";

/**
 * Module-level registry of active Discord GatewayPlugin instances.
 * Bridges the gap between agent tool handlers (which only have REST access)
 * and the gateway WebSocket (needed for operations like updatePresence).
 * Follows the same pattern as presence-cache.ts.
 */
const gatewayRegistry = new Map<string, GatewayPlugin>();

// Sentinel key for the default (unnamed) account. Uses a prefix that cannot
// collide with user-configured account IDs.
const DEFAULT_ACCOUNT_KEY = "\0__default__";

function resolveAccountKey(accountId?: string): string {
  return accountId ?? DEFAULT_ACCOUNT_KEY;
}

/** Register a GatewayPlugin instance for an account. */
export function registerGateway(accountId: string | undefined, gateway: GatewayPlugin): void {
  gatewayRegistry.set(resolveAccountKey(accountId), gateway);
}

/** Unregister a GatewayPlugin instance for an account. */
export function unregisterGateway(accountId?: string): void {
  gatewayRegistry.delete(resolveAccountKey(accountId));
}

/** Get the GatewayPlugin for an account. Returns undefined if not registered. */
export function getGateway(accountId?: string): GatewayPlugin | undefined {
  return gatewayRegistry.get(resolveAccountKey(accountId));
}

/** Clear all registered gateways (for testing). */
export function clearGateways(): void {
  gatewayRegistry.clear();
}
