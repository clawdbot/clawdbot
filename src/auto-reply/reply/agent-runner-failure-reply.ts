import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatAuthProfileFailureMessage } from "../../agents/auth-profiles/failure-copy.js";
import {
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailureError,
  formatOAuthRefreshFailureLoginCommandMarkdown,
} from "../../agents/auth-profiles/oauth-refresh-failure.js";
import {
  BILLING_ERROR_USER_MESSAGE,
  formatBillingErrorMessage,
  formatRateLimitOrOverloadedErrorCopy,
} from "../../agents/embedded-agent-helpers.js";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import {
  describeFailoverError,
  findCliMaxTurnsError,
  findCliTimeoutError,
  isFailoverError,
  type FallbackAttemptRecord,
} from "../../agents/failover-error.js";
import { isPeriodicUsageLimitErrorMessage } from "../../agents/failover/classify.js";
import {
  classifyProviderRequestFacets,
  type ProviderRequestFacet,
} from "../../agents/failover/request-error-facets.js";
import type { FailoverClassification } from "../../agents/failover/signal.js";
import { isProviderAuthError } from "../../agents/model-auth-runtime-shared.js";
import { resolveSilentReplyPolicy } from "../../config/silent-reply.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
  PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE,
  PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
  PROVIDER_INTERNAL_ERROR_USER_MESSAGE,
  PROVIDER_MODEL_UNAVAILABLE_USER_MESSAGE,
  PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE,
} from "./agent-runner-failure-copy.js";

const RATE_LIMIT_RETRY_MESSAGE =
  "⚠️ The model request was rate-limited. Please try again in a few minutes.";

export function resolveReplyFailoverFacts(error: unknown, message: string) {
  const described = describeFailoverError(error);
  const classification = described.reason
    ? ({ kind: "reason", reason: described.reason } as const)
    : null;
  return {
    reason: classification?.kind === "reason" ? classification.reason : undefined,
    providerRequestError: mapProviderRequestError({
      classification,
      facet: classifyProviderRequestFacets({
        status: described.status,
        message: described.rawError ?? message,
      }),
      status: described.status,
      technicalMessage: message,
    }),
  };
}

type ReplyFailoverFacts = ReturnType<typeof resolveReplyFailoverFacts>;

type ProviderRequestErrorCode =
  | "provider_authentication_error"
  | "provider_conversation_state_error"
  | "provider_internal_error"
  | "provider_model_unavailable"
  | "provider_rate_limit_or_quota_error";

function mapProviderRequestError(params: {
  classification: FailoverClassification | null;
  facet: ProviderRequestFacet | null;
  status?: number;
  technicalMessage: string;
}) {
  const reason =
    params.classification?.kind === "reason" ? params.classification.reason : undefined;
  const mapped: [ProviderRequestErrorCode, string, true?] | undefined =
    reason === "auth" && params.status === 401
      ? ["provider_authentication_error", PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE]
      : reason === "model_not_found"
        ? ["provider_model_unavailable", PROVIDER_MODEL_UNAVAILABLE_USER_MESSAGE]
        : params.facet === "quota-429"
          ? ["provider_rate_limit_or_quota_error", PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE]
          : params.facet === "conversation-state"
            ? ["provider_conversation_state_error", PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE]
            : params.facet === "provider-internal" || params.facet === "provider-internal-503"
              ? [
                  "provider_internal_error",
                  PROVIDER_INTERNAL_ERROR_USER_MESSAGE,
                  params.facet === "provider-internal-503" || undefined,
                ]
              : undefined;
  return mapped
    ? {
        code: mapped[0],
        userMessage: mapped[1],
        technicalMessage: params.technicalMessage,
        ...(mapped[2] ? { allowTransientHttpRetry: true as const } : {}),
      }
    : undefined;
}

/** Builds a human-friendly rate-limit message, including a known cooldown. */
export function buildRateLimitCooldownMessage(err: unknown): string {
  const message = formatErrorMessage(err);
  const failoverFacts = resolveReplyFailoverFacts(err, message);
  const attempts = readFallbackAttempts(err);
  const codexUsageLimitMessage = extractCodexUsageLimitErrorMessage(
    attempts,
    message,
    failoverFacts.reason,
    isFailoverError(err) ? err.provider : undefined,
  );
  if (codexUsageLimitMessage) {
    return codexUsageLimitMessage;
  }
  if (attempts.some((attempt) => attempt.reason === "billing")) {
    return BILLING_ERROR_USER_MESSAGE;
  }
  if (failoverFacts.reason === "billing") {
    return BILLING_ERROR_USER_MESSAGE;
  }
  if (attempts.length === 0) {
    if (failoverFacts.reason === "rate_limit" && isPeriodicUsageLimitErrorMessage(message)) {
      const providerMessage = sanitizeUserFacingText(message, { errorContext: true });
      return providerMessage.startsWith("⚠️") ? providerMessage : `⚠️ ${providerMessage}`;
    }
    return RATE_LIMIT_RETRY_MESSAGE;
  }
  const expiry = isFailoverError(err) ? err.soonestCooldownExpiry : undefined;
  const now = Date.now();
  if (typeof expiry === "number" && expiry > now) {
    const secsLeft = Math.max(1, Math.ceil((expiry - now) / 1000));
    if (secsLeft <= 60) {
      return `⚠️ Rate-limited — ready in ~${secsLeft}s. Please wait a moment.`;
    }
    return `⚠️ Rate-limited — ready in ~${Math.ceil(secsLeft / 60)} min. Please try again shortly.`;
  }
  const attemptedModels = new Set(
    attempts.map((attempt) => `${attempt.provider}/${attempt.model}`),
  );
  if (
    attemptedModels.size > 1 &&
    attempts.every((attempt) => attempt.reason === "rate_limit" || attempt.reason === "overloaded")
  ) {
    return "⚠️ All attempted models were rate-limited or overloaded. Please try again in a few minutes.";
  }
  return RATE_LIMIT_RETRY_MESSAGE;
}

export function resolveBillingFailureReplyText(err: unknown): string {
  const attempts = readFallbackAttempts(err);
  const billingFailure =
    attempts.length > 0
      ? attempts.find(
          (attempt) =>
            attempt.reason === "billing" &&
            (attempt.authMode === "oauth" || attempt.authMode === "token"),
        )
      : isFailoverError(err) && err.reason === "billing"
        ? err
        : undefined;
  if (
    !billingFailure ||
    (billingFailure.authMode !== "oauth" && billingFailure.authMode !== "token")
  ) {
    return BILLING_ERROR_USER_MESSAGE;
  }
  return formatBillingErrorMessage(
    billingFailure.provider,
    billingFailure.model,
    billingFailure.authMode,
  );
}

function extractCodexUsageLimitErrorMessage(
  attempts: readonly ReplyFallbackAttempt[],
  directMessage: string,
  directReason: ReplyFailoverFacts["reason"],
  directProvider: string | undefined,
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
  const message = sanitizeUserFacingText(text, { errorContext: true })
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

type ReplyFallbackAttempt = FallbackAttemptRecord & { authMode?: string };

function readFallbackAttempts(err: unknown): readonly ReplyFallbackAttempt[] {
  return isFailoverError(err) && Array.isArray(err.attempts)
    ? (err.attempts as readonly ReplyFallbackAttempt[])
    : [];
}

function collapseRepeatedFailureDetail(message: string): string {
  const parts = message
    .split(/\s+\|\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2 && parts.every((part) => part === parts[0])) {
    return expectDefined(parts[0], "parts entry at 0");
  }
  return message.trim();
}

const SAFE_MISSING_API_KEY_PROVIDERS = new Set(["anthropic", "google", "openai"]);
const EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS = 900;
const AGENT_FAILED_BEFORE_REPLY_TEXT = "Agent failed before reply:";
const PREFLIGHT_COMPACTION_FAILURE_PREFIX = "Preflight compaction required but failed:";

type ExternalRunFailureReply = {
  text: string;
  isGenericRunnerFailure: boolean;
};

type ExternalRunFailureInput = string | { message: string; error?: unknown };

type ExternalFailureConversationContext = Pick<
  TemplateContext,
  "ChatType" | "Provider" | "SessionKey" | "Surface"
>;

export function isNonDirectConversationContext(ctx: ExternalFailureConversationContext): boolean {
  const chatType = normalizeLowercaseStringOrEmpty(ctx.ChatType);
  return chatType === "group" || chatType === "channel";
}

export function isVerboseFailureDetailEnabled(level: VerboseLevel | undefined): boolean {
  return level === "on" || level === "full";
}

export function resolveExternalRunFailureTextForConversation(params: {
  text: string;
  sessionCtx: ExternalFailureConversationContext;
  isGenericRunnerFailure: boolean;
  cfg?: OpenClawConfig;
}): string {
  if (!isNonDirectConversationContext(params.sessionCtx)) {
    return params.text;
  }
  if (!params.isGenericRunnerFailure && !params.text.includes(AGENT_FAILED_BEFORE_REPLY_TEXT)) {
    return params.text;
  }
  const silentPolicy = resolveSilentReplyPolicy({
    cfg: params.cfg,
    sessionKey: params.sessionCtx.SessionKey,
    surface: params.sessionCtx.Surface ?? params.sessionCtx.Provider,
    conversationType: "group",
  });
  return silentPolicy === "disallow" ? params.text : SILENT_REPLY_TOKEN;
}

const CLI_BACKEND_NO_OUTPUT_STALL_RE =
  /\bCLI produced no output for\s+(\d+)\s*s\s+and was terminated\b/iu;
const CLI_BACKEND_OVERALL_TIMEOUT_RE =
  /\bCLI exceeded timeout\s*\(\s*(\d+)\s*s\s*\)\s+and was terminated\b/iu;
const CLI_BACKEND_ROUTING_REF_BEFORE_ERROR_RE = /\b([\w.-]+\/[A-Za-z][\w.-]*)\s*:\s*CLI\b/iu;
const CODEX_APP_SERVER_CLIENT_CLOSED_BEFORE_REPLY_RE =
  /\bcodex app-server client closed before turn completed\b/iu;
const CODEX_APP_SERVER_TURN_COMPLETION_IDLE_TIMEOUT_RE =
  /\bcodex app-server turn idle timed out waiting for turn\/completed\b/iu;
const CODEX_SESSION_GENERATION_NOT_CURRENT_RE =
  /\bcodex session generation is no longer current\b/iu;

function buildCodexAppServerFailureText(message: string): string | null {
  const normalizedMessage = collapseRepeatedFailureDetail(message);
  if (CODEX_SESSION_GENERATION_NOT_CURRENT_RE.test(normalizedMessage)) {
    return "⚠️ This Codex session changed before your message could run. Please send it again.";
  }
  if (CODEX_APP_SERVER_CLIENT_CLOSED_BEFORE_REPLY_RE.test(normalizedMessage)) {
    return "⚠️ Codex app-server connection closed before this turn finished. OpenClaw retried once when the stdio turn was still replay-safe; please try again if this keeps happening.";
  }
  if (CODEX_APP_SERVER_TURN_COMPLETION_IDLE_TIMEOUT_RE.test(normalizedMessage)) {
    return "⚠️ Codex app-server stopped before confirming turn completion. OpenClaw did not replay the turn automatically because it may still be active; try again, or use /new if the session stays stuck.";
  }
  return null;
}

/** Formats the reply shown when preflight compaction fails before a run. */
export function buildPreflightCompactionFailureText(
  message: string,
  options?: { includeDetails?: boolean },
): string | null {
  const normalizedMessage = collapseRepeatedFailureDetail(message);
  if (!normalizedMessage.startsWith(PREFLIGHT_COMPACTION_FAILURE_PREFIX)) {
    return null;
  }
  const reason = sanitizeUserFacingText(
    normalizedMessage.slice(PREFLIGHT_COMPACTION_FAILURE_PREFIX.length),
    { errorContext: true },
  )
    .trim()
    .replace(/\s+/gu, " ");
  const reasonSuffix = options?.includeDetails && reason ? ` Reason: ${reason}.` : "";
  return (
    "⚠️ Context is too large and auto-compaction could not recover this turn." +
    `${reasonSuffix} Try again, use /compact, or use /new to start a fresh session.`
  );
}

function buildCliBackendTimeoutFailureText(input: {
  message: string;
  error?: unknown;
  replayPrevented?: boolean;
}): string | null {
  const normalizedMessage = collapseRepeatedFailureDetail(input.message);
  const cliTimeoutError = findCliTimeoutError(input.error);
  const stall = normalizedMessage.match(CLI_BACKEND_NO_OUTPUT_STALL_RE);
  const overall = normalizedMessage.match(CLI_BACKEND_OVERALL_TIMEOUT_RE);
  const timeout = cliTimeoutError?.cliTimeout;
  const seconds = timeout?.timeoutSeconds ?? Number((stall ?? overall)?.[1]);
  if (!Number.isFinite(seconds)) {
    return null;
  }
  const routedModelRef = normalizedMessage.match(CLI_BACKEND_ROUTING_REF_BEFORE_ERROR_RE)?.[1];
  const routingSuffix = routedModelRef ? ` (routing ${routedModelRef})` : "";
  const mode = timeout?.mode ?? (stall ? "no-output" : "overall");
  let workStatus = "";
  const stoppedWork: string[] = [];
  if (timeout?.backgroundTaskCount) {
    const noun = timeout.backgroundTaskCount === 1 ? "task" : "tasks";
    stoppedWork.push(`${timeout.backgroundTaskCount} CLI background ${noun}`);
  }
  if (timeout?.activeToolCount) {
    const noun = timeout.activeToolCount === 1 ? "call" : "calls";
    stoppedWork.push(`${timeout.activeToolCount} active CLI tool ${noun}`);
  }
  if (stoppedWork.length > 0) {
    workStatus = ` It also stopped ${stoppedWork.join(" and ")}; that work shares the parent CLI process. Effects may be partial; check before retrying.`;
  } else if (timeout?.observedActivity) {
    workStatus =
      " The CLI had already begun work, so effects may be partial; check before retrying.";
  }
  if (input.replayPrevented) {
    workStatus += " OpenClaw did not replay this turn automatically.";
  }
  if (mode === "no-output") {
    const backendId = cliTimeoutError?.provider ?? "<id>";
    return (
      `⚠️ CLI subprocess${routingSuffix}: no output for ${seconds}s, so the no-output watchdog stopped it. ` +
      `This is separate from the overall agent timeout; the gateway is unaffected.${workStatus} ` +
      "Check for an interactive prompt. " +
      `The CLI backend ${backendId} produced no output before its watchdog expired.`
    );
  }
  return (
    `⚠️ CLI turn${routingSuffix}: timed out after ${seconds}s (overall turn limit). The gateway is unaffected.${workStatus} ` +
    "For long work, use a detached OpenClaw sub-agent (no run timeout by default), or raise `agents.defaults.timeoutSeconds`."
  );
}

function buildMissingApiKeyFailureText(input: { message: string; error?: unknown }): string | null {
  const authError = isProviderAuthError(input.error) ? input.error : undefined;
  const provider = authError?.provider.trim().toLowerCase();
  if (!provider) {
    return null;
  }
  if (provider === "openai" && authError?.providerGuidance) {
    return "⚠️ Missing API key for OpenAI on the gateway. Use `openai/gpt-5.6-sol` with the OpenAI OAuth profile, or set `OPENAI_API_KEY` for direct OpenAI API-key runs.";
  }
  if (provider === "openai") {
    return '⚠️ Missing API key for provider "openai". Run `openclaw doctor --fix` to repair stale OpenAI model/session routes, restart the gateway if doctor asks, then try again. If doctor has nothing to repair or the error persists, re-auth with `openclaw models auth login --provider openai` or run `openclaw configure`.';
  }
  if (SAFE_MISSING_API_KEY_PROVIDERS.has(provider)) {
    return `⚠️ Missing API key for provider "${provider}". Configure the gateway auth for that provider, then try again.`;
  }
  return "⚠️ Missing API key for the selected provider on the gateway. Configure provider auth, then try again.";
}

export function buildAuthProfileFailoverFailureText(error: unknown): string | null {
  if (!isFailoverError(error) || !error.provider || !error.authProfileFailure) {
    return null;
  }
  return formatAuthProfileFailureMessage({
    reason: error.reason,
    provider: error.provider,
    allInCooldown: error.authProfileFailure.allInCooldown,
    cause: error.cause,
  });
}

function formatForwardedExternalRunFailureText(message: string): string {
  const sanitized = sanitizeUserFacingText(message, { errorContext: true })
    .trim()
    .replace(/^⚠️\s*/u, "")
    .replace(/\s+/gu, " ");
  if (!sanitized) {
    return GENERIC_EXTERNAL_RUN_FAILURE_TEXT;
  }
  const detail =
    sanitized.length > EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS
      ? `${truncateUtf16Safe(sanitized, EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS - 1).trimEnd()}…`
      : sanitized;
  return `⚠️ Agent failed before reply: ${detail}${/[.!?]$/u.test(detail) ? "" : "."} Please try again, or use /new to start a fresh session.`;
}

function supportsChannelCodexLogin(provider: string | null | undefined): boolean {
  if (!provider) {
    return false;
  }
  const normalizedProvider = provider.trim().toLowerCase().replace(/_/gu, "-");
  return normalizedProvider === "openai" || normalizedProvider === "codex";
}

export function buildExternalRunFailureReply(
  input: ExternalRunFailureInput,
  options?: {
    includeAuthProfileId?: boolean;
    includeDetails?: boolean;
    isHeartbeat?: boolean;
    replayPrevented?: boolean;
    failoverFacts?: ReplyFailoverFacts;
  },
): ExternalRunFailureReply {
  const message = typeof input === "string" ? input : input.message;
  const error = typeof input === "string" ? undefined : input.error;
  const normalizedMessage = collapseRepeatedFailureDetail(message);
  const failoverFacts =
    options?.failoverFacts ??
    resolveReplyFailoverFacts(error ?? normalizedMessage, normalizedMessage);
  const oauthRefreshFailure = classifyOAuthRefreshFailureError(error);
  if (oauthRefreshFailure) {
    const loginCommand = buildOAuthRefreshFailureLoginCommand(oauthRefreshFailure.provider, {
      profileId: options?.includeAuthProfileId ? oauthRefreshFailure.profileId : undefined,
    });
    const loginCommandMarkdown = formatOAuthRefreshFailureLoginCommandMarkdown(loginCommand);
    const providerText = oauthRefreshFailure.provider ? ` for ${oauthRefreshFailure.provider}` : "";
    const supportsCodexLogin = supportsChannelCodexLogin(oauthRefreshFailure.provider);
    const channelLoginHint = supportsCodexLogin
      ? "Send `/login codex` from a private chat or Web UI session to pair a new Codex login, or re-auth"
      : "Re-auth";
    const retryLoginHint = supportsCodexLogin
      ? "send `/login codex` from a private chat or Web UI session to pair a new Codex login, or re-auth"
      : "re-auth";
    if (oauthRefreshFailure.reason) {
      return {
        text: `⚠️ Model login expired on the gateway${providerText}. ${channelLoginHint} with ${loginCommandMarkdown} in a terminal, then try again.`,
        isGenericRunnerFailure: false,
      };
    }
    return {
      text: `⚠️ Model login failed on the gateway${providerText}. Please try again. If this keeps happening, ${retryLoginHint} with ${loginCommandMarkdown} in a terminal.`,
      isGenericRunnerFailure: false,
    };
  }
  const authProfileFailoverFailure = buildAuthProfileFailoverFailureText(error);
  if (authProfileFailoverFailure) {
    return { text: authProfileFailoverFailure, isGenericRunnerFailure: false };
  }
  const cliMaxTurnsError = findCliMaxTurnsError(error);
  if (cliMaxTurnsError) {
    return {
      text: sanitizeUserFacingText(cliMaxTurnsError.message, { errorContext: true }),
      isGenericRunnerFailure: false,
    };
  }
  const cliBackendTimeoutFailure = buildCliBackendTimeoutFailureText({
    message: normalizedMessage,
    error,
    replayPrevented: options?.replayPrevented,
  });
  if (cliBackendTimeoutFailure) {
    return { text: cliBackendTimeoutFailure, isGenericRunnerFailure: false };
  }
  const providerRequestError = failoverFacts.providerRequestError;
  if (providerRequestError) {
    return { text: providerRequestError.userMessage, isGenericRunnerFailure: false };
  }
  const missingApiKeyFailure = buildMissingApiKeyFailureText({
    message: normalizedMessage,
    error,
  });
  if (missingApiKeyFailure) {
    return { text: missingApiKeyFailure, isGenericRunnerFailure: false };
  }
  if (options?.isHeartbeat) {
    return { text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT, isGenericRunnerFailure: false };
  }
  const codexAppServerFailure = buildCodexAppServerFailureText(normalizedMessage);
  if (codexAppServerFailure) {
    return { text: codexAppServerFailure, isGenericRunnerFailure: false };
  }
  return {
    text: options?.includeDetails
      ? formatForwardedExternalRunFailureText(normalizedMessage)
      : GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
    isGenericRunnerFailure: true,
  };
}

export function markAgentRunFailureReplyPayload<T extends ReplyPayload>(payload: T): T {
  const marked = markReplyPayloadForSourceSuppressionDelivery(payload);
  if (!isSilentReplyText(marked.text, SILENT_REPLY_TOKEN)) {
    marked.isError = true;
  }
  return marked;
}

export function buildTerminalAgentRunFailureReplyPayload(params: {
  isHeartbeat?: boolean;
  visibleReplyDelivered: boolean;
  sessionCtx: ExternalFailureConversationContext;
  cfg?: OpenClawConfig;
}): ReplyPayload {
  const text = params.isHeartbeat
    ? HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT
    : GENERIC_EXTERNAL_RUN_FAILURE_TEXT;
  // Once output is visible, hiding its terminal failure leaves a misleading partial reply.
  // Keep normal group silence only for failures that produced no visible output.
  return markAgentRunFailureReplyPayload({
    text: params.visibleReplyDelivered
      ? text
      : resolveExternalRunFailureTextForConversation({
          text,
          sessionCtx: params.sessionCtx,
          isGenericRunnerFailure: true,
          cfg: params.cfg,
        }),
  });
}

export function buildEmptyInteractiveReplyPayload(params: {
  isInteractive: boolean;
  isHeartbeat?: boolean;
  silentExpected?: boolean;
  allowEmptyAssistantReplyAsSilent?: boolean;
  isMessageToolOnly: boolean;
  hasPendingContinuation: boolean;
  hasExplicitSilentReply: boolean;
  hasCommittedDelivery: boolean;
  sessionCtx: ExternalFailureConversationContext;
  cfg?: OpenClawConfig;
}): ReplyPayload | undefined {
  if (
    !params.isInteractive ||
    params.isHeartbeat === true ||
    params.silentExpected === true ||
    params.allowEmptyAssistantReplyAsSilent === true ||
    params.isMessageToolOnly ||
    params.hasPendingContinuation ||
    params.hasExplicitSilentReply ||
    params.hasCommittedDelivery
  ) {
    return undefined;
  }
  return markAgentRunFailureReplyPayload({
    text: resolveExternalRunFailureTextForConversation({
      text: "I finished the turn, but it did not produce a visible reply. Please try again, or start a new session if this keeps happening.",
      sessionCtx: params.sessionCtx,
      isGenericRunnerFailure: true,
      cfg: params.cfg,
    }),
  });
}

/** Converts known agent-run failures into user-facing reply payloads. */
export function buildKnownAgentRunFailureReplyPayload(params: {
  err: unknown;
  sessionCtx: TemplateContext;
  resolvedVerboseLevel: VerboseLevel | undefined;
  cfg?: OpenClawConfig;
}): ReplyPayload | undefined {
  const message = formatErrorMessage(params.err);
  const failoverFacts = resolveReplyFailoverFacts(params.err, message);
  const fallbackAttempts = readFallbackAttempts(params.err);
  const hasFallbackAttempts = fallbackAttempts.length > 0;
  const isBilling = hasFallbackAttempts
    ? fallbackAttempts.some((attempt) => attempt.reason === "billing")
    : failoverFacts.reason === "billing";
  if (isBilling) {
    return markAgentRunFailureReplyPayload({
      text: resolveExternalRunFailureTextForConversation({
        text: resolveBillingFailureReplyText(params.err),
        sessionCtx: params.sessionCtx,
        isGenericRunnerFailure: false,
        cfg: params.cfg,
      }),
    });
  }

  const preflightCompactionFailureText = buildPreflightCompactionFailureText(message, {
    includeDetails: isVerboseFailureDetailEnabled(params.resolvedVerboseLevel),
  });
  if (preflightCompactionFailureText) {
    return markAgentRunFailureReplyPayload({
      text: resolveExternalRunFailureTextForConversation({
        text: preflightCompactionFailureText,
        sessionCtx: params.sessionCtx,
        isGenericRunnerFailure: false,
        cfg: params.cfg,
      }),
    });
  }

  const isPureTransientSummary = hasFallbackAttempts
    ? fallbackAttempts.every(
        (attempt) => attempt.reason === "rate_limit" || attempt.reason === "overloaded",
      )
    : false;
  const failoverReason = failoverFacts.reason;
  const isOverloaded = hasFallbackAttempts
    ? fallbackAttempts.every((attempt) => attempt.reason === "overloaded")
    : failoverReason === "overloaded";
  const isRateLimit = hasFallbackAttempts
    ? isPureTransientSummary
    : failoverReason === "rate_limit" || failoverReason === "overloaded";
  const rateLimitOrOverloadedCopy =
    !hasFallbackAttempts || isPureTransientSummary
      ? formatRateLimitOrOverloadedErrorCopy(
          isFailoverError(params.err) && failoverReason === "overloaded" ? "overloaded" : message,
        )
      : undefined;

  if (isRateLimit && !isOverloaded) {
    return markAgentRunFailureReplyPayload({
      text: resolveExternalRunFailureTextForConversation({
        text: buildRateLimitCooldownMessage(params.err),
        sessionCtx: params.sessionCtx,
        isGenericRunnerFailure: false,
        cfg: params.cfg,
      }),
    });
  }
  if (rateLimitOrOverloadedCopy) {
    return markAgentRunFailureReplyPayload({
      text: resolveExternalRunFailureTextForConversation({
        text: rateLimitOrOverloadedCopy,
        sessionCtx: params.sessionCtx,
        isGenericRunnerFailure: false,
        cfg: params.cfg,
      }),
    });
  }

  const externalRunFailureReply = buildExternalRunFailureReply(
    { message, error: params.err },
    {
      includeAuthProfileId: !isNonDirectConversationContext(params.sessionCtx),
      includeDetails: isVerboseFailureDetailEnabled(params.resolvedVerboseLevel),
      failoverFacts,
    },
  );
  if (externalRunFailureReply.isGenericRunnerFailure) {
    return undefined;
  }
  return markAgentRunFailureReplyPayload({
    text: resolveExternalRunFailureTextForConversation({
      text: externalRunFailureReply.text,
      sessionCtx: params.sessionCtx,
      isGenericRunnerFailure: false,
      cfg: params.cfg,
    }),
  });
}
