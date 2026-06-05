/**
 * Resolves why an auth profile failed during provider auth selection.
 */
import type { AuthProfileFailureReason } from "../../auth-profiles/types.js";
import type { FailoverReason } from "../../embedded-agent-helpers/types.js";
import type { AuthProfileFailurePolicy } from "./auth-profile-failure-policy.types.js";

/**
 * Returns the subset of failover reasons that should affect shared auth-profile
 * health. Local helper failures and request-shape/transport outcomes stay
 * session-local so one bad transcript or connection does not cool down an
 * otherwise healthy provider profile.
 */
export function resolveAuthProfileFailureReason(params: {
  failoverReason: FailoverReason | null;
  providerStarted?: boolean;
  policy?: AuthProfileFailurePolicy;
}): AuthProfileFailureReason | null {
  // Helper-local runs, transport/server failures, empty responses, and request-shape ("format") rejections
  // should not poison shared provider auth health. A `format` failure means the
  // provider rejected the request payload (e.g. an assistant-prefill 400 from a
  // strict provider when a session transcript ends with a stream-error placeholder
  // turn) — that is a per-session transcript-shape problem, not a profile-wide
  // reliability signal. Cascading it to a profile cooldown blocks every other
  // healthy session sharing the same auth profile and, when all profiles share
  // the same fault, takes down the entire provider for the configured backoff
  // window (#77228).
  if (
    params.policy === "local" ||
    !params.failoverReason ||
    params.failoverReason === "server_error" ||
    params.failoverReason === "empty_response" ||
    params.failoverReason === "format"
  ) {
    return null;
  }
  if (params.failoverReason === "timeout" && params.providerStarted !== true) {
    return null;
  }
  return params.failoverReason;
}
