/** Closed compaction-failure construction and policy helpers. */
import type {
  CompactionFailure,
  FallbackCompactionFailureReason,
  RetryableCompactionFailureReason,
  TerminalCompactionFailureReason,
} from "../../context-engine/types.js";
import type { FailoverReason } from "../embedded-agent-helpers/types.js";

const RETRYABLE_REASONS = new Set<RetryableCompactionFailureReason>([
  "empty_response",
  "overloaded",
  "rate_limit",
  "server_error",
  "timeout",
]);

const FALLBACK_REASONS = new Set<FallbackCompactionFailureReason>([
  "missing_thread_binding",
  "stale_thread_binding",
]);

const TERMINAL_FAILOVER_REASONS = new Set<TerminalCompactionFailureReason>([
  "auth",
  "auth_permanent",
  "billing",
  "context_overflow",
  "format",
  "model_not_found",
  "no_error_details",
  "session_expired",
  "tls_certificate",
  "unclassified",
  "unknown",
]);

const TERMINAL_COMPACTION_REASONS = new Set<TerminalCompactionFailureReason>([
  ...TERMINAL_FAILOVER_REASONS,
  "aborted",
  "active_run",
  "auth_profile_mismatch",
  "background_compaction_pending",
  "deferred_compaction_not_scheduled",
  "invalid_request",
  "model_selection_locked",
  "runtime_unavailable",
  "summary_rejected",
  "transcript_persistence_failed",
  "unsupported_harness_compaction",
]);

const COMPACTION_FAILURE_KEYS = new Set(["disposition", "reason", "status"]);

function normalizeStatus(status: unknown): number | undefined {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

export function isStructuredCompactionFailure(value: unknown): value is CompactionFailure {
  if (!value || typeof value !== "object") {
    return false;
  }
  let ownKeys: (string | symbol)[];
  let descriptors: PropertyDescriptorMap;
  try {
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return false;
  }
  if (
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        !COMPACTION_FAILURE_KEYS.has(key) ||
        descriptors[key]?.enumerable !== true ||
        !("value" in descriptors[key]),
    )
  ) {
    return false;
  }
  const disposition = descriptors.disposition?.value;
  const reason = descriptors.reason?.value;
  const status = descriptors.status?.value;
  if (!descriptors.disposition || !descriptors.reason) {
    return false;
  }
  if (descriptors.status && normalizeStatus(status) === undefined) {
    return false;
  }
  if (disposition === "retryable") {
    return (
      typeof reason === "string" &&
      RETRYABLE_REASONS.has(reason as RetryableCompactionFailureReason)
    );
  }
  if (disposition === "fallback") {
    return (
      typeof reason === "string" && FALLBACK_REASONS.has(reason as FallbackCompactionFailureReason)
    );
  }
  return (
    disposition === "terminal" &&
    typeof reason === "string" &&
    TERMINAL_COMPACTION_REASONS.has(reason as TerminalCompactionFailureReason)
  );
}

function retryableCompactionFailure(
  reason: RetryableCompactionFailureReason,
  status?: unknown,
): CompactionFailure {
  const normalizedStatus = normalizeStatus(status);
  return {
    disposition: "retryable",
    reason,
    ...(normalizedStatus === undefined ? {} : { status: normalizedStatus }),
  };
}

export function fallbackCompactionFailure(
  reason: FallbackCompactionFailureReason,
  status?: unknown,
): CompactionFailure {
  const normalizedStatus = normalizeStatus(status);
  return {
    disposition: "fallback",
    reason,
    ...(normalizedStatus === undefined ? {} : { status: normalizedStatus }),
  };
}

export function terminalCompactionFailure(
  reason: TerminalCompactionFailureReason,
  status?: unknown,
): CompactionFailure {
  const normalizedStatus = normalizeStatus(status);
  return {
    disposition: "terminal",
    reason,
    ...(normalizedStatus === undefined ? {} : { status: normalizedStatus }),
  };
}

export function compactionFailureFromFailoverReason(
  reason: FailoverReason | undefined,
  status?: unknown,
): CompactionFailure {
  if (reason && RETRYABLE_REASONS.has(reason as RetryableCompactionFailureReason)) {
    return retryableCompactionFailure(reason as RetryableCompactionFailureReason, status);
  }
  if (reason && TERMINAL_FAILOVER_REASONS.has(reason as TerminalCompactionFailureReason)) {
    return terminalCompactionFailure(reason as TerminalCompactionFailureReason, status);
  }
  return terminalCompactionFailure("unknown", status);
}

export function failoverReasonFromCompactionFailure(failure: CompactionFailure): FailoverReason {
  return RETRYABLE_REASONS.has(failure.reason as RetryableCompactionFailureReason) ||
    TERMINAL_FAILOVER_REASONS.has(failure.reason as TerminalCompactionFailureReason)
    ? (failure.reason as FailoverReason)
    : "unknown";
}
