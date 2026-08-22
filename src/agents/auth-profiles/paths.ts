/**
 * Public path barrel for auth-profile stores.
 * Import through this file for canonical SQLite display and lock paths.
 */
import { resolveUserPath } from "../../utils.js";
import { resolveOAuthRefreshLockPath, resolveSharedAuthStorePath } from "./path-resolve.js";
import { inspectPersistedAuthProfileStoreRaw, resolveAuthProfileDatabasePath } from "./sqlite.js";

export { resolveOAuthRefreshLockPath };

/** Resolve the user-facing path for the database selected by the auth store loader. */
export function resolveAuthStorePathForDisplay(agentDir?: string): string {
  const pathname =
    agentDir && inspectPersistedAuthProfileStoreRaw(agentDir).status !== "missing"
      ? resolveAuthProfileDatabasePath(agentDir)
      : resolveSharedAuthStorePath();
  return pathname.startsWith("~") ? pathname : resolveUserPath(pathname);
}

/** Retained name for callers that present auth runtime state from the same selected store. */
export function resolveAuthStatePathForDisplay(agentDir?: string): string {
  return resolveAuthStorePathForDisplay(agentDir);
}
