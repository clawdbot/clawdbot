/**
 * Session TTL (Time-To-Live) utilities for automatic session cleanup.
 * @module session-ttl
 * @see https://github.com/moltbot/moltbot/issues/3250
 */

import type { SessionEntry } from "../config/sessions.js";
import type { SessionTtlConfig, SessionCleanupConfig } from "../config/types.base.js";

/** Default cleanup interval in seconds (5 minutes). */
export const DEFAULT_CLEANUP_INTERVAL_SECONDS = 300;

/**
 * Normalize TTL config from number or object form to object form.
 * @param ttl - TTL config (number for idle seconds, or object with idle/maxAge)
 * @returns Normalized TTL config object, or undefined if no TTL configured
 */
export function normalizeSessionTtl(
  ttl: number | SessionTtlConfig | undefined,
): SessionTtlConfig | undefined {
  if (ttl === undefined) return undefined;
  if (typeof ttl === "number") {
    return { idle: ttl };
  }
  // Validate at least one TTL option is set
  if (ttl.idle === undefined && ttl.maxAge === undefined) {
    return undefined;
  }
  return ttl;
}

/**
 * Check if a session is expired based on TTL configuration.
 * @param entry - Session entry to check
 * @param ttl - TTL configuration
 * @param now - Current timestamp in ms (default: Date.now())
 * @returns true if session is expired
 */
export function isSessionExpired(
  entry: SessionEntry,
  ttl: SessionTtlConfig,
  now: number = Date.now(),
): boolean {
  const updatedAt = entry.updatedAt;
  const createdAt = entry.createdAt;

  // Check idle timeout
  if (ttl.idle !== undefined && updatedAt) {
    const idleMs = ttl.idle * 1000;
    if (now - updatedAt > idleMs) {
      return true;
    }
  }

  // Check max age
  if (ttl.maxAge !== undefined && createdAt) {
    const maxAgeMs = ttl.maxAge * 1000;
    if (now - createdAt > maxAgeMs) {
      return true;
    }
  }

  return false;
}

/**
 * Get list of session keys that are expired.
 * @param store - Session store (key -> entry map)
 * @param ttl - TTL configuration
 * @param now - Current timestamp in ms (default: Date.now())
 * @returns Array of expired session keys
 */
export function getExpiredSessionKeys(
  store: Record<string, SessionEntry>,
  ttl: SessionTtlConfig,
  now: number = Date.now(),
): string[] {
  const expired: string[] = [];

  for (const [key, entry] of Object.entries(store)) {
    if (isSessionExpired(entry, ttl, now)) {
      expired.push(key);
    }
  }

  return expired;
}

/**
 * Get cleanup configuration with defaults.
 * @param config - Cleanup config from user
 * @returns Cleanup config with defaults applied
 */
export function getCleanupConfig(config?: SessionCleanupConfig): Required<SessionCleanupConfig> {
  return {
    intervalSeconds: config?.intervalSeconds ?? DEFAULT_CLEANUP_INTERVAL_SECONDS,
  };
}
