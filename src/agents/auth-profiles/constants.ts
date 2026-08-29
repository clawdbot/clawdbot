/**
 * Shared auth-profile constants.
 * Defines store versions, built-in CLI profile ids, lock budgets, refresh
 * timing, and logging used by auth profile runtime modules.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";

/** Current persisted auth profile store schema version. */
export const AUTH_STORE_VERSION = 1;

/** @deprecated Anthropic provider-owned CLI profile id; do not use from third-party plugins. */
export const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";
/** @deprecated OpenAI provider-owned CLI profile id; do not use from third-party plugins. */
export const CODEX_CLI_PROFILE_ID = "openai:codex-cli";
/** Default OpenAI/Codex OAuth profile id used for migrated stores. */
export const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai:default";
/** @deprecated MiniMax provider-owned CLI profile id; do not use from third-party plugins. */
export const MINIMAX_CLI_PROFILE_ID = "minimax-portal:minimax-cli";

// Retry budget note: keep the MINIMUM cumulative retry window comfortably
// above OAUTH_REFRESH_OWNERSHIP_TIMEOUT_MS (the full queue/lock owner ceiling,
// which is wider than the network-call timeout) so the caller deadline fires
// before a waiter surfaces refresh_contention. With retries=22 the jitter-free floor is
// 162.7s (12.7s over the 150s caller deadline): 100+200+...+6400 (attempts
// 0-6) + 15*10_000 (capped attempts 7-21).
/** Cross-agent lock policy for shared OAuth refresh operations. */
export const OAUTH_REFRESH_LOCK_OPTIONS = {
  retries: {
    retries: 22,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 180_000,
} as const;

// Caller deadline for one OAuth refresh call (plugin hook + HTTP exchange).
// Provider hooks have no shared cancellation contract, so expiry abandons the
// caller while the file-lock owner retains the lock until the call settles.
/** Maximum caller wait for one OAuth refresh call inside the refresh lock. */
export const OAUTH_REFRESH_CALL_TIMEOUT_MS = 120_000;

// Hard upper bound on queue admission plus the held-lock critical section.
// Expiry releases a waiting caller before admission; an admitted owner keeps
// the lock until uncancellable work settles so no peer reuses a rotating token.
// Sits between the call timeout and the stale metadata window; live-PID locks
// are never reclaimed from age alone.
// Invariant: OAUTH_REFRESH_CALL_TIMEOUT_MS < OAUTH_REFRESH_OWNERSHIP_TIMEOUT_MS < OAUTH_REFRESH_LOCK_OPTIONS.stale.
/** Maximum caller wait across queue admission and OAuth refresh ownership. */
export const OAUTH_REFRESH_OWNERSHIP_TIMEOUT_MS = 150_000;

/** Freshness window for syncing external CLI auth into auth profiles. */
export const EXTERNAL_CLI_SYNC_TTL_MS = 15 * 60 * 1000;

/** Auth profile subsystem logger. */
export const authProfilesLog = createSubsystemLogger("agents/auth-profiles");
