/**
 * Client manager registry for Twitch plugin.
 *
 * Manages the lifecycle of TwitchClientManager instances across the plugin,
 * ensuring proper cleanup when accounts are stopped or reconfigured.
 */

import { TwitchClientManager } from "./twitch-client.js";
import type { ChannelLogSink } from "./types.js";

/**
 * Registry entry tracking a client manager and its associated account.
 */
type RegistryEntry = {
  /** The client manager instance */
  manager: TwitchClientManager;
  /** The account ID this manager is for */
  accountId: string;
  /** Logger for this entry */
  logger: ChannelLogSink;
  /** When this entry was created */
  createdAt: number;
};

/**
 * Global registry of client managers.
 * Keyed by account ID.
 */
const registry = new Map<string, RegistryEntry>();

/**
 * Get or create a client manager for an account.
 *
 * @param accountId - The account ID
 * @param logger - Logger instance
 * @returns The client manager
 */
export function getOrCreateClientManager(
  accountId: string,
  logger: ChannelLogSink,
): TwitchClientManager {
  const existing = registry.get(accountId);
  if (existing) {
    return existing.manager;
  }

  const manager = new TwitchClientManager(logger);
  registry.set(accountId, {
    manager,
    accountId,
    logger,
    createdAt: Date.now(),
  });

  logger.info(`Registered client manager for account: ${accountId}`);
  return manager;
}

/**
 * Get an existing client manager for an account.
 *
 * @param accountId - The account ID
 * @returns The client manager, or undefined if not registered
 */
export function getClientManager(accountId: string): TwitchClientManager | undefined {
  return registry.get(accountId)?.manager;
}

/**
 * Disconnect and remove a client manager from the registry.
 *
 * @param accountId - The account ID
 * @returns Promise that resolves when cleanup is complete
 */
export async function removeClientManager(accountId: string): Promise<void> {
  const entry = registry.get(accountId);
  if (!entry) {
    return;
  }

  // Disconnect the client manager
  await entry.manager.disconnectAll();

  // Remove from registry
  registry.delete(accountId);
  entry.logger.info(`Unregistered client manager for account: ${accountId}`);
}

/**
 * Disconnect and remove all client managers from the registry.
 *
 * @returns Promise that resolves when all cleanup is complete
 */
export async function removeAllClientManagers(): Promise<void> {
  const promises = [...registry.keys()].map((accountId) => removeClientManager(accountId));
  await Promise.all(promises);
}

/**
 * Get the number of registered client managers.
 *
 * @returns The count of registered managers
 */
export function getRegisteredClientManagerCount(): number {
  return registry.size;
}

/**
 * Clear all client managers without disconnecting.
 *
 * This is primarily for testing purposes.
 */
export function _clearAllClientManagersForTest(): void {
  registry.clear();
}
