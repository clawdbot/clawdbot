/**
 * Shared auth-profile constants.
 * Defines store versions, built-in CLI profile ids, lock budgets, refresh
 * timing, and logging used by auth profile runtime modules.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";

/** Current persisted auth profile store schema version. */
export const AUTH_STORE_VERSION = 1;

export {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
  MINIMAX_CLI_PROFILE_ID,
} from "./profile-ids.js";

// Invariant: OAUTH_REFRESH_CALL_TIMEOUT_MS < OAUTH_REFRESH_LOCK_OPTIONS.stale
// so a legitimate refresh's critical section always finishes well before
// peers would treat the lock as reclaimable. Violating this invariant re-
// introduces the `refresh_token_reused` race the lock is meant to prevent.
//
// Retry budget note: keep the MINIMUM cumulative retry window comfortably
// above OAUTH_REFRESH_CALL_TIMEOUT_MS so waiters do not give up while a
// legitimate slow refresh is still within its allowed runtime budget.
/** Cross-agent lock policy for shared OAuth refresh operations. */
export const OAUTH_REFRESH_LOCK_OPTIONS = {
  retries: {
    retries: 20,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 180_000,
} as const;

// Hard upper bound on a single OAuth refresh call (plugin hook + HTTP
// token-exchange). Any refresh that runs longer than this is aborted and
// surfaced as a refresh failure. Keep strictly below
// OAUTH_REFRESH_LOCK_OPTIONS.stale so the lock is never treated as stale
// by a waiter while the owner is still doing legitimate work.
/** Maximum duration for one OAuth refresh call inside the refresh lock. */
export const OAUTH_REFRESH_CALL_TIMEOUT_MS = 120_000;

/** Freshness window for syncing external CLI auth into auth profiles. */
export const EXTERNAL_CLI_SYNC_TTL_MS = 15 * 60 * 1000;

/** Auth profile subsystem logger. */
export const authProfilesLog = createSubsystemLogger("agents/auth-profiles");
