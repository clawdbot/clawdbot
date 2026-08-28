import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AssistantMessage } from "../../llm/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  extractLeadingHttpStatus,
  extractProviderWrappedHttpStatus,
  formatRawAssistantErrorForUi,
  isGenericProviderInternalError,
  parseApiErrorInfo,
} from "../../shared/assistant-error-format.js";
import {
  classifyFailoverReason,
  isBilling429MessageForProvider,
  isBillingErrorMessage,
  isContextOverflowError,
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
const TOOL_CALL_INPUT_MISSING_RE =
  /tool_(?:use|call)\.(?:input|arguments).*?(?:field required|required)/i;
const TOOL_CALL_INPUT_PATH_RE =
  /messages\.\d+\.content\.\d+\.tool_(?:use|call)\.(?:input|arguments)/i;
type AssistantErrorTextOptions = {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  provider?: string;
  providerOwner?: PreparedProviderFailoverOwner;
  model?: string;
  /** Credential auth mode; OAuth/token billing copy omits API-key language (#80877). */
  authMode?: string;
};
function isMissingToolCallInputError(raw: string): boolean {
  return (
    Boolean(raw) && (TOOL_CALL_INPUT_MISSING_RE.test(raw) || TOOL_CALL_INPUT_PATH_RE.test(raw))
  );
}
export function formatAssistantErrorText(
  msg: AssistantMessage,
  opts?: AssistantErrorTextOptions,
): string | undefined {
  // Also format errors if errorMessage is present, even if stopReason isn't "error"
  const raw = (msg.errorMessage ?? "").trim();
  if (msg.stopReason !== "error" && !raw) {
    return undefined;
  }
  if (!raw) {
    return "LLM request failed with an unknown error.";
  }
  const providerOwner = opts?.providerOwner?.id ?? opts?.provider;
  const providerRuntimeFailureKind = classifyProviderRuntimeFailureKind({
    ...buildAssistantFailoverSignal(msg, { provider: providerOwner }),
    message: raw,
  });
  const wrappedFormatCopy = extractProviderWrappedHttpStatus(raw)
    ? renderFormatErrorCopy(raw)
    : undefined;
  if (wrappedFormatCopy?.startsWith("LLM request rejected:")) {
    return wrappedFormatCopy;
  }
  const unknownTool =
    raw.match(/unknown tool[:\s]+["']?([a-z0-9_-]+)["']?/i) ??
    raw.match(/tool\s+["']?([a-z0-9_-]+)["']?\s+(?:not found|is not available)/i);
  if (unknownTool?.[1]) {
    const audit = !sandboxToolPolicyAuditMessages.has(msg);
    const rewritten = formatSandboxToolPolicyBlockedMessage({
      cfg: opts?.cfg,
      sessionKey: opts?.sessionKey,
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
  if (providerRuntimeFailureKind === "auth_refresh") {
    return "Authentication refresh failed. Re-authenticate this provider and try again.";
  }
  if (providerRuntimeFailureKind === "refresh_contention") {
    return (
      "Authentication refresh is already in progress elsewhere and this attempt " +
      "timed out waiting for it. Retry in a moment."
    );
  }
  if (providerRuntimeFailureKind === "refresh_timeout") {
    return (
      "Authentication refresh timed out before the provider completed. " +
      "Retry in a moment; re-authenticate only if it keeps failing."
    );
  }
  if (providerRuntimeFailureKind === "callback_timeout") {
    return (
      "Browser OAuth did not complete before manual fallback kicked in. " +
      "Retry the login flow and paste the redirect URL if prompted."
    );
  }
  if (providerRuntimeFailureKind === "callback_validation") {
    return (
      "Browser OAuth returned an invalid or incomplete callback. " +
      "Retry the login flow and make sure the full redirect URL is pasted if prompted."
    );
  }
  if (providerRuntimeFailureKind === "auth_scope") {
    return (
      "Authentication is missing the required OpenAI ChatGPT scopes. " +
      "Re-run OpenAI login and try again."
    );
  }
  if (providerRuntimeFailureKind === "auth_html") {
    return (
      "Authentication failed at the provider. " +
      "Re-authenticate and verify your provider credentials and account access."
    );
  }
  if (providerRuntimeFailureKind === "auth_invalid_token") {
    return AUTH_INVALID_TOKEN_USER_TEXT;
  }
  if (providerRuntimeFailureKind === "upstream_html") {
    return (
      "The provider returned an HTML error page instead of an API response. " +
      "This usually means a CDN or gateway (e.g. Cloudflare) blocked the request. " +
      "Retry in a moment or check provider status."
    );
  }
  if (providerRuntimeFailureKind === "proxy") {
    return "LLM request failed: proxy or tunnel configuration blocked the provider request.";
  }
  if (providerRuntimeFailureKind === "tls_certificate") {
    return (
      "LLM request failed: TLS certificate validation rejected the provider endpoint. " +
      "Check the endpoint hostname, proxy, and local certificate trust."
    );
  }
  if (providerRuntimeFailureKind === "model_not_found") {
    return MODEL_NOT_FOUND_USER_TEXT;
  }
  if (isContextOverflowError(raw)) {
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
  if (apiError?.type?.toLowerCase().includes("invalid_request") && apiError.message?.trim()) {
    return `LLM request rejected: ${apiError.message.trim()}`;
  }

  if (isBilling429MessageForProvider(raw, providerOwner)) {
    return formatBillingErrorMessage(opts?.provider, opts?.model ?? msg.model, opts?.authMode);
  }

  const failoverReason = classifyFailoverReason(raw, {
    provider: providerOwner,
    providerPlugin: opts?.providerOwner,
  });
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

  if (isTimeoutErrorMessage(raw)) {
    return SYNTHESIZED_TIMEOUT_ERROR_TEXT;
  }

  if (isBillingErrorMessage(raw)) {
    return formatBillingErrorMessage(opts?.provider, opts?.model ?? msg.model, opts?.authMode);
  }

  if (providerRuntimeFailureKind === "schema") {
    return renderFormatErrorCopy(raw);
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
  const friendlyError = formatAssistantErrorText(msg, opts);
  const rawError = msg.errorMessage?.trim();
  const rawPassthrough = isRawAssistantErrorPassthrough({ friendlyError, rawError });
  const parsedApiError = parseApiErrorInfo(rawError ?? "");
  const parsedErrorType = parsedApiError?.type?.toLowerCase() ?? "";
  const parsedErrorBody = parseApiErrorInfo(
    typeof msg.errorBody === "string" ? msg.errorBody.trim() : "",
  );
  const parsedErrorBodyType = parsedErrorBody?.type?.toLowerCase() ?? "";
  const structuredSchemaDetail = parsedErrorType.includes("invalid_request")
    ? parsedApiError?.message
    : parsedErrorBodyType.includes("invalid_request")
      ? parsedErrorBody?.message
      : undefined;
  const rawProviderSchemaError =
    friendlyError?.startsWith("LLM request rejected:") ||
    parsedErrorType.includes("invalid_request") ||
    parsedErrorBodyType.includes("invalid_request");
  const schemaFriendlyError =
    friendlyError === "LLM request failed: provider rejected the request schema or tool payload." ||
    friendlyError?.startsWith("LLM request rejected:");
  const safeFriendlyError =
    structuredSchemaDetail && schemaFriendlyError
      ? renderFormatErrorCopy(structuredSchemaDetail)
      : rawPassthrough
        ? rawProviderSchemaError
          ? renderFormatErrorCopy(parsedApiError?.message ?? "")
          : undefined
        : friendlyError;
  return (safeFriendlyError || GENERIC_ASSISTANT_ERROR_TEXT).trim();
}
