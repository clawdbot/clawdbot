/**
 * Session cleanup service for automatic TTL-based session removal.
 * @module session-cleanup
 * @see https://github.com/moltbot/moltbot/issues/3250
 */

import { loadConfig } from "../config/index.js";
import type { MoltbotConfig } from "../config/types.js";
import { log } from "../logging.js";
import { loadCombinedSessionStoreForGateway } from "./session-utils.js";
import {
  normalizeSessionTtl,
  getExpiredSessionKeys,
  getCleanupConfig,
  DEFAULT_CLEANUP_INTERVAL_SECONDS,
} from "./session-ttl.js";

let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Run a single cleanup pass.
 * @param cfg - Moltbot configuration
 * @returns Number of sessions cleaned up
 */
export async function runSessionCleanup(cfg: MoltbotConfig): Promise<number> {
  const sessionConfig = cfg.session;
  if (!sessionConfig?.ttl) {
    return 0;
  }

  const ttl = normalizeSessionTtl(sessionConfig.ttl);
  if (!ttl) {
    return 0;
  }

  const { store } = loadCombinedSessionStoreForGateway(cfg);
  const expiredKeys = getExpiredSessionKeys(store, ttl);

  if (expiredKeys.length === 0) {
    return 0;
  }

  log.info({ count: expiredKeys.length }, "[session-cleanup] Found expired sessions");

  // Delete expired sessions
  // Note: We import dynamically to avoid circular dependencies
  const { sessionsHandlers } = await import("./server-methods/sessions.js");

  let cleaned = 0;
  for (const key of expiredKeys) {
    try {
      // Create a mock respond function to track success
      let success = false;
      const respond = (ok: boolean) => {
        success = ok;
      };

      await sessionsHandlers["sessions.delete"]({
        params: { key },
        respond: respond as never,
        context: {} as never,
      });

      if (success) {
        cleaned++;
        log.debug({ key }, "[session-cleanup] Deleted expired session");
      }
    } catch (err) {
      log.warn({ key, err }, "[session-cleanup] Failed to delete session");
    }
  }

  log.info({ cleaned, total: expiredKeys.length }, "[session-cleanup] Cleanup complete");
  return cleaned;
}

/**
 * Start the session cleanup service.
 * @param cfg - Moltbot configuration
 */
export function startSessionCleanupService(cfg: MoltbotConfig): void {
  if (cleanupIntervalId) {
    log.debug("[session-cleanup] Service already running");
    return;
  }

  const sessionConfig = cfg.session;
  if (!sessionConfig?.ttl) {
    log.debug("[session-cleanup] No TTL configured, skipping cleanup service");
    return;
  }

  const cleanupConfig = getCleanupConfig(sessionConfig.cleanup);
  const intervalMs = cleanupConfig.intervalSeconds * 1000;

  log.info(
    { intervalSeconds: cleanupConfig.intervalSeconds },
    "[session-cleanup] Starting cleanup service",
  );

  // Run initial cleanup after a short delay
  setTimeout(() => {
    runSessionCleanup(cfg).catch((err) => {
      log.error({ err }, "[session-cleanup] Initial cleanup failed");
    });
  }, 5000);

  // Schedule periodic cleanup
  cleanupIntervalId = setInterval(() => {
    // Reload config to pick up any changes
    const currentCfg = loadConfig();
    runSessionCleanup(currentCfg).catch((err) => {
      log.error({ err }, "[session-cleanup] Periodic cleanup failed");
    });
  }, intervalMs);

  log.info("[session-cleanup] Cleanup service started");
}

/**
 * Stop the session cleanup service.
 */
export function stopSessionCleanupService(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
    log.info("[session-cleanup] Cleanup service stopped");
  }
}
