import type { GatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import type { FailoverReason } from "./signal.js";

type AssistantRequestFailureCopyFacts = {
  provider?: string;
  model?: string;
  reason?: FailoverReason | null;
  status?: number;
  storageFailure?: GatewayStorageFailure;
  code?: string;
};

const STORAGE_FAILURE_COPY: Record<GatewayStorageFailure, string> = {
  SQLITE_BUSY:
    "the Gateway state database was busy (SQLite: database is locked). Retry; if it repeats, check Gateway storage health.",
  SQLITE_LOCKED:
    "the Gateway state database was locked (SQLite: database table is locked). Retry; if it repeats, check Gateway storage health.",
  SQLITE_FULL:
    "the Gateway state database was full (SQLite: database or disk is full). Free disk space on the Gateway host and retry.",
  SQLITE_READONLY:
    "the Gateway state database was read-only (SQLite: attempt to write a readonly database). Check Gateway storage permissions and retry.",
  SQLITE_IOERR:
    "the Gateway state database had an I/O error (SQLite: disk I/O error). Check Gateway storage health and filesystem access before retrying.",
  transcript_writer_fenced:
    "the transcript writer no longer owned this session. Retry in the current session; if it repeats, check Gateway logs.",
};

const ASSISTANT_REQUEST_FAILURE_REASON = {
  auth: "authentication failed",
  auth_permanent: "authentication was rejected",
  format: "request format rejected",
  rate_limit: "rate limited",
  overloaded: "provider overloaded",
  billing: "provider billing issue",
  server_error: "provider internal error",
  timeout: "request timed out",
  tls_certificate: "TLS certificate error",
  context_overflow: "context limit exceeded",
  model_not_found: "model not found",
  session_expired: "provider session expired",
  empty_response: "",
  no_error_details: "",
  unclassified: "",
  unknown: "",
} satisfies Record<FailoverReason, string>;

/** Render classified facts without exposing raw provider response text. */
export function renderAssistantRequestFailureCopy(
  facts: AssistantRequestFailureCopyFacts,
): string | undefined {
  if (facts.storageFailure) {
    return `⚠️ Agent run failed: ${STORAGE_FAILURE_COPY[facts.storageFailure]}`;
  }
  if (facts.code === "incomplete_tool_call") {
    return "⚠️ The provider returned an unfinished tool call. Earlier actions may have completed; verify their results before continuing.";
  }
  const provider = facts.provider?.trim();
  const model = facts.model?.trim();
  const target = provider && model ? `${provider}/${model}` : provider || model;
  const normalizedReason =
    facts.reason === "timeout" && typeof facts.status === "number" && facts.status >= 500
      ? "server_error"
      : facts.reason;
  const reason = normalizedReason ? ASSISTANT_REQUEST_FAILURE_REASON[normalizedReason] : undefined;
  const httpStatus = facts.status;
  const status =
    typeof httpStatus === "number" &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 100 &&
    httpStatus <= 599
      ? `HTTP ${httpStatus}`
      : undefined;
  // A recognized provider terminal can have no displayable reason.
  const unclassified =
    !facts.reason || facts.reason === "unclassified" || facts.reason === "unknown";
  if (!reason && !status && (!target || unclassified)) {
    return target ? `⚠️ Agent run failed (${model ? "model" : "provider"}: ${target}).` : undefined;
  }
  const details = [reason, status].filter(Boolean);
  const summary = `⚠️ ${target ? `${target} request failed` : "LLM request failed"}${details.length > 0 ? ` (${details.join(", ")})` : ""}.`;
  if (
    normalizedReason === "overloaded" ||
    normalizedReason === "server_error" ||
    normalizedReason === "timeout" ||
    normalizedReason === "rate_limit"
  ) {
    return `${summary} This is usually temporary — try again shortly.`;
  }
  if (facts.reason === "auth" || facts.reason === "auth_permanent") {
    return `${summary} Re-authenticate the provider and try again.`;
  }
  if (facts.reason === "billing") {
    return `${summary} Check ${provider ? `${provider} billing` : "provider billing"} and try again.`;
  }
  return summary;
}
