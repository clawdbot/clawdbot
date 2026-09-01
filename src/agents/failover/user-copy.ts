import { stableStringify } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  extractErrorHttpStatus,
  extractLeadingHttpStatus,
  formatRawAssistantErrorForUi,
  isCloudflareOrHtmlErrorPage,
  isGenericProviderInternalError,
  MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
  parseApiErrorInfo,
  parseApiErrorPayload,
} from "../../shared/assistant-error-format.js";
import { formatExecDeniedUserMessage } from "../exec-approval-result.js";
import type { CliTimeoutContext, FallbackAttemptRecord } from "../failover-error.js";
import {
  classifyFailoverReason,
  isPeriodicUsageLimitErrorMessage,
  isProviderCompletedErrorFinishReasonMessage,
} from "./classify.js";
import {
  classifyProviderRequestFacets,
  type ProviderRequestFacet,
} from "./request-error-facets.js";
import type { FailoverClassification, FailoverReason } from "./signal.js";

type FailoverUserCopyContext = {
  raw?: string;
  provider?: string;
  model?: string;
  authMode?: string;
};

type FailoverBaseCopyRenderer = (context: FailoverUserCopyContext) => string | undefined;

const RATE_LIMIT_ERROR_USER_MESSAGE = "⚠️ API rate limit reached. Please try again later.";
export const AUTH_INVALID_TOKEN_USER_TEXT =
  "Authentication failed (provider returned HTTP 401). " +
  "Your provider token may have expired — try the request again in a moment. " +
  "If the failure persists, re-authenticate this provider.";
const SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT =
  "The selected auth profile is unavailable in this agent's OpenClaw credential store. " +
  "Import or migrate that credential into the agent, select another configured profile, or run `openclaw configure`, then retry.";
export const renderFailoverCodeUserCopy = (code: unknown): string | undefined =>
  code === "selected_auth_profile_unavailable"
    ? SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT
    : undefined;
const MODEL_CAPACITY_ERROR_USER_MESSAGE =
  "⚠️ Selected model is at capacity. Try a different model, or wait and retry.";
const OVERLOADED_ERROR_USER_MESSAGE =
  "The AI service is temporarily overloaded. Please try again in a moment.";
const RATE_LIMIT_RETRY_MESSAGE =
  "⚠️ The model request was rate-limited. Please try again in a few minutes.";
const MODEL_CAPACITY_ERROR_RE = /\b(?:selected\s+)?model\s+(?:is\s+)?at capacity\b/i;
const RATE_LIMIT_SPECIFIC_HINT_RE =
  /\bmin(ute)?s?\b|\bhours?\b|\bseconds?\b|\btry again in\b|\bresets?\b|\bplan\b|\bquota\b/i;
const ERROR_PREFIX_RE =
  /^(?:error|(?:[a-z][\w-]*\s+)?api\s*error|openai\s*error|anthropic\s*error|gateway\s*error|codex\s*error|request failed|failed|exception)(?:\s+\d{3})?[:\s-]+/i;
const CONTEXT_OVERFLOW_ERROR_HEAD_RE =
  /^(?:context overflow:|request_too_large\b|request size exceeds\b|request exceeds the maximum size\b|context length exceeded\b|maximum context length\b|prompt is too long\b|exceeds model context window\b)/i;
const NON_ERROR_PROVIDER_PAYLOAD_MAX_LENGTH = 16_384;
const NON_ERROR_PROVIDER_PAYLOAD_PREFIX_RE = /^codex\s*error(?:\s+\d{3})?[:\s-]+/i;
export const PROVIDER_SCHEMA_REJECTION_USER_TEXT =
  "LLM request failed: provider rejected the request schema or tool payload.";
const PROVIDER_OUTPUT_TOKEN_LIMIT_RE =
  /^['"]?max_(?:tokens|output_tokens|completion_tokens|new_tokens)['"]?\s*(?:[:=]\s*)?\(?(\d[\d,]*)\)?\s+exceeds?\b.{0,120}?\b(?:maximum|max|limit)\b(?:\s+(?:output\s+)?tokens?)?(?:\s+(?:is|of)|\s*[:=])?\s*\(?(\d[\d,]*)\)?(?:\D|$)/i;

/** Format billing copy with optional provider/model and credential context. */
export function formatBillingErrorMessage(
  provider?: string,
  model?: string,
  authMode?: string,
): string {
  const providerName = provider?.trim();
  const modelName = model?.trim();
  const providerLabel =
    providerName && modelName ? `${providerName} (${modelName})` : providerName || undefined;
  const isSubscriptionAuth = authMode === "oauth" || authMode === "token";
  if (isSubscriptionAuth) {
    return providerLabel
      ? `⚠️ ${providerLabel} returned a billing error — check your account for subscription or usage limits, then try again.`
      : "⚠️ API provider returned a billing error — check your account for subscription or usage limits, then try again.";
  }
  return providerLabel
    ? `⚠️ ${providerLabel} returned a billing error — your API key has run out of credits or has an insufficient balance. Check your ${providerName} billing dashboard and top up or switch to a different API key.`
    : "⚠️ API provider returned a billing error — your API key has run out of credits or has an insufficient balance. Check your provider's billing dashboard and top up or switch to a different API key.";
}

const BILLING_ERROR_USER_MESSAGE = formatBillingErrorMessage();

/** Surface only bounded numeric limit facts, never arbitrary provider-controlled error text. */
export function renderFormatErrorCopy(raw: string): string {
  const trimmed = raw.trim();
  const normalized =
    extractErrorHttpStatus(trimmed)?.rest ?? trimmed.replace(ERROR_PREFIX_RE, "").trim();
  const candidate = extractErrorHttpStatus(normalized)?.rest ?? normalized;
  const match = candidate.length <= 300 ? candidate.match(PROVIDER_OUTPUT_TOKEN_LIMIT_RE) : null;
  const [, value, maximum] = match ?? [];
  if (!value || !maximum) {
    return PROVIDER_SCHEMA_REJECTION_USER_TEXT;
  }
  return `LLM request rejected: configured maxTokens is ${value}, above the provider maximum of ${maximum}. Lower maxTokens and try again.`;
}

function extractProviderRateLimitMessage(raw: string): string | undefined {
  const withoutPrefix = raw.replace(ERROR_PREFIX_RE, "").trim();
  const info = parseApiErrorInfo(raw) ?? parseApiErrorInfo(withoutPrefix);
  const candidate =
    info?.message ?? (extractLeadingHttpStatus(withoutPrefix)?.rest || withoutPrefix);
  if (!candidate || !RATE_LIMIT_SPECIFIC_HINT_RE.test(candidate)) {
    return undefined;
  }
  if (isCloudflareOrHtmlErrorPage(withoutPrefix)) {
    return undefined;
  }
  const trimmed = candidate.trim();
  if (
    trimmed.length > 300 ||
    trimmed.startsWith("{") ||
    /^(?:<!doctype\s+html\b|<html\b)/i.test(trimmed)
  ) {
    return undefined;
  }
  return `⚠️ ${trimmed}`;
}

function renderRateLimitBaseCopy(context: FailoverUserCopyContext): string {
  const raw = context.raw ?? "";
  if (MODEL_CAPACITY_ERROR_RE.test(raw)) {
    return MODEL_CAPACITY_ERROR_USER_MESSAGE;
  }
  return extractProviderRateLimitMessage(raw) ?? RATE_LIMIT_ERROR_USER_MESSAGE;
}

const FAILOVER_REASON_BASE_COPY = {
  auth: () => AUTH_INVALID_TOKEN_USER_TEXT,
  auth_permanent: () => AUTH_INVALID_TOKEN_USER_TEXT,
  format: (context) => renderFormatErrorCopy(context.raw ?? ""),
  rate_limit: renderRateLimitBaseCopy,
  overloaded: (context) =>
    MODEL_CAPACITY_ERROR_RE.test(context.raw ?? "")
      ? MODEL_CAPACITY_ERROR_USER_MESSAGE
      : OVERLOADED_ERROR_USER_MESSAGE,
  billing: (context) =>
    formatBillingErrorMessage(context.provider, context.model, context.authMode),
  server_error: () => "LLM request failed: provider returned an internal error.",
  timeout: () => "LLM request timed out.",
  tls_certificate: () =>
    "LLM request failed: TLS certificate validation rejected the provider endpoint. Check the endpoint hostname, proxy, and local certificate trust.",
  context_overflow: () =>
    "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.",
  model_not_found: () =>
    "The selected model was not found by the provider. Check the model id or choose a different model.",
  session_expired: () => "The provider session expired. Start a new session and try again.",
  empty_response: () => "The model returned an empty response. Please try again.",
  no_error_details: () => "LLM request failed with an unknown error.",
  unclassified: () => "LLM request failed.",
  unknown: () => "LLM request failed with an unknown error.",
} satisfies Record<FailoverReason, FailoverBaseCopyRenderer>;

function renderFailoverBaseCopy(
  reason: FailoverReason,
  context: FailoverUserCopyContext = {},
): string | undefined {
  return FAILOVER_REASON_BASE_COPY[reason](context);
}

/** Render rate-limit versus overload copy from the canonical classified reason. */
export function renderRateLimitOrOverloadedCopy(params: {
  reason: Extract<FailoverReason, "rate_limit" | "overloaded">;
  raw?: string;
}): string {
  return (
    renderFailoverBaseCopy(params.reason, { raw: params.raw }) ?? RATE_LIMIT_ERROR_USER_MESSAGE
  );
}

export function formatTransportErrorCopy(raw: string): string | undefined {
  if (!raw || isCloudflareOrHtmlErrorPage(raw)) {
    return undefined;
  }
  const lower = normalizeLowercaseStringOrEmpty(raw);
  if (
    /\beconnrefused\b/i.test(raw) ||
    lower.includes("connection refused") ||
    lower.includes("actively refused")
  ) {
    return "LLM request failed: connection refused by the provider endpoint.";
  }
  if (
    /\beconnreset\b|\beconnaborted\b|\benetreset\b|\bepipe\b/i.test(raw) ||
    lower.includes("socket hang up") ||
    lower.includes("connection reset") ||
    lower.includes("connection aborted")
  ) {
    return "LLM request failed: network connection was interrupted.";
  }
  if (
    /\benotfound\b|\beai_again\b/i.test(raw) ||
    lower.includes("getaddrinfo") ||
    lower.includes("no such host") ||
    lower.includes("dns")
  ) {
    return "LLM request failed: DNS lookup for the provider endpoint failed.";
  }
  if (
    /\benetunreach\b|\behostunreach\b|\behostdown\b/i.test(raw) ||
    lower.includes("network is unreachable") ||
    lower.includes("host is unreachable")
  ) {
    return "LLM request failed: the provider endpoint is unreachable from this host.";
  }
  if (
    lower.includes("fetch failed") ||
    lower.includes("connection error") ||
    lower.includes("network request failed")
  ) {
    return "LLM request failed: network connection error.";
  }
  if (raw.includes("网络错误") || raw.includes("网络异常") || raw.includes("连接错误")) {
    return "LLM request failed: provider reported a network error.";
  }
  return undefined;
}

export function formatDiskSpaceErrorCopy(raw: string): string | undefined {
  const lower = normalizeLowercaseStringOrEmpty(raw);
  return /\benospc\b/i.test(raw) ||
    lower.includes("no space left on device") ||
    lower.includes("disk full")
    ? "OpenClaw could not write local session data because the disk is full. Free some disk space and try again."
    : undefined;
}

export function isInvalidStreamingEventOrderError(raw: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(raw);
  return (
    lower.includes("unexpected event order") &&
    lower.includes("message_start") &&
    lower.includes("message_stop")
  );
}

export function isStreamingJsonParseError(raw: string): boolean {
  return raw.trim() === MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE;
}

export function getApiErrorPayloadFingerprint(raw?: string): string | null {
  if (!raw) {
    return null;
  }
  const payload = parseApiErrorPayload(raw);
  return payload ? stableStringify(payload) : null;
}

export function isRawApiErrorPayload(raw?: string): boolean {
  return getApiErrorPayloadFingerprint(raw) !== null;
}

/** Recognize provider HTTP/HTML failures from canonical classification facts. */
export function isLikelyHttpErrorText(raw: string): boolean {
  if (isCloudflareOrHtmlErrorPage(raw)) {
    return true;
  }
  const status = extractLeadingHttpStatus(raw);
  return Boolean(
    status &&
    status.code >= 400 &&
    (classifyFailoverReason(raw, { providerPlugin: null }) !== null ||
      classifyProviderRequestFacets({ status: status.code, message: raw }) !== null),
  );
}

function shouldRewriteRawPayloadWithoutErrorContext(raw: string): boolean {
  if (
    raw.length > NON_ERROR_PROVIDER_PAYLOAD_MAX_LENGTH ||
    !NON_ERROR_PROVIDER_PAYLOAD_PREFIX_RE.test(raw)
  ) {
    return false;
  }
  const info = parseApiErrorInfo(raw);
  const normalizedType = normalizeLowercaseStringOrEmpty(info?.type);
  if (normalizedType.endsWith("_error")) {
    return true;
  }
  const code = Number(info?.httpCode);
  return Number.isFinite(code) && code >= 400;
}

/** Sanitize presentation text, then render error copy from classified facts when requested. */
export function renderSanitizedUserFacingText(
  sanitized: string,
  opts?: { errorContext?: boolean },
): string {
  if (!sanitized) {
    return sanitized;
  }
  const trimmed = sanitized.trim();
  if (!opts?.errorContext) {
    return shouldRewriteRawPayloadWithoutErrorContext(trimmed)
      ? formatRawAssistantErrorForUi(trimmed)
      : sanitized;
  }
  const execDenied = formatExecDeniedUserMessage(trimmed);
  if (execDenied) {
    return execDenied;
  }
  const diskSpace = formatDiskSpaceErrorCopy(trimmed);
  if (diskSpace) {
    return diskSpace;
  }
  if (/incorrect role information|roles must alternate/i.test(trimmed)) {
    return "Message ordering conflict - please try again. If this persists, use /new to start a fresh session.";
  }
  const reason = classifyFailoverReason(trimmed, { providerPlugin: null });
  const status = extractLeadingHttpStatus(trimmed);
  const rawPayload = isRawApiErrorPayload(trimmed);
  if (
    reason === "context_overflow" &&
    (rawPayload ||
      (status && status.code >= 400) ||
      ERROR_PREFIX_RE.test(trimmed) ||
      CONTEXT_OVERFLOW_ERROR_HEAD_RE.test(trimmed))
  ) {
    return renderFailoverBaseCopy("context_overflow") ?? trimmed;
  }
  if (reason === "billing" || reason === "rate_limit" || reason === "overloaded") {
    return renderFailoverBaseCopy(reason, { raw: trimmed }) ?? trimmed;
  }
  if (isGenericProviderInternalError(trimmed)) {
    return formatRawAssistantErrorForUi(trimmed);
  }
  if (isInvalidStreamingEventOrderError(trimmed)) {
    return "LLM request failed: provider returned an invalid streaming response. Please try again.";
  }
  if (rawPayload || (status && status.code >= 400 && reason)) {
    return formatRawAssistantErrorForUi(trimmed);
  }
  if (isStreamingJsonParseError(trimmed)) {
    return "LLM streaming response contained a malformed fragment. Please try again.";
  }
  if (ERROR_PREFIX_RE.test(trimmed)) {
    const transport = formatTransportErrorCopy(trimmed);
    if (transport) {
      return transport;
    }
    if (isProviderCompletedErrorFinishReasonMessage(trimmed)) {
      return formatRawAssistantErrorForUi(trimmed);
    }
    if (reason === "timeout") {
      return renderFailoverBaseCopy("timeout") ?? trimmed;
    }
    return formatRawAssistantErrorForUi(trimmed);
  }
  return sanitized;
}

export const GENERIC_EXTERNAL_RUN_FAILURE_TEXT =
  "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";
export const HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT =
  "⚠️ Heartbeat check failed before it could produce an update. The main chat session remains available.";
export const PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE =
  "⚠️ The model provider rejected the conversation state. Please try again, or use /new to start a fresh session.";
const PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE =
  "⚠️ The model provider returned HTTP 429 before replying. This can mean rate limiting, exhausted quota, or an account balance/billing issue. Check the selected provider/model, API key, and provider billing/quota dashboard, then try again.";
const PROVIDER_INTERNAL_ERROR_USER_MESSAGE =
  "⚠️ The model provider returned a temporary internal error before replying. Try again in a moment, or switch to another model if it keeps happening.";
const PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE = `⚠️ ${AUTH_INVALID_TOKEN_USER_TEXT}`;
const PROVIDER_MODEL_UNAVAILABLE_USER_MESSAGE =
  "⚠️ The configured model is unavailable from the provider — it may have been renamed, retired, or is not offered on this account. This needs a config update (agents.defaults.model); retrying or starting a new session won't fix it.";

const PROVIDER_REQUEST_COPY = {
  "quota-429": PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE,
  "conversation-state": PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
  "provider-internal": PROVIDER_INTERNAL_ERROR_USER_MESSAGE,
  "provider-internal-503": PROVIDER_INTERNAL_ERROR_USER_MESSAGE,
} satisfies Record<ProviderRequestFacet, string>;

function renderProviderRequestFailureCopy(params: {
  classification: FailoverClassification | null;
  facet: ProviderRequestFacet | null;
  status?: number;
}): string | undefined {
  const reason =
    params.classification?.kind === "reason" ? params.classification.reason : undefined;
  if (reason === "auth" && params.status === 401) {
    return PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE;
  }
  if (reason === "model_not_found") {
    return PROVIDER_MODEL_UNAVAILABLE_USER_MESSAGE;
  }
  return params.facet ? PROVIDER_REQUEST_COPY[params.facet] : undefined;
}

type ProviderRequestErrorCode =
  | "provider_authentication_error"
  | "provider_conversation_state_error"
  | "provider_internal_error"
  | "provider_model_unavailable"
  | "provider_rate_limit_or_quota_error";

export function resolveProviderRequestFailureCopy(params: {
  classification: FailoverClassification | null;
  facet: ProviderRequestFacet | null;
  status?: number;
  technicalMessage: string;
}) {
  const userMessage = renderProviderRequestFailureCopy(params);
  if (!userMessage) {
    return undefined;
  }
  const reason =
    params.classification?.kind === "reason" ? params.classification.reason : undefined;
  const code: ProviderRequestErrorCode =
    reason === "auth" && params.status === 401
      ? "provider_authentication_error"
      : reason === "model_not_found"
        ? "provider_model_unavailable"
        : params.facet === "quota-429"
          ? "provider_rate_limit_or_quota_error"
          : params.facet === "conversation-state"
            ? "provider_conversation_state_error"
            : "provider_internal_error";
  return {
    code,
    userMessage,
    technicalMessage: params.technicalMessage,
    ...(params.facet === "provider-internal-503" ? { allowTransientHttpRetry: true as const } : {}),
  };
}

export type ReplyFallbackAttempt = FallbackAttemptRecord & { authMode?: string };

function extractCodexUsageLimitErrorMessage(
  attempts: readonly ReplyFallbackAttempt[],
  directMessage: string,
  directReason: FailoverReason | undefined,
  directProvider: string | undefined,
  sanitizeText?: (text: string) => string,
): string | undefined {
  const attempt = attempts.find(
    (candidate) =>
      candidate.provider === "openai" && candidate.reason === "rate_limit" && candidate.error,
  );
  const text =
    attempt?.error ??
    (directProvider === "openai" && directReason === "rate_limit" ? directMessage : undefined);
  if (!text) {
    return undefined;
  }
  const message = renderSanitizedUserFacingText(sanitizeText?.(text) ?? text, {
    errorContext: true,
  })
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!message) {
    return undefined;
  }
  const truncated = message.length > 500 ? `${truncateUtf16Safe(message, 497)}...` : message;
  return truncated.startsWith("⚠️") ? truncated : `⚠️ ${truncated}`;
}

/** Render the reply surface's rate-limit copy, including structured cooldown context. */
export function renderRateLimitReplyCopy(params: {
  message: string;
  reason?: FailoverReason;
  provider?: string;
  attempts?: readonly ReplyFallbackAttempt[];
  cooldownExpiry?: number | null;
  nowMs?: number;
  sanitizeText?: (text: string) => string;
}): string {
  const attempts = params.attempts ?? [];
  const usageLimit = extractCodexUsageLimitErrorMessage(
    attempts,
    params.message,
    params.reason,
    params.provider,
    params.sanitizeText,
  );
  if (usageLimit) {
    return usageLimit;
  }
  if (attempts.some((attempt) => attempt.reason === "billing") || params.reason === "billing") {
    return BILLING_ERROR_USER_MESSAGE;
  }
  if (attempts.length === 0) {
    if (params.reason === "rate_limit" && isPeriodicUsageLimitErrorMessage(params.message)) {
      const providerMessage = renderSanitizedUserFacingText(
        params.sanitizeText?.(params.message) ?? params.message,
        { errorContext: true },
      );
      return providerMessage.startsWith("⚠️") ? providerMessage : `⚠️ ${providerMessage}`;
    }
    return RATE_LIMIT_RETRY_MESSAGE;
  }
  const expiry = params.cooldownExpiry;
  const nowMs = params.nowMs ?? Date.now();
  if (typeof expiry === "number" && expiry > nowMs) {
    const secsLeft = Math.max(1, Math.ceil((expiry - nowMs) / 1000));
    return secsLeft <= 60
      ? `⚠️ Rate-limited — ready in ~${secsLeft}s. Please wait a moment.`
      : `⚠️ Rate-limited — ready in ~${Math.ceil(secsLeft / 60)} min. Please try again shortly.`;
  }
  const attemptedModels = new Set(
    attempts.map((attempt) => `${attempt.provider}/${attempt.model}`),
  );
  return attemptedModels.size > 1 &&
    attempts.every((attempt) => attempt.reason === "rate_limit" || attempt.reason === "overloaded")
    ? "⚠️ All attempted models were rate-limited or overloaded. Please try again in a few minutes."
    : RATE_LIMIT_RETRY_MESSAGE;
}

export function renderBillingReplyCopy(params: {
  provider?: string;
  model?: string;
  authMode?: string;
  attempts?: readonly ReplyFallbackAttempt[];
}): string {
  const attempts = params.attempts ?? [];
  const billingFailure =
    attempts.length > 0
      ? attempts.find(
          (attempt) =>
            attempt.reason === "billing" &&
            (attempt.authMode === "oauth" || attempt.authMode === "token"),
        )
      : params.authMode === "oauth" || params.authMode === "token"
        ? params
        : undefined;
  return billingFailure &&
    (billingFailure.authMode === "oauth" || billingFailure.authMode === "token")
    ? formatBillingErrorMessage(
        billingFailure.provider,
        billingFailure.model,
        billingFailure.authMode,
      )
    : BILLING_ERROR_USER_MESSAGE;
}

const SAFE_MISSING_API_KEY_PROVIDERS = new Set(["anthropic", "google", "openai"]);

export function renderMissingApiKeyReplyCopy(params?: {
  provider: string;
  providerGuidance?: boolean;
}): string | null {
  const provider = params?.provider.trim().toLowerCase();
  if (!provider) {
    return null;
  }
  if (provider === "openai" && params?.providerGuidance) {
    return "⚠️ Missing API key for OpenAI on the gateway. Use `openai/gpt-5.6-sol` with the OpenAI OAuth profile, or set `OPENAI_API_KEY` for direct OpenAI API-key runs.";
  }
  if (provider === "openai") {
    return '⚠️ Missing API key for provider "openai". Run `openclaw doctor --fix` to repair stale OpenAI model/session routes, restart the gateway if doctor asks, then try again. If doctor has nothing to repair or the error persists, re-auth with `openclaw models auth login --provider openai` or run `openclaw configure`.';
  }
  return SAFE_MISSING_API_KEY_PROVIDERS.has(provider)
    ? `⚠️ Missing API key for provider "${provider}". Configure the gateway auth for that provider, then try again.`
    : "⚠️ Missing API key for the selected provider on the gateway. Configure provider auth, then try again.";
}

const CLI_BACKEND_NO_OUTPUT_STALL_RE =
  /\bCLI produced no output for\s+(\d+)\s*s\s+and was terminated\b/iu;
const CLI_BACKEND_OVERALL_TIMEOUT_RE =
  /\bCLI exceeded timeout\s*\(\s*(\d+)\s*s\s*\)\s+and was terminated\b/iu;
const CLI_BACKEND_ROUTING_REF_BEFORE_ERROR_RE = /\b([\w.-]+\/[A-Za-z][\w.-]*)\s*:\s*CLI\b/iu;

export function renderCliTimeoutReplyCopy(params: {
  message: string;
  cliTimeout?: CliTimeoutContext;
  provider?: string;
  replayPrevented?: boolean;
}): string | null {
  const stall = params.message.match(CLI_BACKEND_NO_OUTPUT_STALL_RE);
  const overall = params.message.match(CLI_BACKEND_OVERALL_TIMEOUT_RE);
  const timeout = params.cliTimeout;
  const seconds = timeout?.timeoutSeconds ?? Number((stall ?? overall)?.[1]);
  if (!Number.isFinite(seconds)) {
    return null;
  }
  const routedModelRef = params.message.match(CLI_BACKEND_ROUTING_REF_BEFORE_ERROR_RE)?.[1];
  const routingSuffix = routedModelRef ? ` (routing ${routedModelRef})` : "";
  const mode = timeout?.mode ?? (stall ? "no-output" : "overall");
  const stoppedWork: string[] = [];
  if (timeout?.backgroundTaskCount) {
    stoppedWork.push(
      `${timeout.backgroundTaskCount} CLI background ${timeout.backgroundTaskCount === 1 ? "task" : "tasks"}`,
    );
  }
  if (timeout?.activeToolCount) {
    stoppedWork.push(
      `${timeout.activeToolCount} active CLI tool ${timeout.activeToolCount === 1 ? "call" : "calls"}`,
    );
  }
  let workStatus =
    stoppedWork.length > 0
      ? ` It also stopped ${stoppedWork.join(" and ")}; that work shares the parent CLI process. Effects may be partial; check before retrying.`
      : timeout?.observedActivity
        ? " The CLI had already begun work, so effects may be partial; check before retrying."
        : "";
  if (params.replayPrevented) {
    workStatus += " OpenClaw did not replay this turn automatically.";
  }
  return mode === "no-output"
    ? `⚠️ CLI subprocess${routingSuffix}: no output for ${seconds}s, so the no-output watchdog stopped it. This is separate from the overall agent timeout; the gateway is unaffected.${workStatus} Check for an interactive prompt. The CLI backend ${params.provider ?? "<id>"} produced no output before its watchdog expired.`
    : `⚠️ CLI turn${routingSuffix}: timed out after ${seconds}s (overall turn limit). The gateway is unaffected.${workStatus} For long work, use a detached OpenClaw sub-agent (no run timeout by default), or raise \`agents.defaults.timeoutSeconds\`.`;
}

type AuthProfileFailureCopyParams = {
  reason: FailoverReason;
  provider: string;
  allInCooldown: boolean;
  causeText?: string;
  recoveryHint?: string;
};

const AUTH_PROFILE_COOLDOWN_COPY = {
  auth: (provider: string) =>
    `Couldn't sign in to ${provider}. Your saved login looks expired or no longer works.`,
  auth_permanent: (provider: string) => `${provider} isn't accepting your saved login anymore.`,
  format: (provider: string) =>
    `Couldn't reach ${provider} with any of your saved logins right now.`,
  rate_limit: (provider: string) =>
    `${provider} is asking us to slow down. Please wait a moment before trying again.`,
  overloaded: (provider: string) =>
    `${provider} is overloaded right now. Please wait a moment before trying again.`,
  billing: (provider: string) =>
    `${provider} rejected the request — looks like a billing issue on the account.`,
  server_error: (provider: string) =>
    `${provider} is having issues right now. Please wait a moment before trying again.`,
  timeout: (provider: string) =>
    `${provider} hasn't been responding. Please wait a moment before trying again.`,
  tls_certificate: (provider: string) =>
    `Couldn't reach ${provider} with any of your saved logins right now.`,
  context_overflow: (provider: string) =>
    `Couldn't reach ${provider} with any of your saved logins right now.`,
  model_not_found: (provider: string) => `${provider} can't find the model you're using right now.`,
  session_expired: (provider: string) =>
    `Couldn't sign in to ${provider}. Your saved login looks expired or no longer works.`,
  empty_response: (provider: string) =>
    `Couldn't reach ${provider} with any of your saved logins right now.`,
  no_error_details: (provider: string) =>
    `Couldn't reach ${provider} with any of your saved logins right now.`,
  unclassified: (provider: string) =>
    `Couldn't reach ${provider} with any of your saved logins right now.`,
  unknown: (provider: string) =>
    `Couldn't reach ${provider} with any of your saved logins right now.`,
} satisfies Record<FailoverReason, (provider: string) => string>;

type AuthProfileReasonPolicy = {
  direct: ((provider: string) => string) | undefined;
  recovery: boolean;
};

const AUTH_PROFILE_REASON_POLICY = {
  auth: { direct: AUTH_PROFILE_COOLDOWN_COPY.auth, recovery: true },
  auth_permanent: {
    direct: (provider) => `${provider} isn't accepting your saved login.`,
    recovery: true,
  },
  format: { direct: undefined, recovery: false },
  rate_limit: { direct: undefined, recovery: false },
  overloaded: { direct: undefined, recovery: false },
  billing: { direct: AUTH_PROFILE_COOLDOWN_COPY.billing, recovery: true },
  server_error: { direct: undefined, recovery: false },
  timeout: { direct: undefined, recovery: false },
  tls_certificate: { direct: undefined, recovery: false },
  context_overflow: { direct: undefined, recovery: true },
  model_not_found: { direct: undefined, recovery: false },
  session_expired: { direct: AUTH_PROFILE_COOLDOWN_COPY.session_expired, recovery: true },
  empty_response: { direct: undefined, recovery: true },
  no_error_details: { direct: undefined, recovery: true },
  unclassified: { direct: undefined, recovery: true },
  unknown: { direct: undefined, recovery: true },
} satisfies Record<FailoverReason, AuthProfileReasonPolicy>;

export function renderAuthProfileFailoverCopy(params: AuthProfileFailureCopyParams): string {
  const policy = AUTH_PROFILE_REASON_POLICY[params.reason];
  const description = params.allInCooldown
    ? AUTH_PROFILE_COOLDOWN_COPY[params.reason](params.provider)
    : policy.direct?.(params.provider);
  if (!description) {
    return params.causeText
      ? params.causeText.trim() ||
          `Couldn't reach ${params.provider} with any of your saved logins right now.`
      : `Couldn't reach ${params.provider} with any of your saved logins right now.`;
  }
  const hint = policy.recovery ? params.recoveryHint : null;
  const causeText = params.causeText?.trim() ?? "";
  const suffix = causeText && !description.includes(causeText) ? ` (${causeText})` : "";
  return `${[description, hint].filter(Boolean).join(" ")}${suffix}`;
}

const CONTROL_UI_LOG_HINT = "To view logs, run `openclaw logs --follow` in a terminal.";

export function renderControlUiAgentFailureCopy(errorText: string): string {
  return `⚠️ Agent failed before reply: ${errorText.trim().replace(/\.\s*$/, "")}.\n${CONTROL_UI_LOG_HINT}`;
}

export function replaceGenericExternalRunFailureText(text: string): {
  text: string;
  replaced: boolean;
} {
  if (text.trim() === GENERIC_EXTERNAL_RUN_FAILURE_TEXT) {
    return { text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT, replaced: true };
  }
  const start = text.indexOf(GENERIC_EXTERNAL_RUN_FAILURE_TEXT);
  if (start < 0 || text.slice(start + GENERIC_EXTERNAL_RUN_FAILURE_TEXT.length).trim()) {
    return { text, replaced: false };
  }
  const prefix = text.slice(0, start).trimEnd();
  return {
    text: prefix
      ? `${prefix} ${HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT}`
      : HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
    replaced: true,
  };
}
