/** Persisted and wire-visible failover reason codes. Spellings are frozen. */
// Retry accounting owners: per-attempt LLM retry — src/llm/utils/retry.ts.
// Per-run attempt/profile/model rotation — embedded-agent-runner/run/retry-budget.ts.
// Cross-run process probe throttle — model-fallback-cooldown.ts.
// Persisted auth-profile cooldowns — auth-profiles/usage.ts.
export const FAILOVER_REASONS = [
  "auth",
  "auth_permanent",
  "format",
  "rate_limit",
  "overloaded",
  "billing",
  "server_error",
  "timeout",
  "tls_certificate",
  "context_overflow",
  "model_not_found",
  "session_expired",
  "empty_response",
  "no_error_details",
  "unclassified",
  "unknown",
] as const;
export type FailoverReason = (typeof FAILOVER_REASONS)[number];
export type FailoverSignal = {
  status?: number;
  code?: string;
  errorType?: string;
  message?: string;
  provider?: string;
  details?: readonly string[];
};
export type FailoverClassification =
  | {
      kind: "reason";
      reason: FailoverReason;
    }
  | {
      kind: "context_overflow";
    };
