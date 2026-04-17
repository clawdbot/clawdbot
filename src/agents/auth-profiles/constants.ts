import { createSubsystemLogger } from "../../logging/subsystem.js";
export {
  AUTH_PROFILE_FILENAME,
  AUTH_STATE_FILENAME,
  LEGACY_AUTH_FILENAME,
} from "./path-constants.js";

export const AUTH_STORE_VERSION = 1;

export const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";
export const CODEX_CLI_PROFILE_ID = "openai-codex:codex-cli";
export const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai-codex:default";
export const MINIMAX_CLI_PROFILE_ID = "minimax-portal:minimax-cli";

export const AUTH_STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

// Separate from AUTH_STORE_LOCK_OPTIONS for independent tuning: this lock
// serializes the cross-agent OAuth refresh (see issue #26322), whereas
// AUTH_STORE_LOCK_OPTIONS guards per-store file writes. Keeping them
// distinct lets us widen the refresh lock's timeout/retry budget without
// affecting the hot-path auth-store writers.
//
// Invariant: OAUTH_REFRESH_CALL_TIMEOUT_MS < OAUTH_REFRESH_LOCK_OPTIONS.stale
// so a legitimate refresh's critical section always finishes well before
// peers would treat the lock as reclaimable. Violating this invariant re-
// introduces the `refresh_token_reused` race the lock is meant to prevent.
export const OAUTH_REFRESH_LOCK_OPTIONS = {
  retries: {
    retries: 10,
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
export const OAUTH_REFRESH_CALL_TIMEOUT_MS = 120_000;

export const EXTERNAL_CLI_SYNC_TTL_MS = 15 * 60 * 1000;
export const EXTERNAL_CLI_NEAR_EXPIRY_MS = 10 * 60 * 1000;

export const log = createSubsystemLogger("agents/auth-profiles");
