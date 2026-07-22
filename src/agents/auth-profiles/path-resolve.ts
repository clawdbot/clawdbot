/**
 * Auth profile path resolution.
 * Centralizes JSON store paths, display paths, legacy store paths, auth-state
 * paths, and cross-agent OAuth refresh lock paths.
 */
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { resolveUserPath } from "../../utils.js";
import {
  AUTH_PROFILE_FILENAME,
  AUTH_STATE_FILENAME,
  LEGACY_AUTH_FILENAME,
} from "./path-constants.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";

function resolveAuthAgentDir(agentDir?: string): string {
  if (agentDir) {
    return resolveUserPath(agentDir);
  }
  // The no-argument auth-store API names the shipped shared main store, not a
  // configured-agent fallback. Roster-aware callers pass their resolved dir.
  return path.join(resolveStateDir(), "agents", "main", "agent");
}

/** Resolve the persisted auth profile store path for an agent dir. */
export function resolveAuthStorePath(agentDir?: string): string {
  return path.join(resolveAuthAgentDir(agentDir), AUTH_PROFILE_FILENAME);
}

/** Resolve the legacy auth store path used by migration code. */
export function resolveLegacyAuthStorePath(agentDir?: string): string {
  return path.join(resolveAuthAgentDir(agentDir), LEGACY_AUTH_FILENAME);
}

/** Resolve the auth-state sidecar path for usage/cooldown metadata. */
export function resolveAuthStatePath(agentDir?: string): string {
  return path.join(resolveAuthAgentDir(agentDir), AUTH_STATE_FILENAME);
}

/** Resolve the user-facing auth profile database path. */
export function resolveAuthStorePathForDisplay(agentDir?: string): string {
  const pathname = resolveAuthProfileDatabasePath(agentDir);
  return pathname.startsWith("~") ? pathname : resolveUserPath(pathname);
}

/** Resolve the user-facing auth state database path. */
export function resolveAuthStatePathForDisplay(agentDir?: string): string {
  const pathname = resolveAuthProfileDatabasePath(agentDir);
  return pathname.startsWith("~") ? pathname : resolveUserPath(pathname);
}

/**
 * Resolve the path of the cross-agent, per-profile OAuth refresh coordination
 * lock. The filename digests a JSON tuple of `[provider, profileId]` so it is
 * filesystem-safe for arbitrary unicode/control-character inputs and always
 * bounded in length. Tuple encoding makes it impossible to collide two distinct
 * `(provider, profileId)` pairs by separator-sensitive string concatenation.
 *
 * This lock is the serialization point that prevents the `refresh_token_reused`
 * storm when N agents share one OAuth profile (see issue #26322): every agent
 * that attempts a refresh acquires this same file lock, so only one HTTP
 * refresh is in-flight at a time and peers can adopt the resulting fresh
 * credentials instead of racing against a single-use refresh token.
 *
 * The key intentionally includes `provider` so that two profiles that
 * happen to share a `profileId` across providers (operator-renamed profile,
 * test fixture, etc.) do not needlessly serialize against each other.
 */
export function resolveOAuthRefreshLockPath(provider: string, profileId: string): string {
  const lockKey = JSON.stringify([provider, profileId]);
  const safeId = `lock-${oauthLockPathDigest(lockKey)}`;
  return path.join(resolveStateDir(), "locks", "oauth-refresh", safeId);
}

function oauthLockPathDigest(value: string): string {
  let left = 0xcbf29ce484222325n;
  let right = 0x9ae16a3b2f90404fn;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  // This is not a credential hash. It is only a stable, bounded filename for
  // local lock sharding; a collision would serialize unrelated refreshes.
  for (const byte of Buffer.from(value, "utf8")) {
    const octet = BigInt(byte);
    left = ((left ^ octet) * prime) & mask;
    right = ((right ^ (octet + 0x9e3779b97f4a7c15n)) * prime) & mask;
  }

  return `${left.toString(16).padStart(16, "0")}${right.toString(16).padStart(16, "0")}`;
}
