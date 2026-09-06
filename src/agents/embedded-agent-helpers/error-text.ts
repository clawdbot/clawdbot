import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import type { AssistantMessage } from "../../llm/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  extractErrorHttpStatus,
  extractLeadingHttpStatus,
  formatProviderRefusalText,
  formatRawAssistantErrorForUi,
  isGenericProviderInternalError,
  parseApiErrorInfo,
} from "../../shared/assistant-error-format.js";
import { renderAssistantRequestFailureCopy } from "../failover/assistant-request-failure-copy.js";
import {
  classifyFailoverSignal,
  isProviderCompletedErrorFinishReasonMessage,
  isReasoningConstraintErrorMessage,
  isTimeoutErrorMessage,
} from "../failover/classify.js";
import type { PreparedProviderFailoverOwner } from "../failover/provider-patterns.js";
import {
  AUTH_INVALID_TOKEN_USER_TEXT,
  formatBillingErrorMessage,
  formatDiskSpaceErrorCopy,
  formatTransportErrorCopy,
  isInvalidStreamingEventOrderError,
  isLikelyHttpErrorText,
  isRawApiErrorPayload,
  isStreamingJsonParseError,
  PROVIDER_SCHEMA_REJECTION_USER_TEXT,
  renderFormatErrorCopy,
  renderRateLimitOrOverloadedCopy,
} from "../failover/user-copy.js";
import { formatSandboxToolPolicyBlockedMessage } from "../sandbox/runtime-status.js";
import { buildAssistantFailoverSignal } from "./assistant-message-failures.js";
import { classifyProviderRuntimeFailureKind } from "./provider-runtime-failure.js";
const log = createSubsystemLogger("errors");
const sandboxToolPolicyAuditMessages = new WeakSet<AssistantMessage>();
export const GENERIC_ASSISTANT_ERROR_TEXT = "LLM request failed.";
export const SYNTHESIZED_TIMEOUT_ERROR_TEXT = "LLM request timed out.";
const MODEL_NOT_FOUND_USER_TEXT =
  "The selected model was not found by the provider. Check the model id or choose a different model.";
const RUNTIME_FAILURE_COPY: Partial<
  Record<ReturnType<typeof classifyProviderRuntimeFailureKind>, string>
> = {
  auth_refresh: "Authentication refresh failed. Re-authenticate this provider and try again.",
  refresh_contention:
    "Authentication refresh is already in progress elsewhere and this attempt timed out waiting for it. Retry in a moment.",
  refresh_timeout:
    "Authentication refresh timed out before the provider completed. Retry in a moment; re-authenticate only if it keeps failing.",
  callback_timeout:
    "Browser OAuth did not complete before manual fallback kicked in. Retry the login flow and paste the redirect URL if prompted.",
  callback_validation:
    "Browser OAuth returned an invalid or incomplete callback. Retry the login flow and make sure the full redirect URL is pasted if prompted.",
  auth_scope:
    "Authentication is missing the required OpenAI ChatGPT scopes. Re-run OpenAI login and try again.",
  auth_html:
    "Authentication failed at the provider. Re-authenticate and verify your provider credentials and account access.",
  auth_invalid_token: AUTH_INVALID_TOKEN_USER_TEXT,
  upstream_html:
    "The provider returned an HTML error page instead of an API response. This usually means a CDN or gateway (e.g. Cloudflare) blocked the request. Retry in a moment or check provider status.",
  proxy: "LLM request failed: proxy or tunnel configuration blocked the provider request.",
  tls_certificate:
    "LLM request failed: TLS certificate validation rejected the provider endpoint. Check the endpoint hostname, proxy, and local certificate trust.",
  model_not_found: MODEL_NOT_FOUND_USER_TEXT,
};
const TOOL_CALL_INPUT_MISSING_RE =
  /tool_(?:use|call)\.(?:input|arguments).*?(?:field required|required)/i;
const TOOL_CALL_INPUT_PATH_RE =
  /messages\.\d+\.content\.\d+\.tool_(?:use|call)\.(?:input|arguments)/i;
type AssistantErrorTextOptions = {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  provider?: string;
  providerOwner?: PreparedProviderFailoverOwner;
  model?: string;
  /** Credential auth mode; OAuth/token billing copy omits API-key language (#80877). */
  authMode?: string;
};
type ClassifiedAssistantErrorFacts = ReturnType<typeof classifyAssistantErrorFacts>;
function classifyAssistantErrorFacts(msg: AssistantMessage, opts?: AssistantErrorTextOptions) {
  const signal = buildAssistantFailoverSignal(msg, {
    provider: opts?.providerOwner?.id ?? opts?.provider,
  });
  // Both projections share the complete signal and explicit owner. Raw schema
  // evidence stays distinct from the full classification used for safe copy.
  const providerPlugin = opts?.providerOwner ?? null;
  const classification = classifyFailoverSignal(signal, { providerPlugin });
  return {
    provider: opts?.provider ?? msg.provider ?? opts?.providerOwner?.id,
    model: opts?.model ?? msg.model,
    reason:
      classification?.kind === "reason"
        ? classification.reason
        : classification
          ? ("context_overflow" as const)
          : null,
    status: signal.status ?? extractErrorHttpStatus(signal.message ?? "")?.code,
    providerRuntimeFailureKind: classifyProviderRuntimeFailureKind(signal, { providerPlugin }),
    storageFailure: classifyGatewayStorageFailure(msg),
  };
}
function isMissingToolCallInputError(raw: string): boolean {
  return (
    Boolean(raw) && (TOOL_CALL_INPUT_MISSING_RE.test(raw) || TOOL_CALL_INPUT_PATH_RE.test(raw))
  );
}
export function formatAssistantErrorText(
  msg: AssistantMessage,
  opts?: AssistantErrorTextOptions,
  facts?: ClassifiedAssistantErrorFacts,
): string | undefined {
  // Also format errors if errorMessage is present, even if stopReason isn't "error"
  const raw = (msg.errorMessage ?? "").trim();
  if (msg.stopReason !== "error" && !raw) {
    return undefined;
  }
  const providerRefusalText = formatProviderRefusalText(msg);
  if (providerRefusalText) {
    return providerRefusalText;
  }
  const formatCopy = renderFormatErrorCopy(raw);
  const classifiedFacts = facts ?? classifyAssistantErrorFacts(msg, opts);
  if (classifiedFacts.storageFailure) {
    return renderAssistantRequestFailureCopy(classifiedFacts);
  }
  const {
    reason: failoverReason,
    status: formatStatus,
    providerRuntimeFailureKind,
  } = classifiedFacts;
  const unknownTool =
    raw.match(/unknown tool[:\s]+["']?([a-z0-9_-]+)["']?/i) ??
    raw.match(/tool\s+["']?([a-z0-9_-]+)["']?\s+(?:not found|is not available)/i);
  if (unknownTool?.[1]) {
    const audit = !sandboxToolPolicyAuditMessages.has(msg);
    const rewritten = formatSandboxToolPolicyBlockedMessage({
      cfg: opts?.cfg,
      sessionKey: opts?.sessionKey,
      agentId: opts?.agentId,
      toolName: unknownTool[1],
      audit,
    });
    if (rewritten) {
      if (audit) {
        sandboxToolPolicyAuditMessages.add(msg);
      }
      return rewritten;
    }
  }
  const diskSpaceCopy = formatDiskSpaceErrorCopy(raw);
  if (diskSpaceCopy) {
    return diskSpaceCopy;
  }
  const runtimeCopy = RUNTIME_FAILURE_COPY[providerRuntimeFailureKind];
  if (runtimeCopy) {
    return runtimeCopy;
  }
  if (failoverReason === "billing") {
    return formatBillingErrorMessage(opts?.provider, opts?.model ?? msg.model, opts?.authMode);
  }
  const transientCopy =
    failoverReason === "rate_limit" || failoverReason === "overloaded"
      ? renderRateLimitOrOverloadedCopy({ reason: failoverReason, raw })
      : undefined;
  if (transientCopy) {
    return transientCopy;
  }

  if (
    (formatStatus === 400 || formatStatus === 422) &&
    formatCopy !== PROVIDER_SCHEMA_REJECTION_USER_TEXT
  ) {
    return formatCopy;
  }
  if (failoverReason === "context_overflow") {
    return (
      "Context overflow: prompt too large for the model. " +
      "Try /reset (or /new) to start a fresh session, or use a larger-context model."
    );
  }
  if (isReasoningConstraintErrorMessage(raw)) {
    return (
      "Reasoning is required for this model endpoint. " +
      "Use /think minimal (or any non-off level) and try again."
    );
  }

  if (isInvalidStreamingEventOrderError(raw)) {
    return "LLM request failed: provider returned an invalid streaming response. Please try again.";
  }

  // Catch role ordering errors - including JSON-wrapped and "400" prefix variants
  if (
    /incorrect role information|roles must alternate|400.*role|"message".*role.*information/i.test(
      raw,
    )
  ) {
    return (
      "Message ordering conflict - please try again. " +
      "If this persists, use /new to start a fresh session."
    );
  }

  if (isMissingToolCallInputError(raw)) {
    return (
      "Session history looks corrupted (tool call input missing). " +
      "Use /new to start a fresh session. " +
      "If this keeps happening, reset the session or delete the corrupted session transcript."
    );
  }

  if (providerRuntimeFailureKind === "replay_invalid") {
    return (
      "Session history or replay state is invalid. " +
      "Use /new to start a fresh session and try again."
    );
  }

  const apiError = parseApiErrorInfo(raw);
  if (
    providerRuntimeFailureKind === "schema" &&
    apiError?.type?.toLowerCase().includes("invalid_request") &&
    apiError.message?.trim()
  ) {
    return `LLM request rejected: ${apiError.message.trim()}`;
  }

  if (isGenericProviderInternalError(raw)) {
    return formatRawAssistantErrorForUi(raw);
  }

  const transportCopy = formatTransportErrorCopy(raw);
  if (transportCopy) {
    return transportCopy;
  }

  // Provider finished the stream with finish_reason/stop-reason `error` — not a hang.
  // Keep the raw reason in the message so operators still see the provider signal (#109218).
  if (isProviderCompletedErrorFinishReasonMessage(raw)) {
    return formatRawAssistantErrorForUi(raw);
  }

  if (isTimeoutErrorMessage(raw) && !(facts?.status !== undefined && facts.status >= 500)) {
    return SYNTHESIZED_TIMEOUT_ERROR_TEXT;
  }

  // Full assistant metadata can establish format rejection beyond the raw-text diagnostic.
  if (providerRuntimeFailureKind === "schema" || failoverReason === "format") {
    return formatCopy;
  }

  if (!raw) {
    return failoverReason
      ? renderAssistantRequestFailureCopy(classifiedFacts)
      : "LLM request failed with an unknown error.";
  }

  if (isRawApiErrorPayload(raw) || isLikelyHttpErrorText(raw)) {
    return formatRawAssistantErrorForUi(raw);
  }

  if (isStreamingJsonParseError(raw)) {
    return "LLM streaming response contained a malformed fragment. Please try again.";
  }

  // Never return raw unhandled errors - log for debugging but return safe message
  if (raw.length > 600) {
    log.warn(`Long error truncated: ${truncateUtf16Safe(raw, 200)}`);
  }
  return raw.length > 600 ? `${truncateUtf16Safe(raw, 600)}…` : raw;
}

function isRawAssistantErrorPassthrough(params: {
  friendlyError?: string;
  rawError?: string;
}): boolean {
  const friendlyError = params.friendlyError?.trim();
  const rawError = params.rawError?.trim();
  if (!friendlyError || !rawError) {
    return false;
  }
  const parsedMessage = parseApiErrorInfo(rawError)?.message?.trim();
  const leadingStatusRest = extractLeadingHttpStatus(rawError)?.rest?.trim();
  const hasRawDerivedProviderPrefix =
    friendlyError.startsWith("LLM request rejected:") ||
    friendlyError.startsWith("LLM error") ||
    friendlyError.startsWith("HTTP ");
  return (
    (friendlyError === rawError && friendlyError !== SYNTHESIZED_TIMEOUT_ERROR_TEXT) ||
    (rawError.length > 600 && friendlyError === `${truncateUtf16Safe(rawError, 600)}…`) ||
    Boolean(parsedMessage && hasRawDerivedProviderPrefix) ||
    Boolean(leadingStatusRest && friendlyError.startsWith("HTTP "))
  );
}

export function formatUserFacingAssistantErrorText(
  msg: AssistantMessage,
  opts?: AssistantErrorTextOptions,
): string {
  const rawError = msg.errorMessage?.trim();
  const facts = classifyAssistantErrorFacts(msg, opts);
  const friendlyError = formatAssistantErrorText(msg, opts, facts);
  const rawPassthrough = isRawAssistantErrorPassthrough({ friendlyError, rawError });
  const structuredSchemaDetail = [
    parseApiErrorInfo(rawError ?? ""),
    parseApiErrorInfo(typeof msg.errorBody === "string" ? msg.errorBody.trim() : ""),
  ].find((error) => error?.type?.toLowerCase().includes("invalid_request"))?.message;
  const schemaFriendlyError =
    friendlyError === PROVIDER_SCHEMA_REJECTION_USER_TEXT ||
    friendlyError?.startsWith("LLM request rejected:");
  const safeFriendlyError =
    structuredSchemaDetail && schemaFriendlyError
      ? renderFormatErrorCopy(structuredSchemaDetail)
      : rawPassthrough
        ? schemaFriendlyError
          ? PROVIDER_SCHEMA_REJECTION_USER_TEXT
          : undefined
        : friendlyError;
  if (safeFriendlyError) {
    return safeFriendlyError.trim();
  }
  return renderAssistantRequestFailureCopy(facts) ?? GENERIC_ASSISTANT_ERROR_TEXT;
}
