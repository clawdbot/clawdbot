import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { FailoverSignal } from "./signal.js";

export type ProviderRequestFacet =
  | "quota-429"
  | "conversation-state"
  | "provider-internal"
  | "provider-internal-503";

/** Classify copy-sensitive provider-request facts that are finer than FailoverReason. */
export function classifyProviderRequestFacets(signal: FailoverSignal): ProviderRequestFacet | null {
  const message = signal.message ?? "";
  const lower = normalizeLowercaseStringOrEmpty(message);
  const genericProviderError =
    lower.includes("an error occurred while processing your request") ||
    lower.includes("something went wrong while processing your request");
  const providerInternal503 =
    signal.status === 503 ||
    /\b(?:(?:unexpected\s+status|http)\s*503|503\s+service unavailable)\b|["'](?:status|code)["']\s*:\s*503\b/iu.test(
      message,
    );
  // Preserves provider quota/billing guidance for generic HTTP 429 failures.
  if (
    genericProviderError &&
    (signal.status === 429 ||
      /\b(?:http\s*)?429\b|["'](?:status|code)["']\s*:\s*429\b/iu.test(message))
  ) {
    return "quota-429";
  }
  // Preserves /new guidance for provider-rejected conversation state.
  if (isProviderConversationStateError(lower)) {
    return "conversation-state";
  }
  // Preserves the one safe HTTP retry and provider-internal copy for raw 503 failures.
  if (providerInternal503) {
    return "provider-internal-503";
  }
  return lower.includes("the ai service returned an internal error") ||
    lower.includes("provider returned an internal error") ||
    (genericProviderError && (lower.includes("server_error") || lower.includes("internal error")))
    ? "provider-internal"
    : null;
}

function isProviderConversationStateError(lower: string): boolean {
  return (
    (lower.includes("custom tool call output is missing") && lower.includes("call id")) ||
    (lower.includes("toolresult") &&
      lower.includes("tooluse") &&
      lower.includes("exceeds the number") &&
      lower.includes("previous turn")) ||
    (lower.includes("tool_use") && lower.includes("tool_result") && lower.includes("without")) ||
    lower.includes("function call turn comes immediately after") ||
    lower.includes("incorrect role information") ||
    lower.includes("roles must alternate") ||
    lower.includes("invalid_replay_transcript")
  );
}
