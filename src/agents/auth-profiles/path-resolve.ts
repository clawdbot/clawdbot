/**
 * Auth profile path resolution.
 * Centralizes canonical shared SQLite and cross-agent OAuth refresh lock paths.
 */
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveStateDir } from "../../config/paths.js";
import { readConfigMachineState } from "../../state/config-machine-state.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";

export const SHARED_AUTH_STORE_STATE_KEY = "auth.sharedStore";
const SHARED_AUTH_STORE_OWNERSHIP_CACHE_LIMIT = 256;

export type SharedAuthStoreOwnership = { location: "legacy-main" } | { location: "state-db" };

/** Pure producer facts; capturing a supplied runtime snapshot must not open SQLite. */
export type AuthProfileOwnerScope = { stateDir: string; sharedMainDir: string };

export function captureAuthProfileOwnerScope(
  env: NodeJS.ProcessEnv = process.env,
): AuthProfileOwnerScope {
  return {
    stateDir: path.resolve(resolveStateDir(env)),
    sharedMainDir: path.resolve(resolveSharedMainAuthAgentDir(env)),
  };
}

// Explicit env callers can address another state root in the same process.
// Pin each root once so later row changes require an owner-controlled restart.
const sharedAuthStoreOwnershipByDatabasePath = new Map<string, SharedAuthStoreOwnership>();

class InvalidSharedAuthStoreOwnershipError extends Error {
  readonly code = "INVALID_SHARED_AUTH_STORE_OWNERSHIP" as const;
  readonly action = "openclaw doctor --fix" as const;
  readonly stateKey = SHARED_AUTH_STORE_STATE_KEY;

  constructor(value: unknown) {
    super(
      `Config machine state ${SHARED_AUTH_STORE_STATE_KEY} has an invalid shared auth store location (${JSON.stringify(value)}); run openclaw doctor --fix.`,
    );
    this.name = "InvalidSharedAuthStoreOwnershipError";
  }
}

function parseSharedAuthStoreOwnership(value: unknown): SharedAuthStoreOwnership {
  if (value === undefined) {
    return { location: "legacy-main" };
  }
  if (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    (value.location === "legacy-main" || value.location === "state-db")
  ) {
    return { location: value.location };
  }
  throw new InvalidSharedAuthStoreOwnershipError(value);
}

/** Resolve the process-stable owner of the shared auth store. */
export function resolveSharedAuthStoreOwnership(
  env: NodeJS.ProcessEnv = process.env,
): SharedAuthStoreOwnership {
  const databasePath = path.resolve(resolveOpenClawStateSqlitePath(env));
  const cached = sharedAuthStoreOwnershipByDatabasePath.get(databasePath);
  if (cached) {
    return cached;
  }
  if (sharedAuthStoreOwnershipByDatabasePath.size >= SHARED_AUTH_STORE_OWNERSHIP_CACHE_LIMIT) {
    throw new Error(
      "Shared auth store ownership cache exceeded its process root limit; restart OpenClaw.",
    );
  }
  const ownership = parseSharedAuthStoreOwnership(
    readConfigMachineState<unknown>(SHARED_AUTH_STORE_STATE_KEY, { env, path: databasePath }),
  );
  sharedAuthStoreOwnershipByDatabasePath.set(databasePath, ownership);
  return ownership;
}

/** Inspect copied state without pinning a runtime owner or changing SQLite artifacts. */
export function inspectSharedAuthStoreOwnership(
  env: NodeJS.ProcessEnv = process.env,
): SharedAuthStoreOwnership {
  return parseSharedAuthStoreOwnership(
    readConfigMachineState<unknown>(
      SHARED_AUTH_STORE_STATE_KEY,
      { env },
      { artifactPreservingReadOnly: true },
    ),
  );
}

/** Update the process-stable cache after this process commits the ownership row. */
export function noteCommittedSharedAuthStoreOwnership(
  ownership: SharedAuthStoreOwnership,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const databasePath = path.resolve(resolveOpenClawStateSqlitePath(env));
  sharedAuthStoreOwnershipByDatabasePath.set(databasePath, ownership);
}

/** Reload shared auth ownership after an explicit out-of-process auth mutation. */
export function reloadSharedAuthStoreOwnership(
  env: NodeJS.ProcessEnv = process.env,
): SharedAuthStoreOwnership {
  const databasePath = path.resolve(resolveOpenClawStateSqlitePath(env));
  const ownership = parseSharedAuthStoreOwnership(
    readConfigMachineState<unknown>(SHARED_AUTH_STORE_STATE_KEY, { env, path: databasePath }),
  );
  sharedAuthStoreOwnershipByDatabasePath.set(databasePath, ownership);
  return ownership;
}

/** Resolve the canonical shared auth database path. */
export function resolveSharedAuthStorePath(env: NodeJS.ProcessEnv = process.env): string {
  if (resolveSharedAuthStoreOwnership(env).location === "state-db") {
    return resolveOpenClawStateSqlitePath(env);
  }
  return path.join(resolveSharedMainAuthAgentDir(env), "openclaw-agent.sqlite");
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
