import { inspectTlsCertificateError } from "@openclaw/ai/internal/shared";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import {
  extractLeadingHttpStatus,
  isGenericProviderInternalError,
  parseApiErrorInfo,
} from "../../shared/assistant-error-format.js";
import { classifyOAuthRefreshFailure } from "../auth-profiles/oauth-refresh-failure.js";
import {
  isImageDimensionErrorMessage,
  isImageSizeError,
} from "../embedded-agent-helpers/image-errors.js";
import { isModelNotFoundErrorMessage } from "../live-model-errors.js";
import {
  classifyCoreFailoverReasonFromErrorType,
  classifyFailoverClassificationFromErrorType,
  classifyFailoverClassificationFromHttpStatus,
  classifyFailoverReasonFrom402Text,
  classifyFailoverReasonFromCode,
  failoverReasonFromClassification,
  inferSignalStatus,
  isClaudeCliAuthError,
  isExactUnknownNoDetailsError,
  isGenericUnknownStreamErrorMessage,
  isReplayInvalidErrorMessage,
  isUnsupportedImageInputErrorMessage,
  toPluginClassification,
  toReasonClassification,
} from "./classification-rules.js";
import { isContextOverflowErrorFromTables } from "./context-overflow.js";
import {
  isAuthErrorMessage,
  isAuthPermanentErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isPeriodicUsageLimitErrorMessage,
  isProviderCompletedErrorFinishReasonMessage,
  isRateLimitErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
  matchesFormatErrorPattern,
} from "./message-patterns.js";
import {
  classifyLegacyProviderSpecificError,
  classifyProviderPluginError,
  looksLikeProviderContextOverflowCandidate,
  type PreparedProviderFailoverOwner,
} from "./provider-patterns.js";
import type { FailoverClassification, FailoverReason, FailoverSignal } from "./signal.js";
export { isUnclassifiedNoBodyHttpSignal } from "./classification-rules.js";
export {
  isContextOverflowError,
  isLikelyContextOverflowError,
  isReasoningConstraintErrorMessage,
} from "./context-overflow.js";
export {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isPeriodicUsageLimitErrorMessage,
  isProviderCompletedErrorFinishReasonMessage,
  isProviderRequestSizeCeilingError,
  isRateLimitErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "./message-patterns.js";
export { extractFailoverSignalDetails } from "./signal-details.js";
const HTML_BODY_RE = /^\s*(?:<!doctype\s+html\b|<html\b)/i;
const HTML_CLOSE_RE = /<\/html>/i;
function isHtmlErrorResponse(raw: string, status?: number): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  const candidate = extractLeadingHttpStatus(trimmed)
    ? trimmed
    : trimmed.replace(/^error:\s*/i, "").trim();
  const inferred =
    typeof status === "number" && Number.isFinite(status)
      ? status
      : extractLeadingHttpStatus(candidate)?.code;
  if (typeof inferred !== "number" || inferred < 400) {
    return false;
  }
  const rest = extractLeadingHttpStatus(candidate)?.rest ?? candidate;
  return HTML_BODY_RE.test(rest) && HTML_CLOSE_RE.test(rest);
}
function isTransportHtmlErrorStatus(status: number | undefined): boolean {
  return (
    status === 408 ||
    status === 499 ||
    (typeof status === "number" && status >= 500 && status < 600)
  );
}
function classifyFailoverClassificationFromMessage(
  raw: string,
  provider?: string,
): FailoverClassification | null {
  if (isImageDimensionErrorMessage(raw)) {
    return null;
  }
  if (isImageSizeError(raw)) {
    return null;
  }
  if (isUnsupportedImageInputErrorMessage(raw)) {
    return toReasonClassification("format");
  }
  if (isClaudeCliAuthError(raw, provider)) {
    return toReasonClassification("auth");
  }
  if (isCliSessionExpiredErrorMessage(raw)) {
    return toReasonClassification("session_expired");
  }
  if (isModelNotFoundErrorMessage(raw)) {
    return toReasonClassification("model_not_found");
  }
  const legacyProviderReason = classifyLegacyProviderSpecificError({
    errorMessage: raw,
    provider,
  });
  if (legacyProviderReason) {
    return toReasonClassification(legacyProviderReason);
  }
  if (isContextOverflowErrorFromTables(raw)) {
    return { kind: "context_overflow" };
  }
  if (isReplayInvalidErrorMessage(raw)) {
    return toReasonClassification("format");
  }
  const reasonFrom402Text = classifyFailoverReasonFrom402Text(raw);
  if (reasonFrom402Text) {
    return toReasonClassification(reasonFrom402Text);
  }
  const leadingStatus = extractLeadingHttpStatus(raw.trim());
  if (leadingStatus?.code !== 429 && isBillingErrorMessage(raw)) {
    return toReasonClassification("billing");
  }
  if (isPeriodicUsageLimitErrorMessage(raw)) {
    return toReasonClassification(isBillingErrorMessage(raw) ? "billing" : "rate_limit");
  }
  if (isRateLimitErrorMessage(raw)) {
    return toReasonClassification("rate_limit");
  }
  if (isOverloadedErrorMessage(raw)) {
    return toReasonClassification("overloaded");
  }
  // Provider-completed `finish_reason: error` / stop-reason `error` is not a
  // hang. Classify as server_error (failover still runs) so operators do not
  // chase timeout knobs and user copy is not rewritten to "LLM request timed out."
  // (#109218; keep #59524 fallback by remaining a failover reason).
  if (isProviderCompletedErrorFinishReasonMessage(raw)) {
    return toReasonClassification("server_error");
  }
  if (
    isStructuredServerErrorMessage(raw) &&
    !isBillingErrorMessage(raw) &&
    !isAuthPermanentErrorMessage(raw) &&
    !isAuthErrorMessage(raw)
  ) {
    return toReasonClassification("server_error");
  }
  if (isGenericProviderInternalError(raw)) {
    return toReasonClassification("timeout");
  }
  // Auth classifiers run before the broad isJsonApiInternalServerError check so that
  // provider errors like {"type":"api_error","message":"invalid api key"} are
  // correctly classified as "auth" rather than "timeout".
  const oauthRefreshFailure = classifyOAuthRefreshFailure(raw);
  if (oauthRefreshFailure?.reason) {
    return toReasonClassification("auth_permanent");
  }
  if (isAuthPermanentErrorMessage(raw)) {
    return toReasonClassification("auth_permanent");
  }
  if (isAuthErrorMessage(raw)) {
    return toReasonClassification("auth");
  }
  if (isGenericUnknownStreamErrorMessage(raw)) {
    return toReasonClassification("timeout");
  }
  if (isServerErrorMessage(raw)) {
    return toReasonClassification("timeout");
  }
  if (isJsonApiInternalServerError(raw)) {
    return toReasonClassification("timeout");
  }
  if (isCloudCodeAssistFormatError(raw)) {
    return toReasonClassification("format");
  }
  if (isExactUnknownNoDetailsError(raw)) {
    return toReasonClassification("no_error_details");
  }
  if (isTimeoutErrorMessage(raw)) {
    return toReasonClassification("timeout");
  }
  // Some adapters preserve only the raw JSON response body. Reuse the same
  // structured type mapping as typed SDK errors after all more-specific text
  // and provider rules have had a chance to classify the failure.
  const apiErrorReason = classifyCoreFailoverReasonFromErrorType(parseApiErrorInfo(raw)?.type);
  if (apiErrorReason) {
    return toReasonClassification(apiErrorReason);
  }
  return classifyFailoverClassificationFromHttpStatus(
    inferSignalStatus({ message: raw }),
    raw,
    null,
    undefined,
    provider,
  );
}
function classificationReason(
  classification: FailoverClassification | null,
): FailoverReason | undefined {
  return classification?.kind === "reason" ? classification.reason : undefined;
}
function classifyFailoverDetailCandidates(
  details: readonly string[] | undefined,
  provider: string | undefined,
): FailoverClassification | null {
  for (const detail of details ?? []) {
    const classification = classifyFailoverClassificationFromMessage(detail, provider);
    if (classification) {
      return classification;
    }
  }
  return null;
}
function mergeMessageAndDetailClassification(
  messageClassification: FailoverClassification | null,
  detailClassification: FailoverClassification | null,
): FailoverClassification | null {
  if (!messageClassification) {
    return detailClassification;
  }
  if (!detailClassification) {
    return messageClassification;
  }
  if (messageClassification.kind === "context_overflow") {
    return messageClassification;
  }
  if (detailClassification.kind === "context_overflow") {
    return detailClassification;
  }
  if (
    classificationReason(detailClassification) === "billing" &&
    classificationReason(messageClassification) === "rate_limit"
  ) {
    return detailClassification;
  }
  return classificationReason(messageClassification) === "format"
    ? detailClassification
    : messageClassification;
}

export function classifyFailoverSignal(
  signal: FailoverSignal,
  opts?: { providerPlugin?: PreparedProviderFailoverOwner | null },
): FailoverClassification | null {
  const inferredStatus = inferSignalStatus(signal);
  const explicitStatus =
    typeof signal.status === "number" && Number.isFinite(signal.status) ? signal.status : undefined;
  const messageClassification = signal.message
    ? classifyFailoverClassificationFromMessage(signal.message, signal.provider)
    : null;
  const detailClassification = classifyFailoverDetailCandidates(signal.details, signal.provider);
  const messageOrDetailClassification = mergeMessageAndDetailClassification(
    messageClassification,
    detailClassification,
  );
  const errorTypeClassification = classifyFailoverClassificationFromErrorType(signal.errorType);
  // Provider-attributed 401/403/429 text is ambiguous enough to consult only the
  // scoped owner hook. Passing the inferred status also fences unresolved ids
  // from the descriptor-free broad scan in provider-runtime.
  const providerHookStatus =
    explicitStatus ??
    (signal.provider && (inferredStatus === 401 || inferredStatus === 403 || inferredStatus === 429)
      ? inferredStatus
      : undefined);
  // Pure table matches are also the cheap runtime-load gate. Structured,
  // context-shaped, and otherwise-unclassified signals still consult the
  // provider once; its result remains authoritative over the prepared tables.
  const hasProviderHookSignal = Boolean(
    signal.message || signal.code || signal.errorType || typeof inferredStatus === "number",
  );
  const hasStructuredDescriptor =
    providerHookStatus !== undefined || signal.code !== undefined || signal.errorType !== undefined;
  const hasContextCandidate = Boolean(
    signal.message && looksLikeProviderContextOverflowCandidate(signal.message),
  );
  const shouldConsultProviderPlugin =
    hasProviderHookSignal &&
    (hasStructuredDescriptor || hasContextCandidate || !messageClassification);
  const providerPluginReason = shouldConsultProviderPlugin
    ? classifyProviderPluginError({
        errorMessage: signal.message ?? "",
        provider: signal.provider,
        status: providerHookStatus,
        code: signal.code,
        errorType: signal.errorType,
        providerPlugin: opts?.providerPlugin,
      })
    : null;
  const tlsCertificateError = inspectTlsCertificateError(signal);
  if (!providerPluginReason && tlsCertificateError && inferredStatus === undefined) {
    return toReasonClassification("tls_certificate");
  }
  if (
    !providerPluginReason &&
    signal.message &&
    isTransportHtmlErrorStatus(inferredStatus) &&
    isHtmlErrorResponse(signal.message, inferredStatus)
  ) {
    return toReasonClassification("timeout");
  }
  // Message/detail semantics stay ahead of generic structured types so an
  // invalid-request wrapper cannot hide billing, context, or provider policy.
  const codeReason = classifyFailoverReasonFromCode(signal.code);
  const effectiveMessageClassification = providerPluginReason
    ? toPluginClassification(providerPluginReason)
    : mergeMessageAndDetailClassification(
        messageOrDetailClassification ?? errorTypeClassification,
        codeReason ? toReasonClassification(codeReason) : null,
      );
  if (codeReason === "auth_permanent") {
    return toReasonClassification(codeReason);
  }
  const statusClassification = classifyFailoverClassificationFromHttpStatus(
    inferredStatus,
    signal.message,
    effectiveMessageClassification,
    signal.status,
    signal.provider,
    { preserveProviderSignalClassification: providerPluginReason !== null },
  );
  if (statusClassification) {
    return statusClassification;
  }
  if (codeReason) {
    return toReasonClassification(codeReason);
  }
  return effectiveMessageClassification;
}
export function isCloudCodeAssistFormatError(raw: string): boolean {
  return !isImageDimensionErrorMessage(raw) && matchesFormatErrorPattern(raw);
}

// Transient signal patterns for api_error payloads. Only treat an api_error as
// retryable when the message text itself indicates a transient server issue.
// Non-transient api_error payloads (context overflow, validation/schema errors)
// must NOT be classified as timeout.
const API_ERROR_TRANSIENT_SIGNALS_RE =
  /internal server error|overload|temporarily unavailable|service unavailable|unknown error|server error|bad gateway|gateway timeout|upstream error|backend error|try again later|temporarily.+unable|unexpected error/i;

function isJsonApiInternalServerError(raw: string): boolean {
  if (!raw) {
    return false;
  }
  const value = normalizeLowercaseStringOrEmpty(raw);
  // Providers wrap transient 5xx errors in JSON payloads like:
  // {"type":"error","error":{"type":"api_error","message":"Internal server error"}}
  // Non-standard providers (e.g. MiniMax) may use different message text:
  // {"type":"api_error","message":"unknown error, 520 (1000)"}
  if (!value.includes('"type":"api_error"')) {
    return false;
  }
  // Billing and auth errors can also carry "type":"api_error". Exclude them so
  // the more specific classifiers further down the chain handle them correctly.
  if (isBillingErrorMessage(raw) || isAuthErrorMessage(raw) || isAuthPermanentErrorMessage(raw)) {
    return false;
  }
  // Only match when the message contains a transient signal. api_error payloads
  // with non-transient messages (e.g. context overflow, schema validation) should
  // fall through to more specific classifiers or remain unclassified.
  return API_ERROR_TRANSIENT_SIGNALS_RE.test(raw);
}

function isStructuredServerErrorMessage(raw: string): boolean {
  if (!raw) {
    return false;
  }
  const parsedType = normalizeOptionalLowercaseString(parseApiErrorInfo(raw)?.type);
  if (parsedType === "server_error" || parsedType === "upstream_error") {
    return true;
  }
  const value = normalizeLowercaseStringOrEmpty(raw);
  return (
    value.includes('"type":"server_error"') ||
    value.includes('"code":"server_error"') ||
    value.includes('"type":"upstream_error"') ||
    value.includes('"code":"upstream_error"')
  );
}

function isCliSessionExpiredErrorMessage(raw: string): boolean {
  return /\b(?:session (?:not found|does not exist|expired|invalid)|conversation (?:not found|does not exist|expired|invalid)|no conversation found|no such session|invalid session|(?:session|conversation) id not found)\b/.test(
    normalizeLowercaseStringOrEmpty(raw),
  );
}

export function classifyFailoverReason(
  raw: string,
  opts?: { provider?: string; providerPlugin?: PreparedProviderFailoverOwner | null },
): FailoverReason | null {
  return failoverReasonFromClassification(
    classifyFailoverSignal(
      {
        message: raw,
        provider: opts?.provider,
      },
      opts,
    ),
  );
}

export function isFailoverErrorMessage(raw: string, opts?: { provider?: string }): boolean {
  return classifyFailoverReason(raw, opts) !== null;
}
