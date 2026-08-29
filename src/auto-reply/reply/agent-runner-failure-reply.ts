import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailure,
  classifyOAuthRefreshFailureError,
  formatOAuthRefreshFailureLoginCommandMarkdown,
} from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { renderUserFacingText } from "../../agents/embedded-agent-helpers/user-facing-text.js";
import { classifyCompactionReason } from "../../agents/embedded-agent-runner/compact-reasons.js";
import {
  describeFailoverError,
  findCliMaxTurnsError,
  findCliTimeoutError,
  isFailoverError,
} from "../../agents/failover-error.js";
import { classifyProviderRequestFacets } from "../../agents/failover/request-error-facets.js";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
  renderAuthProfileFailoverCopy,
  renderBillingReplyCopy,
  renderCliTimeoutReplyCopy,
  renderMissingApiKeyReplyCopy,
  renderRateLimitOrOverloadedCopy,
  renderRateLimitReplyCopy,
  resolveProviderRequestFailureCopy,
  type ReplyFallbackAttempt,
} from "../../agents/failover/user-copy.js";
import { isProviderAuthError } from "../../agents/model-auth-runtime-shared.js";
import { buildProviderAuthRecoveryHint } from "../../agents/provider-auth-recovery-hint.js";
import { resolveSilentReplyPolicy } from "../../config/silent-reply.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { buildCodexLoginRecovery } from "../codex-login-recovery.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";

export function resolveReplyFailoverFacts(error: unknown, message: string) {
  const described = describeFailoverError(error);
  const classification = described.reason
    ? ({ kind: "reason", reason: described.reason } as const)
    : null;
  return {
    reason: classification?.kind === "reason" ? classification.reason : undefined,
    provider: described.provider,
    authMode: described.authMode,
    providerRequestError: resolveProviderRequestFailureCopy({
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

function readFallbackAttempts(error: unknown): readonly ReplyFallbackAttempt[] {
  return isFailoverError(error) && Array.isArray(error.attempts)
    ? (error.attempts as readonly ReplyFallbackAttempt[])
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

const EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS = 900;
const AGENT_FAILED_BEFORE_REPLY_TEXT = "Agent failed before reply:";
const PREFLIGHT_COMPACTION_FAILURE_PREFIX = "Preflight compaction required but failed:";

type ExternalRunFailureReply = Pick<ReplyPayload, "text" | "presentation"> & {
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
  visibleReplyDelivered?: boolean;
}): string {
  // Group silence must not strand an already-visible partial without its terminal failure.
  if (params.visibleReplyDelivered || !isNonDirectConversationContext(params.sessionCtx)) {
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
  const reason = renderUserFacingText(
    normalizedMessage.slice(PREFLIGHT_COMPACTION_FAILURE_PREFIX.length),
    { errorContext: true },
  )
    .trim()
    .replace(/\s+/gu, " ");
  const isTimeout = classifyCompactionReason(reason) === "timeout";
  const reasonSuffix = options?.includeDetails && reason && !isTimeout ? ` Reason: ${reason}.` : "";
  const summary = isTimeout
    ? "⚠️ Context is too large and auto-compaction timed out before it could finish."
    : "⚠️ Context is too large and auto-compaction could not recover this turn.";
  return `${summary}${reasonSuffix} Try again, use /compact, or use /new to start a fresh session.`;
}

export function buildAuthProfileFailoverFailureText(error: unknown): string | null {
  if (!isFailoverError(error) || !error.provider || !error.authProfileFailure) {
    return null;
  }
  return renderAuthProfileFailoverCopy({
    reason: error.reason,
    provider: error.provider,
    allInCooldown: error.authProfileFailure.allInCooldown,
    causeText: error.cause ? formatErrorMessage(error.cause).trim() : undefined,
    recoveryHint: buildProviderAuthRecoveryHint({ provider: error.provider }),
  });
}

function formatForwardedExternalRunFailureText(message: string): string {
  const sanitized = renderUserFacingText(message, { errorContext: true })
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
  const oauthRefreshFailure =
    classifyOAuthRefreshFailureError(error) ?? classifyOAuthRefreshFailure(normalizedMessage);
  const codexLoginRecovery = buildCodexLoginRecovery({
    provider: oauthRefreshFailure?.provider ?? failoverFacts.provider,
    oauthReason: oauthRefreshFailure?.reason,
    failoverReason: failoverFacts.reason,
    authMode: failoverFacts.authMode,
  });
  if (oauthRefreshFailure) {
    const loginCommand = buildOAuthRefreshFailureLoginCommand(oauthRefreshFailure.provider, {
      profileId: options?.includeAuthProfileId ? oauthRefreshFailure.profileId : undefined,
    });
    const loginCommandMarkdown = formatOAuthRefreshFailureLoginCommandMarkdown(loginCommand);
    const providerText = oauthRefreshFailure.provider ? ` for ${oauthRefreshFailure.provider}` : "";
    const retryLoginHint = codexLoginRecovery
      ? "send `/login codex` from a private chat or Web UI session to pair a new Codex login, or re-auth"
      : "re-auth";
    if (oauthRefreshFailure.reason) {
      return {
        text: codexLoginRecovery
          ? `⚠️ ${codexLoginRecovery.hint} You can also re-auth with ${loginCommandMarkdown} on the gateway.`
          : `⚠️ Model login expired on the gateway${providerText}. Re-auth with ${loginCommandMarkdown} in a terminal, then try again.`,
        ...(codexLoginRecovery ? { presentation: codexLoginRecovery.presentation } : {}),
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
    return {
      text: codexLoginRecovery
        ? `${codexLoginRecovery.hint}\n\n${authProfileFailoverFailure}`
        : authProfileFailoverFailure,
      ...(codexLoginRecovery ? { presentation: codexLoginRecovery.presentation } : {}),
      isGenericRunnerFailure: false,
    };
  }
  const cliMaxTurnsError = findCliMaxTurnsError(error);
  if (cliMaxTurnsError) {
    return {
      text: renderUserFacingText(cliMaxTurnsError.message, { errorContext: true }),
      isGenericRunnerFailure: false,
    };
  }
  const cliTimeoutError = findCliTimeoutError(error);
  const cliBackendTimeoutFailure = renderCliTimeoutReplyCopy({
    message: normalizedMessage,
    cliTimeout: cliTimeoutError?.cliTimeout,
    provider: cliTimeoutError?.provider,
    replayPrevented: options?.replayPrevented,
  });
  if (cliBackendTimeoutFailure) {
    return { text: cliBackendTimeoutFailure, isGenericRunnerFailure: false };
  }
  const providerRequestError = failoverFacts.providerRequestError;
  if (providerRequestError) {
    return { text: providerRequestError.userMessage, isGenericRunnerFailure: false };
  }
  const authError = isProviderAuthError(error) ? error : undefined;
  const missingApiKeyFailure = renderMissingApiKeyReplyCopy(
    authError
      ? { provider: authError.provider, providerGuidance: authError.providerGuidance }
      : undefined,
  );
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
  return markAgentRunFailureReplyPayload({
    text: resolveExternalRunFailureTextForConversation({
      ...params,
      text,
      isGenericRunnerFailure: true,
    }),
  });
}

export function buildEmptyInteractiveReplyPayload(params: {
  isInteractive: boolean;
  isHeartbeat?: boolean;
  silentExpected?: boolean;
  allowEmptyAssistantReplyAsSilent?: boolean;
  hasPendingContinuation: boolean;
  hasExplicitSilentReply: boolean;
  hasCommittedDelivery: boolean;
  hasIntentionalTerminalCompletion: boolean;
  sessionCtx: ExternalFailureConversationContext;
  cfg?: OpenClawConfig;
}): ReplyPayload | undefined {
  if (
    !params.isInteractive ||
    params.isHeartbeat === true ||
    params.silentExpected === true ||
    params.allowEmptyAssistantReplyAsSilent === true ||
    params.hasPendingContinuation ||
    params.hasExplicitSilentReply ||
    params.hasCommittedDelivery ||
    params.hasIntentionalTerminalCompletion
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
        text: renderBillingReplyCopy({
          attempts: fallbackAttempts,
          ...(isFailoverError(params.err)
            ? {
                provider: params.err.provider,
                model: params.err.model,
                authMode: params.err.authMode,
              }
            : {}),
        }),
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
    (!hasFallbackAttempts &&
      (failoverReason === "rate_limit" || failoverReason === "overloaded")) ||
    isPureTransientSummary
      ? renderRateLimitOrOverloadedCopy({
          reason: isOverloaded ? "overloaded" : "rate_limit",
          raw: message,
        })
      : undefined;

  if (isRateLimit && !isOverloaded) {
    return markAgentRunFailureReplyPayload({
      text: resolveExternalRunFailureTextForConversation({
        text: renderRateLimitReplyCopy({
          message,
          reason: failoverReason,
          attempts: fallbackAttempts,
          provider: isFailoverError(params.err) ? params.err.provider : undefined,
          cooldownExpiry: isFailoverError(params.err)
            ? params.err.soonestCooldownExpiry
            : undefined,
          sanitizeText: (text) => sanitizeUserFacingText(text, { errorContext: true }),
        }),
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
    ...(externalRunFailureReply.presentation
      ? { presentation: externalRunFailureReply.presentation }
      : {}),
  });
}
