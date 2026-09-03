import type { FailoverReason } from "./signal.js";

type AssistantRequestFailureCopyFacts = {
  provider?: string;
  model?: string;
  reason?: FailoverReason | null;
  status?: number;
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
  if (!target && !reason && !status) {
    return undefined;
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
