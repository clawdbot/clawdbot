import crypto from "node:crypto";
import fs from "node:fs";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import {
  clearAutoFallbackPrimaryProbeSelection,
  entryMatchesAutoFallbackPrimaryProbe,
  hasSessionAutoModelFallbackProvenance,
  markAutoFallbackPrimaryProbe,
  resolveAutoFallbackPrimaryProbe,
} from "../../agents/agent-scope.js";
import {
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailure,
} from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { runCliAgent } from "../../agents/cli-runner.js";
import { getCliSessionBinding } from "../../agents/cli-session.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/selection.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import { runWithModelFallback, isFallbackSummaryError } from "../../agents/model-fallback.js";
import {
  listLegacyRuntimeModelProviderAliases,
  resolveCliRuntimeExecutionProvider,
} from "../../agents/model-runtime-aliases.js";
import {
  isCliProvider,
  resolveModelRefFromString,
  resolvePersistedOverrideModelRef,
} from "../../agents/model-selection.js";
import { resolveOpenAIRuntimeProviderForPi } from "../../agents/openai-codex-routing.js";
import {
  BILLING_ERROR_USER_MESSAGE,
  formatRateLimitOrOverloadedErrorCopy,
  isCompactionFailureError,
  isContextOverflowError,
  isBillingErrorMessage,
  isLikelyContextOverflowError,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isTransientHttpError,
} from "../../agents/pi-embedded-helpers.js";
import { sanitizeUserFacingText } from "../../agents/pi-embedded-helpers/sanitize-user-facing-text.js";
import { isLikelyExecutionAckPrompt } from "../../agents/pi-embedded-runner/run/incomplete-turn.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { buildAgentRuntimeOutcomePlan } from "../../agents/runtime-plan/build.js";
import {
  resolveGroupSessionKey,
  resolveSessionTranscriptPath,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { resolveSilentReplyPolicy } from "../../config/silent-reply.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { emitAgentEvent, onAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { CommandLaneClearedError, GatewayDrainingError } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { defaultRuntime } from "../../runtime.js";
import {
  hasNonEmptyString,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  readStringValue,
} from "../../shared/string-coerce.js";
import { sanitizeForLog } from "../../terminal/ansi.js";
import {
  isMarkdownCapableMessageChannel,
  resolveMessageChannel,
} from "../../utils/message-channel.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import {
  HEARTBEAT_TOKEN,
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
} from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
} from "./agent-runner-failure-copy.js";
import {
  buildEmbeddedRunExecutionParams,
  resolveQueuedReplyRuntimeConfig,
  resolveModelFallbackOptions,
} from "./agent-runner-utils.js";
import { type BlockReplyPipeline } from "./block-reply-pipeline.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import type { FollowupRun } from "./queue.js";
import { createBlockReplyDeliveryHandler } from "./reply-delivery.js";
import type { ReplyMediaContext } from "./reply-media-paths.js";
import { createReplyMediaContext } from "./reply-media-paths.runtime.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import type { TypingSignaler } from "./typing-mode.js";

// Maximum number of LiveSessionModelSwitchError retries before surfacing a
// user-visible error. Prevents infinite ping-pong when the persisted session
// selection keeps conflicting with fallback model choices.
// See: https://github.com/openclaw/openclaw/issues/58348
export const MAX_LIVE_SWITCH_RETRIES = 2;
const GPT_CHAT_BREVITY_ACK_MAX_CHARS = 420;
const GPT_CHAT_BREVITY_ACK_MAX_SENTENCES = 3;
const GPT_CHAT_BREVITY_SOFT_MAX_CHARS = 900;
const GPT_CHAT_BREVITY_SOFT_MAX_SENTENCES = 6;

function shouldBridgeCliAssistantTextToReasoning(provider: string): boolean {
  return normalizeLowercaseStringOrEmpty(provider) === "claude-cli";
}

function readApprovalScopeValue(value: unknown): "turn" | "session" | undefined {
  return value === "turn" || value === "session" ? value : undefined;
}

export type RuntimeFallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: string;
  status?: number;
  code?: string;
};

export type AgentRunLoopResult =
  | {
      kind: "success";
      runId: string;
      runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
      fallbackProvider?: string;
      fallbackModel?: string;
      fallbackAttempts: RuntimeFallbackAttempt[];
      didLogHeartbeatStrip: boolean;
      autoCompactionCount: number;
      /** Payload keys sent directly (not via pipeline) during tool flush. */
      directlySentBlockKeys?: Set<string>;
    }
  | { kind: "final"; payload: ReplyPayload };

type EmbeddedAgentRunResult = Awaited<ReturnType<typeof runEmbeddedPiAgent>>;

type FallbackSelectionState = Pick<
  SessionEntry,
  | "providerOverride"
  | "modelOverride"
  | "modelOverrideSource"
  | "modelOverrideFallbackOriginProvider"
  | "modelOverrideFallbackOriginModel"
  | "authProfileOverride"
  | "authProfileOverrideSource"
  | "authProfileOverrideCompactionCount"
>;

const FALLBACK_SELECTION_STATE_KEYS = [
  "providerOverride",
  "modelOverride",
  "modelOverrideSource",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
] as const satisfies ReadonlyArray<keyof FallbackSelectionState>;

function setFallbackSelectionStateField(
  entry: SessionEntry,
  key: keyof FallbackSelectionState,
  value: FallbackSelectionState[keyof FallbackSelectionState],
): boolean {
  switch (key) {
    case "providerOverride":
      if (entry.providerOverride !== value) {
        entry.providerOverride = value as SessionEntry["providerOverride"];
        return true;
      }
      return false;
    case "modelOverride":
      if (entry.modelOverride !== value) {
        entry.modelOverride = value as SessionEntry["modelOverride"];
        return true;
      }
      return false;
    case "modelOverrideSource":
      if (entry.modelOverrideSource !== value) {
        entry.modelOverrideSource = value as SessionEntry["modelOverrideSource"];
        return true;
      }
      return false;
    case "modelOverrideFallbackOriginProvider":
      if (entry.modelOverrideFallbackOriginProvider !== value) {
        entry.modelOverrideFallbackOriginProvider =
          value as SessionEntry["modelOverrideFallbackOriginProvider"];
        return true;
      }
      return false;
    case "modelOverrideFallbackOriginModel":
      if (entry.modelOverrideFallbackOriginModel !== value) {
        entry.modelOverrideFallbackOriginModel =
          value as SessionEntry["modelOverrideFallbackOriginModel"];
        return true;
      }
      return false;
    case "authProfileOverride":
      if (entry.authProfileOverride !== value) {
        entry.authProfileOverride = value as SessionEntry["authProfileOverride"];
        return true;
      }
      return false;
    case "authProfileOverrideSource":
      if (entry.authProfileOverrideSource !== value) {
        entry.authProfileOverrideSource = value as SessionEntry["authProfileOverrideSource"];
        return true;
      }
      return false;
    case "authProfileOverrideCompactionCount":
      if (entry.authProfileOverrideCompactionCount !== value) {
        entry.authProfileOverrideCompactionCount =
          value as SessionEntry["authProfileOverrideCompactionCount"];
        return true;
      }
      return false;
  }
  throw new Error("Unsupported fallback selection state key");
}

function snapshotFallbackSelectionState(entry: SessionEntry): FallbackSelectionState {
  return {
    providerOverride: entry.providerOverride,
    modelOverride: entry.modelOverride,
    modelOverrideSource: entry.modelOverrideSource,
    modelOverrideFallbackOriginProvider: entry.modelOverrideFallbackOriginProvider,
    modelOverrideFallbackOriginModel: entry.modelOverrideFallbackOriginModel,
    authProfileOverride: entry.authProfileOverride,
    authProfileOverrideSource: entry.authProfileOverrideSource,
    authProfileOverrideCompactionCount: entry.authProfileOverrideCompactionCount,
  };
}

function buildFallbackSelectionState(params: {
  provider: string;
  model: string;
  originProvider: string;
  originModel: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
}): FallbackSelectionState {
  return {
    providerOverride: params.provider,
    modelOverride: params.model,
    modelOverrideSource: "auto",
    modelOverrideFallbackOriginProvider: params.originProvider,
    modelOverrideFallbackOriginModel: params.originModel,
    authProfileOverride: params.authProfileId,
    authProfileOverrideSource: params.authProfileId ? params.authProfileIdSource : undefined,
    authProfileOverrideCompactionCount: undefined,
  };
}

function resolveFallbackSelectionOrigin(params: { entry: SessionEntry; run: FollowupRun["run"] }): {
  provider: string;
  model: string;
} {
  if (
    params.entry.modelOverrideSource === "auto" ||
    (params.entry.modelOverrideSource === undefined &&
      hasSessionAutoModelFallbackProvenance(params.entry))
  ) {
    const persistedOriginProvider = normalizeOptionalString(
      params.entry.modelOverrideFallbackOriginProvider,
    );
    const persistedOriginModel = normalizeOptionalString(
      params.entry.modelOverrideFallbackOriginModel,
    );
    if (persistedOriginProvider && persistedOriginModel) {
      return { provider: persistedOriginProvider, model: persistedOriginModel };
    }
  }
  return { provider: params.run.provider, model: params.run.model };
}

export function applyFallbackCandidateSelectionToEntry(params: {
  entry: SessionEntry;
  run: FollowupRun["run"];
  provider: string;
  model: string;
  origin?: { provider: string; model: string };
  force?: boolean;
  now?: number;
}): { updated: boolean; nextState?: FallbackSelectionState } {
  if (
    !params.force &&
    params.provider === params.run.provider &&
    params.model === params.run.model
  ) {
    return { updated: false };
  }
  const scopedAuthProfile = resolveRunAuthProfile(params.run, params.provider);
  const origin =
    params.origin ?? resolveFallbackSelectionOrigin({ entry: params.entry, run: params.run });
  const nextState = buildFallbackSelectionState({
    provider: params.provider,
    model: params.model,
    originProvider: origin.provider,
    originModel: origin.model,
    authProfileId: scopedAuthProfile.authProfileId,
    authProfileIdSource: scopedAuthProfile.authProfileIdSource,
  });
  return {
    updated: applyFallbackSelectionState(params.entry, nextState, params.now),
    nextState,
  };
}

function applyFallbackSelectionState(
  entry: SessionEntry,
  nextState: FallbackSelectionState,
  now = Date.now(),
): boolean {
  let updated = false;
  for (const key of FALLBACK_SELECTION_STATE_KEYS) {
    const nextValue = nextState[key];
    if (nextValue === undefined) {
      if (Object.hasOwn(entry, key)) {
        delete entry[key];
        updated = true;
      }
      continue;
    }
    if (entry[key] !== nextValue) {
      updated = setFallbackSelectionStateField(entry, key, nextValue) || updated;
    }
  }
  if (updated) {
    entry.updatedAt = now;
  }
  return updated;
}

function rollbackFallbackSelectionStateIfUnchanged(
  entry: SessionEntry,
  expectedState: FallbackSelectionState,
  previousState: FallbackSelectionState,
  now = Date.now(),
): boolean {
  let updated = false;
  for (const key of FALLBACK_SELECTION_STATE_KEYS) {
    if (entry[key] !== expectedState[key]) {
      continue;
    }
    const previousValue = previousState[key];
    if (previousValue === undefined) {
      if (Object.hasOwn(entry, key)) {
        delete entry[key];
        updated = true;
      }
      continue;
    }
    if (entry[key] !== previousValue) {
      updated = setFallbackSelectionStateField(entry, key, previousValue) || updated;
    }
  }
  if (updated) {
    entry.updatedAt = now;
  }
  return updated;
}

/**
 * Build a human-friendly rate-limit message from a FallbackSummaryError.
 * Includes a countdown when the soonest cooldown expiry is known.
 */
function buildRateLimitCooldownMessage(err: unknown): string {
  const codexUsageLimitMessage = extractCodexUsageLimitErrorMessage(err);
  if (codexUsageLimitMessage) {
    return codexUsageLimitMessage;
  }
  if (!isFallbackSummaryError(err)) {
    return "⚠️ All models are temporarily rate-limited. Please try again in a few minutes.";
  }
  const expiry = err.soonestCooldownExpiry;
  const now = Date.now();
  if (typeof expiry === "number" && expiry > now) {
    const secsLeft = Math.max(1, Math.ceil((expiry - now) / 1000));
    if (secsLeft <= 60) {
      return `⚠️ Rate-limited — ready in ~${secsLeft}s. Please wait a moment.`;
    }
    const minsLeft = Math.ceil(secsLeft / 60);
    return `⚠️ Rate-limited — ready in ~${minsLeft} min. Please try again shortly.`;
  }
  return "⚠️ All models are temporarily rate-limited. Please try again in a few minutes.";
}

function extractCodexUsageLimitErrorMessage(err: unknown): string | undefined {
  if (isFallbackSummaryError(err)) {
    for (const attempt of err.attempts) {
      const message = extractCodexUsageLimitMessage(attempt.error);
      if (message) {
        return `⚠️ ${message}`;
      }
    }
    return undefined;
  }
  const message = extractCodexUsageLimitMessage(formatErrorMessage(err));
  return message ? `⚠️ ${message}` : undefined;
}

function extractCodexUsageLimitMessage(text: string): string | undefined {
  const markers = [
    "You've reached your Codex subscription usage limit.",
    "Codex usage limit reached.",
  ];
  let markerIndex: number | undefined;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index >= 0 && (markerIndex === undefined || index < markerIndex)) {
      markerIndex = index;
    }
  }
  if (markerIndex === undefined) {
    return undefined;
  }
  const message = sanitizeUserFacingText(text.slice(markerIndex), { errorContext: true })
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!message) {
    return undefined;
  }
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

function isPureTransientRateLimitSummary(err: unknown): boolean {
  return (
    isFallbackSummaryError(err) &&
    err.attempts.length > 0 &&
    err.attempts.every((attempt) => {
      const reason = attempt.reason;
      return reason === "rate_limit" || reason === "overloaded";
    })
  );
}

function isPureBillingSummary(err: unknown): boolean {
  return (
    isFallbackSummaryError(err) &&
    err.attempts.length > 0 &&
    err.attempts.every((attempt) => attempt.reason === "billing")
  );
}

function isToolResultTurnMismatchError(message: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(message);
  return (
    lower.includes("toolresult") &&
    lower.includes("tooluse") &&
    lower.includes("exceeds the number") &&
    lower.includes("previous turn")
  );
}

function collapseRepeatedFailureDetail(message: string): string {
  const parts = message
    .split(/\s+\|\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2 && parts.every((part) => part === parts[0])) {
    return parts[0];
  }
  return message.trim();
}

const SAFE_MISSING_API_KEY_PROVIDERS = new Set(["anthropic", "google", "openai", "openai-codex"]);
const EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS = 900;
const AGENT_FAILED_BEFORE_REPLY_TEXT = "Agent failed before reply:";

type ExternalRunFailureReply = {
  text: string;
  isGenericRunnerFailure: boolean;
};

function isNonDirectConversationContext(ctx: TemplateContext): boolean {
  const chatType = normalizeLowercaseStringOrEmpty(ctx.ChatType);
  return chatType === "group" || chatType === "channel";
}

function isVerboseFailureDetailEnabled(level: VerboseLevel | undefined): boolean {
  return level === "on" || level === "full";
}

function resolveExternalRunFailureTextForConversation(params: {
  text: string;
  sessionCtx: TemplateContext;
  isGenericRunnerFailure: boolean;
  cfg?: OpenClawConfig;
}): string {
  if (!isNonDirectConversationContext(params.sessionCtx)) {
    return params.text;
  }
  if (!params.isGenericRunnerFailure && !params.text.includes(AGENT_FAILED_BEFORE_REPLY_TEXT)) {
    return params.text;
  }
  // Match normal reply routing: default group/channel failures stay silent,
  // while explicit default or per-surface policy can surface the failure copy.
  const silentPolicy = resolveSilentReplyPolicy({
    cfg: params.cfg,
    sessionKey: params.sessionCtx.SessionKey,
    surface: params.sessionCtx.Surface ?? params.sessionCtx.Provider,
    conversationType: "group",
  });
  if (silentPolicy === "disallow") {
    return params.text;
  }
  return SILENT_REPLY_TOKEN;
}

const CLI_BACKEND_NO_OUTPUT_STALL_RE =
  /\bCLI produced no output for\s+(\d+)\s*s\s+and was terminated\b/iu;
const CLI_BACKEND_OVERALL_TIMEOUT_RE =
  /\bCLI exceeded timeout\s*\(\s*(\d+)\s*s\s*\)\s+and was terminated\b/iu;
const CLI_BACKEND_ROUTING_REF_BEFORE_ERROR_RE = /\b([\w.-]+\/[A-Za-z][\w.-]*)\s*:\s*CLI\b/iu;

function buildCliBackendTimeoutFailureText(message: string): string | null {
  const normalizedMessage = collapseRepeatedFailureDetail(message);
  const stall = normalizedMessage.match(CLI_BACKEND_NO_OUTPUT_STALL_RE);
  const overall = normalizedMessage.match(CLI_BACKEND_OVERALL_TIMEOUT_RE);
  const timeout = stall ?? overall;
  const seconds = timeout?.[1];
  if (!seconds) {
    return null;
  }
  const routedModelRef = normalizedMessage.match(CLI_BACKEND_ROUTING_REF_BEFORE_ERROR_RE)?.[1];
  const routingSuffix = routedModelRef ? ` (routing ${routedModelRef})` : "";
  const modeLabel = stall ? "no-output stall" : "overall CLI turn budget";
  return (
    `⚠️ CLI subprocess${routingSuffix}: timed out after ${seconds}s (${modeLabel}). The gateway may still be healthy. Try \`/new\`, a lighter model, or raise ` +
    "`agents.defaults.timeoutSeconds` and the watchdog `noOutputTimeoutMs` entries under `cliBackends.<your-runtime>`."
  );
}

function buildMissingApiKeyFailureText(message: string): string | null {
  const normalizedMessage = collapseRepeatedFailureDetail(message);
  const providerMatch = normalizedMessage.match(/No API key found for provider "([^"]+)"/u);
  const provider = providerMatch?.[1]?.trim().toLowerCase();
  if (!provider) {
    return null;
  }
  if (provider === "openai" && normalizedMessage.includes("OpenAI Codex OAuth")) {
    return "⚠️ Missing API key for OpenAI on the gateway. Use `openai/gpt-5.5` with the Codex OAuth profile, or set `OPENAI_API_KEY` for direct OpenAI API-key runs.";
  }
  if (SAFE_MISSING_API_KEY_PROVIDERS.has(provider)) {
    return `⚠️ Missing API key for provider "${provider}". Configure the gateway auth for that provider, then try again.`;
  }
  return "⚠️ Missing API key for the selected provider on the gateway. Configure provider auth, then try again.";
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
      ? `${sanitized.slice(0, EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS - 1).trimEnd()}…`
      : sanitized;
  const suffix = /[.!?]$/u.test(detail) ? "" : ".";
  return `⚠️ Agent failed before reply: ${detail}${suffix} Please try again, or use /new to start a fresh session.`;
}

function buildExternalRunFailureReply(
  message: string,
  options?: { includeDetails?: boolean; isHeartbeat?: boolean },
): ExternalRunFailureReply {
  const normalizedMessage = collapseRepeatedFailureDetail(message);
  const missingApiKeyFailure = buildMissingApiKeyFailureText(normalizedMessage);
  if (missingApiKeyFailure) {
    return { text: missingApiKeyFailure, isGenericRunnerFailure: false };
  }
  const oauthRefreshFailure = classifyOAuthRefreshFailure(normalizedMessage);
  if (oauthRefreshFailure) {
    const loginCommand = buildOAuthRefreshFailureLoginCommand(oauthRefreshFailure.provider);
    if (oauthRefreshFailure.reason) {
      return {
        text: `⚠️ Model login expired on the gateway${oauthRefreshFailure.provider ? ` for ${oauthRefreshFailure.provider}` : ""}. Re-auth with \`${loginCommand}\`, then try again.`,
        isGenericRunnerFailure: false,
      };
    }
    return {
      text: `⚠️ Model login failed on the gateway${oauthRefreshFailure.provider ? ` for ${oauthRefreshFailure.provider}` : ""}. Please try again. If this keeps happening, re-auth with \`${loginCommand}\`.`,
      isGenericRunnerFailure: false,
    };
  }
  if (options?.isHeartbeat) {
    return { text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT, isGenericRunnerFailure: false };
  }
  if (isToolResultTurnMismatchError(normalizedMessage)) {
    return {
      text: "⚠️ Session history got out of sync. Please try again, or use /new to start a fresh session.",
      isGenericRunnerFailure: false,
    };
  }
  const cliBackendTimeoutFailure = buildCliBackendTimeoutFailureText(normalizedMessage);
  if (cliBackendTimeoutFailure) {
    return { text: cliBackendTimeoutFailure, isGenericRunnerFailure: false };
  }
  return {
    text: options?.includeDetails
      ? formatForwardedExternalRunFailureText(normalizedMessage)
      : GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
    isGenericRunnerFailure: true,
  };
}

function markAgentRunFailureReplyPayload<T extends ReplyPayload>(payload: T): T {
  return markReplyPayloadForSourceSuppressionDelivery(payload);
}

export function buildKnownAgentRunFailureReplyPayload(params: {
  err: unknown;
  sessionCtx: TemplateContext;
  resolvedVerboseLevel: VerboseLevel | undefined;
  cfg?: OpenClawConfig;
}): ReplyPayload | undefined {
  const message = formatErrorMessage(params.err);
  const isFallbackSummary = isFallbackSummaryError(params.err);
  const isBilling = isFallbackSummary
    ? isPureBillingSummary(params.err)
    : isBillingErrorMessage(message);
  if (isBilling) {
    return markAgentRunFailureReplyPayload({
      text: resolveExternalRunFailureTextForConversation({
        text: BILLING_ERROR_USER_MESSAGE,
        sessionCtx: params.sessionCtx,
        isGenericRunnerFailure: false,
        cfg: params.cfg,
      }),
    });
  }

  const isPureTransientSummary = isFallbackSummary
    ? isPureTransientRateLimitSummary(params.err)
    : false;
  const isRateLimit = isFallbackSummary ? isPureTransientSummary : isRateLimitErrorMessage(message);
  const rateLimitOrOverloadedCopy =
    !isFallbackSummary || isPureTransientSummary
      ? formatRateLimitOrOverloadedErrorCopy(message)
      : undefined;

  if (isRateLimit && !isOverloadedErrorMessage(message)) {
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

  const externalRunFailureReply = buildExternalRunFailureReply(message, {
    includeDetails: isVerboseFailureDetailEnabled(params.resolvedVerboseLevel),
  });
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

const CONTEXT_OVERFLOW_RESET_HINT =
  "\n\nTo prevent this, increase your compaction buffer by setting " +
  "`agents.defaults.compaction.reserveTokensFloor` to 20000 or higher in your config.";

type ModelRefLike = {
  provider: string;
  model: string;
};

function resolveAgentHeartbeatModelRaw(params: {
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
}): string | undefined {
  const defaultModel = normalizeOptionalString(params.cfg.agents?.defaults?.heartbeat?.model);
  const agentId = normalizeLowercaseStringOrEmpty(params.agentId);
  const agentModel = agentId
    ? normalizeOptionalString(
        params.cfg.agents?.list?.find(
          (entry) => normalizeLowercaseStringOrEmpty(entry?.id) === agentId,
        )?.heartbeat?.model,
      )
    : undefined;
  return agentModel ?? defaultModel;
}

function normalizeModelRefForCompare(ref: ModelRefLike | undefined) {
  if (!ref) {
    return undefined;
  }
  const provider = normalizeLowercaseStringOrEmpty(ref.provider);
  const model = normalizeLowercaseStringOrEmpty(ref.model);
  return provider && model ? { provider, model } : undefined;
}

function modelRefsEqual(left: ModelRefLike | undefined, right: ModelRefLike | undefined) {
  const normalizedLeft = normalizeModelRefForCompare(left);
  const normalizedRight = normalizeModelRefForCompare(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  return (
    normalizedLeft.provider === normalizedRight.provider &&
    normalizedLeft.model === normalizedRight.model
  );
}

function formatContextWindowLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Math.round((tokens / 1_000_000) * 10) / 10}M`;
  }
  return `${Math.round(tokens / 1024)}k`;
}

function resolveContextWindowForHint(params: {
  cfg: FollowupRun["run"]["config"];
  ref: ModelRefLike;
  activeSessionEntry?: SessionEntry;
}) {
  const activeContextTokens =
    typeof params.activeSessionEntry?.contextTokens === "number" &&
    Number.isFinite(params.activeSessionEntry.contextTokens) &&
    params.activeSessionEntry.contextTokens > 0
      ? Math.floor(params.activeSessionEntry.contextTokens)
      : undefined;
  return (
    activeContextTokens ??
    resolveContextTokensForModel({
      cfg: params.cfg,
      provider: params.ref.provider,
      model: params.ref.model,
      allowAsyncLoad: false,
    })
  );
}

function resolveHeartbeatBleedHint(params: {
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
  primaryProvider?: string;
  primaryModel?: string;
  activeSessionEntry?: SessionEntry;
}): string | undefined {
  const primaryProvider = normalizeOptionalString(params.primaryProvider);
  const primaryModel = normalizeOptionalString(params.primaryModel);
  if (!primaryProvider || !primaryModel) {
    return undefined;
  }

  const runtimeProvider = normalizeOptionalString(params.activeSessionEntry?.modelProvider);
  const runtimeModel = normalizeOptionalString(params.activeSessionEntry?.model);
  if (!runtimeProvider || !runtimeModel) {
    return undefined;
  }

  const primaryRef = { provider: primaryProvider, model: primaryModel };
  const runtimeRef = { provider: runtimeProvider, model: runtimeModel };
  if (modelRefsEqual(primaryRef, runtimeRef)) {
    return undefined;
  }

  const heartbeatModelRaw = resolveAgentHeartbeatModelRaw({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const heartbeatRef = heartbeatModelRaw
    ? resolveModelRefFromString({
        cfg: params.cfg,
        raw: heartbeatModelRaw,
        defaultProvider: primaryProvider,
      })?.ref
    : undefined;
  if (!modelRefsEqual(runtimeRef, heartbeatRef)) {
    return undefined;
  }

  const runtimeWindow = resolveContextWindowForHint({
    cfg: params.cfg,
    ref: runtimeRef,
    activeSessionEntry: params.activeSessionEntry,
  });
  const primaryWindow = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: primaryRef.provider,
    model: primaryRef.model,
    allowAsyncLoad: false,
  });
  if (
    typeof runtimeWindow === "number" &&
    typeof primaryWindow === "number" &&
    runtimeWindow >= primaryWindow
  ) {
    return undefined;
  }

  const runtimeLabel =
    typeof runtimeWindow === "number" && runtimeWindow > 0
      ? ` (${formatContextWindowLabel(runtimeWindow)} context)`
      : "";
  return (
    `\n\nThe previous heartbeat turn left this session on ${runtimeProvider}/${runtimeModel}` +
    `${runtimeLabel} instead of ${primaryProvider}/${primaryModel}. This matches the configured ` +
    "`heartbeat.model`, so the overflow is likely heartbeat model bleed rather than a " +
    "compaction-buffer problem. Set `heartbeat.isolatedSession: true`, enable " +
    "`heartbeat.lightContext: true`, or use a heartbeat model with a larger context window."
  );
}

export function buildContextOverflowRecoveryText(params: {
  duringCompaction?: boolean;
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
  primaryProvider?: string;
  primaryModel?: string;
  activeSessionEntry?: SessionEntry;
}): string {
  const prefix = params.duringCompaction
    ? "⚠️ Context limit exceeded during compaction. I've reset our conversation to start fresh - please try again."
    : "⚠️ Context limit exceeded. I've reset our conversation to start fresh - please try again.";
  return (
    prefix +
    (resolveHeartbeatBleedHint({
      cfg: params.cfg,
      agentId: params.agentId,
      primaryProvider: params.primaryProvider,
      primaryModel: params.primaryModel,
      activeSessionEntry: params.activeSessionEntry,
    }) ?? CONTEXT_OVERFLOW_RESET_HINT)
  );
}

function shouldApplyOpenAIGptChatGuard(params: { provider?: string; model?: string }): boolean {
  if (params.provider !== "openai" && params.provider !== "openai-codex") {
    return false;
  }
  return /^gpt-5(?:[.-]|$)/i.test(params.model ?? "");
}

function countChatReplySentences(text: string): number {
  return text
    .trim()
    .split(/(?<=[.!?])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

function scoreChattyFinalReplyText(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  let score = 0;
  const sentenceCount = countChatReplySentences(trimmed);
  if (trimmed.length > 900) {
    score += 1;
  }
  if (trimmed.length > 1_500) {
    score += 1;
  }
  if (sentenceCount > 6) {
    score += 1;
  }
  if (sentenceCount > 10) {
    score += 1;
  }
  if (trimmed.split(/\n{2,}/u).filter(Boolean).length >= 3) {
    score += 1;
  }
  if (
    /\b(?:in summary|to summarize|here(?:'s| is) what|what changed|what I verified)\b/i.test(
      trimmed,
    )
  ) {
    score += 1;
  }
  return score;
}

function shortenChattyFinalReplyText(
  text: string,
  params: { maxChars: number; maxSentences: number },
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  const sentences = trimmed
    .split(/(?<=[.!?])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  let shortened = sentences.slice(0, params.maxSentences).join(" ");
  if (!shortened) {
    shortened = trimmed.slice(0, params.maxChars).trimEnd();
  }
  if (shortened.length > params.maxChars) {
    shortened = shortened.slice(0, params.maxChars).trimEnd();
  }
  if (shortened.length >= trimmed.length) {
    return trimmed;
  }
  return shortened.replace(/[.,;:!?-]*$/u, "").trimEnd() + "...";
}

function applyOpenAIGptChatReplyGuard(params: {
  provider?: string;
  model?: string;
  commandBody: string;
  isHeartbeat: boolean;
  payloads?: ReplyPayload[];
}): void {
  if (
    params.isHeartbeat ||
    !shouldApplyOpenAIGptChatGuard({
      provider: params.provider,
      model: params.model,
    }) ||
    !params.payloads?.length
  ) {
    return;
  }

  const trimmedCommand = params.commandBody.trim();
  const isAckTurn = isLikelyExecutionAckPrompt(trimmedCommand);
  const allowSoftCap =
    !isAckTurn &&
    trimmedCommand.length > 0 &&
    trimmedCommand.length <= 120 &&
    !/\b(?:detail|detailed|depth|deep dive|explain|compare|walk me through|why|how)\b/i.test(
      trimmedCommand,
    );

  for (const payload of params.payloads) {
    const text = normalizeOptionalString(payload.text);
    if (
      !text ||
      payload.isError ||
      payload.isReasoning ||
      payload.mediaUrl ||
      (payload.mediaUrls?.length ?? 0) > 0 ||
      payload.interactive ||
      text.includes("```")
    ) {
      continue;
    }

    if (isAckTurn) {
      payload.text = shortenChattyFinalReplyText(text, {
        maxChars: GPT_CHAT_BREVITY_ACK_MAX_CHARS,
        maxSentences: GPT_CHAT_BREVITY_ACK_MAX_SENTENCES,
      });
      continue;
    }

    if (allowSoftCap && scoreChattyFinalReplyText(text) >= 4) {
      payload.text = shortenChattyFinalReplyText(text, {
        maxChars: GPT_CHAT_BREVITY_SOFT_MAX_CHARS,
        maxSentences: GPT_CHAT_BREVITY_SOFT_MAX_SENTENCES,
      });
    }
  }
}

function buildRestartLifecycleReplyText(): string {
  return "⚠️ Gateway is restarting. Please wait a few seconds and try again.";
}

function resolveRestartLifecycleError(
  err: unknown,
): GatewayDrainingError | CommandLaneClearedError | undefined {
  const pending = [err];
  const seen = new Set<unknown>();

  let pendingIndex = 0;
  while (pendingIndex < pending.length) {
    const candidate = pending[pendingIndex++];
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    if (candidate instanceof GatewayDrainingError || candidate instanceof CommandLaneClearedError) {
      return candidate;
    }

    if (isFallbackSummaryError(candidate)) {
      for (const attempt of candidate.attempts) {
        pending.push(attempt.error);
      }
    }

    if (candidate instanceof Error && "cause" in candidate) {
      pending.push(candidate.cause);
    }
  }

  return undefined;
}

function isReplyOperationUserAbort(replyOperation?: ReplyOperation): boolean {
  return (
    replyOperation?.result?.kind === "aborted" && replyOperation.result.code === "aborted_by_user"
  );
}

function isReplyOperationRestartAbort(replyOperation?: ReplyOperation): boolean {
  return (
    replyOperation?.result?.kind === "aborted" &&
    replyOperation.result.code === "aborted_for_restart"
  );
}

function createEmbeddedLifecycleTerminalBackstop(params: { runId: string; sessionKey?: string }) {
  let terminalEmitted = false;
  let startedAt: number | undefined;

  const note = (evt: { stream: string; data: Record<string, unknown> }) => {
    if (evt.stream !== "lifecycle") {
      return;
    }
    const phase = readStringValue(evt.data.phase);
    if (phase === "start" && typeof evt.data.startedAt === "number") {
      startedAt = evt.data.startedAt;
    }
    if (phase === "end" || phase === "error") {
      terminalEmitted = true;
    }
  };

  const emit = (phase: "end" | "error", resultOrError: unknown) => {
    if (terminalEmitted) {
      return;
    }
    terminalEmitted = true;
    const data: Record<string, unknown> = {
      phase,
      endedAt: Date.now(),
      ...(startedAt !== undefined ? { startedAt } : {}),
    };
    if (phase === "error") {
      data.error = formatErrorMessage(resultOrError);
    } else {
      const meta =
        resultOrError && typeof resultOrError === "object" && "meta" in resultOrError
          ? (resultOrError as { meta?: Record<string, unknown> }).meta
          : undefined;
      if (meta?.aborted === true) {
        data.aborted = true;
      }
      const stopReason = readStringValue(meta?.stopReason);
      if (stopReason) {
        data.stopReason = stopReason;
      }
      const livenessState = readStringValue(meta?.livenessState);
      if (livenessState) {
        data.livenessState = livenessState;
      }
      if (meta?.replayInvalid === true) {
        data.replayInvalid = true;
      }
    }
    emitAgentEvent({
      runId: params.runId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      stream: "lifecycle",
      data,
    });
  };

  return { emit, note };
}

function emitModelFallbackStepLifecycle(params: {
  runId: string;
  sessionKey?: string;
  step: Record<string, unknown>;
}) {
  emitAgentEvent({
    runId: params.runId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    stream: "lifecycle",
    data: {
      phase: "fallback_step",
      ...params.step,
    },
  });
}

function resolveSessionRuntimeOverrideForProvider(params: {
  provider: string;
  entry?: Pick<SessionEntry, "agentRuntimeOverride">;
}): string | undefined {
  const provider = normalizeLowercaseStringOrEmpty(params.provider);
  const runtime = normalizeLowercaseStringOrEmpty(params.entry?.agentRuntimeOverride);
  if (!runtime || runtime === "auto" || runtime === "default") {
    return undefined;
  }
  if (runtime === "pi") {
    return "pi";
  }
  if (provider === "openai" && runtime === "codex") {
    return "codex";
  }
  return listLegacyRuntimeModelProviderAliases().find(
    (alias) =>
      normalizeLowercaseStringOrEmpty(alias.provider) === provider &&
      normalizeLowercaseStringOrEmpty(alias.runtime) === runtime,
  )?.runtime;
}

export function resolveRunAfterAutoFallbackPrimaryProbeRecheck(params: {
  run: FollowupRun["run"];
  entry?: SessionEntry;
  sessionKey?: string;
}): FollowupRun["run"] {
  const probe = params.run.autoFallbackPrimaryProbe;
  if (!probe || !params.sessionKey) {
    return params.run;
  }
  if (!params.entry) {
    return params.run;
  }
  const resolveEntrySelectionRun = (): FollowupRun["run"] => {
    const entryRef = resolvePersistedOverrideModelRef({
      defaultProvider: params.run.provider,
      overrideProvider: params.entry?.providerOverride,
      overrideModel: params.entry?.modelOverride,
    });
    const hasEntryModelOverride = Boolean(entryRef);
    const authProfileId = normalizeOptionalString(params.entry?.authProfileOverride);
    const fallbackRun: FollowupRun["run"] = {
      ...params.run,
      provider: entryRef?.provider ?? params.run.provider,
      model: entryRef?.model ?? params.run.model,
      autoFallbackPrimaryProbe: undefined,
    };
    if (hasEntryModelOverride) {
      fallbackRun.hasSessionModelOverride = true;
      fallbackRun.hasAutoFallbackProvenance =
        hasSessionAutoModelFallbackProvenance(params.entry) || undefined;
    } else {
      delete fallbackRun.hasSessionModelOverride;
      delete fallbackRun.hasAutoFallbackProvenance;
    }
    if (hasEntryModelOverride && params.entry?.modelOverrideSource) {
      fallbackRun.modelOverrideSource = params.entry.modelOverrideSource;
    } else {
      delete fallbackRun.modelOverrideSource;
    }
    if (hasEntryModelOverride && authProfileId) {
      fallbackRun.authProfileId = authProfileId;
      if (params.entry?.authProfileOverrideSource) {
        fallbackRun.authProfileIdSource = params.entry.authProfileOverrideSource;
      } else {
        delete fallbackRun.authProfileIdSource;
      }
    } else if (hasEntryModelOverride) {
      delete fallbackRun.authProfileId;
      delete fallbackRun.authProfileIdSource;
    }
    return fallbackRun;
  };
  const refreshedProbe = resolveAutoFallbackPrimaryProbe({
    entry: params.entry,
    sessionKey: params.sessionKey,
    primaryProvider: probe.provider,
    primaryModel: probe.model,
  });
  if (!refreshedProbe) {
    return resolveEntrySelectionRun();
  }
  return {
    ...params.run,
    provider: refreshedProbe.provider,
    model: refreshedProbe.model,
    autoFallbackPrimaryProbe: refreshedProbe,
  };
}

export async function runAgentTurnWithFallback(params: {
  commandBody: string;
  transcriptCommandBody?: string;
  followupRun: FollowupRun;
  sessionCtx: TemplateContext;
  replyThreading?: TemplateContext["ReplyThreading"];
  replyOperation?: ReplyOperation;
  opts?: GetReplyOptions;
  typingSignals: TypingSignaler;
  blockReplyPipeline: BlockReplyPipeline | null;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  pendingToolTasks: Set<Promise<void>>;
  resetSessionAfterCompactionFailure: (reason: string) => Promise<boolean>;
  resetSessionAfterRoleOrderingConflict: (reason: string) => Promise<boolean>;
  isHeartbeat: boolean;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  getActiveSessionEntry: () => SessionEntry | undefined;
  activeSessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
  toolProgressDetail?: "explain" | "raw";
  replyMediaContext?: ReplyMediaContext;
}): Promise<AgentRunLoopResult> {
  const TRANSIENT_HTTP_RETRY_DELAY_MS = 2_500;
  let didLogHeartbeatStrip = false;
  let autoCompactionCount = 0;
  // Track payloads sent directly (not via pipeline) during tool flush to avoid duplicates.
  const directlySentBlockKeys = new Set<string>();
  let runnableRun = resolveRunAfterAutoFallbackPrimaryProbeRecheck({
    run: params.followupRun.run,
    entry: params.activeSessionStore?.[params.sessionKey ?? ""] ?? params.getActiveSessionEntry(),
    sessionKey: params.sessionKey,
  });
  if (runnableRun !== params.followupRun.run) {
    params.followupRun.run = runnableRun;
  }
  const runtimeConfig = resolveQueuedReplyRuntimeConfig(runnableRun.config);
  let effectiveRun =
    runtimeConfig === runnableRun.config
      ? runnableRun
      : {
          ...runnableRun,
          config: runtimeConfig,
        };
  const resolveRunForFallbackCandidate = (provider: string, model: string): FollowupRun["run"] => {
    const probe = effectiveRun.autoFallbackPrimaryProbe;
    const isPrimaryProbeCandidate = probe && provider === probe.provider && model === probe.model;
    if (
      probe &&
      provider === probe.fallbackProvider &&
      !isPrimaryProbeCandidate &&
      probe.fallbackAuthProfileId
    ) {
      const candidateRun: FollowupRun["run"] = {
        ...effectiveRun,
        provider,
        model,
        authProfileId: probe.fallbackAuthProfileId,
      };
      if (probe.fallbackAuthProfileIdSource) {
        candidateRun.authProfileIdSource = probe.fallbackAuthProfileIdSource;
      } else {
        delete candidateRun.authProfileIdSource;
      }
      return candidateRun;
    }
    return effectiveRun;
  };
  const applyLiveModelSwitchToRun = (
    run: FollowupRun["run"],
    err: LiveSessionModelSwitchError,
  ): void => {
    run.provider = err.provider;
    run.model = err.model;
    run.authProfileId = err.authProfileId;
    run.authProfileIdSource = err.authProfileId ? err.authProfileIdSource : undefined;
    run.autoFallbackPrimaryProbe = undefined;
  };

  const runId = params.opts?.runId ?? crypto.randomUUID();
  const replyMediaContext =
    params.replyMediaContext ??
    createReplyMediaContext({
      cfg: runtimeConfig,
      sessionKey: params.sessionKey,
      workspaceDir: params.followupRun.run.workspaceDir,
      messageProvider: params.followupRun.run.messageProvider,
      accountId: params.followupRun.originatingAccountId ?? params.followupRun.run.agentAccountId,
      groupId: params.followupRun.run.groupId,
      groupChannel: params.followupRun.run.groupChannel,
      groupSpace: params.followupRun.run.groupSpace,
      requesterSenderId: params.followupRun.run.senderId,
      requesterSenderName: params.followupRun.run.senderName,
      requesterSenderUsername: params.followupRun.run.senderUsername,
      requesterSenderE164: params.followupRun.run.senderE164,
    });
  let didNotifyAgentRunStart = false;
  const notifyAgentRunStart = () => {
    if (didNotifyAgentRunStart) {
      return;
    }
    didNotifyAgentRunStart = true;
    params.opts?.onAgentRunStart?.(runId);
  };
  const currentMessageId = params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid;
  const shouldNotifyUserAboutCompaction =
    runtimeConfig?.agents?.defaults?.compaction?.notifyUser === true;
  const sendCompactionNotice = async (phase: "start" | "end" | "incomplete") => {
    if (!params.opts?.onBlockReply) {
      return;
    }
    const text =
      phase === "start"
        ? "🧹 Compacting context..."
        : phase === "end"
          ? "🧹 Compaction complete"
          : "🧹 Compaction incomplete";
    const noticePayload = params.applyReplyToMode({
      text,
      replyToId: currentMessageId,
      replyToCurrent: true,
      isCompactionNotice: true,
    });
    try {
      await params.opts.onBlockReply(noticePayload);
    } catch (err) {
      // Non-critical notice delivery failure should not bubble out of the
      // fire-and-forget event handler.
      logVerbose(`compaction ${phase} notice delivery failed (non-fatal): ${String(err)}`);
    }
  };
  const readCompactionHookMessages = (value: unknown): string[] => {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  };
  const sendCompactionHookMessages = async (messages: string[]) => {
    if (!params.opts?.onBlockReply || messages.length === 0) {
      return;
    }
    const noticePayload = params.applyReplyToMode({
      text: messages.join("\n\n"),
      replyToId: currentMessageId,
      replyToCurrent: true,
      isCompactionNotice: true,
    });
    try {
      await params.opts.onBlockReply(noticePayload);
    } catch (err) {
      logVerbose(`compaction hook notice delivery failed (non-fatal): ${String(err)}`);
    }
  };
  const shouldSurfaceToControlUi = isInternalMessageChannel(
    params.followupRun.run.messageProvider ??
      params.sessionCtx.Surface ??
      params.sessionCtx.Provider,
  );
  if (params.sessionKey) {
    registerAgentRunContext(runId, {
      sessionKey: params.sessionKey,
      verboseLevel: params.resolvedVerboseLevel,
      isHeartbeat: params.isHeartbeat,
      isControlUiVisible: shouldSurfaceToControlUi,
    });
  }
  let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
  let fallbackProvider = params.followupRun.run.provider;
  let fallbackModel = params.followupRun.run.model;
  let fallbackAttempts: RuntimeFallbackAttempt[] = [];
  let didResetAfterCompactionFailure = false;
  let didRetryTransientHttpError = false;
  let liveModelSwitchRetries = 0;
  let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    params.getActiveSessionEntry()?.systemPromptReport,
  );
  let pendingFallbackCandidateRollback:
    | {
        provider: string;
        model: string;
        rollback: () => Promise<void>;
      }
    | undefined;
  const clearPendingFallbackRollback = (rollback?: () => Promise<void>) => {
    if (!rollback || pendingFallbackCandidateRollback?.rollback === rollback) {
      pendingFallbackCandidateRollback = undefined;
    }
  };
  const rollbackClassifiedFallbackCandidateSelection = async (provider: string, model: string) => {
    const pending = pendingFallbackCandidateRollback;
    if (!pending || pending.provider !== provider || pending.model !== model) {
      return;
    }
    pendingFallbackCandidateRollback = undefined;
    try {
      await pending.rollback();
    } catch (rollbackError) {
      logVerbose(
        `failed to roll back classified fallback candidate selection (non-fatal): ${String(rollbackError)}`,
      );
    }
  };
  const persistFallbackCandidateSelection = async (
    provider: string,
    model: string,
    candidateRun: FollowupRun["run"],
  ): Promise<(() => Promise<void>) | undefined> => {
    if (effectiveRun.hasOneTurnModelOverride === true) {
      return undefined;
    }
    if (
      !params.sessionKey ||
      !params.activeSessionStore ||
      (provider === effectiveRun.provider && model === effectiveRun.model)
    ) {
      return undefined;
    }

    const activeSessionEntry =
      params.activeSessionStore[params.sessionKey] ?? params.getActiveSessionEntry();
    if (!activeSessionEntry) {
      return undefined;
    }

    // Don't overwrite a user-initiated model override (e.g. from /models or
    // /model) with the fallback model.  The user's explicit selection should
    // survive transient primary-model failures so subsequent messages still
    // target the model the user chose.  Fallback persistence is only
    // appropriate when the override was itself set by a previous fallback
    // ("auto") or when there is no override yet.
    //
    // `modelOverrideSource` was added later, so older persisted sessions can
    // carry a user-selected override without the source field.  Treat any
    // entry with a `modelOverride` but missing `modelOverrideSource` as legacy
    // user state, matching the backward-compat treatment in
    // session-reset-service.
    const isUserModelOverride =
      activeSessionEntry.modelOverrideSource === "user" ||
      (activeSessionEntry.modelOverrideSource === undefined &&
        Boolean(normalizeOptionalString(activeSessionEntry.modelOverride)) &&
        !hasSessionAutoModelFallbackProvenance(activeSessionEntry));
    if (isUserModelOverride) {
      return undefined;
    }

    const previousState = snapshotFallbackSelectionState(activeSessionEntry);
    const selectionRun =
      candidateRun !== effectiveRun && effectiveRun.autoFallbackPrimaryProbe
        ? {
            ...candidateRun,
            provider: candidateRun.provider,
            model: effectiveRun.model,
          }
        : candidateRun;
    const applied = applyFallbackCandidateSelectionToEntry({
      entry: activeSessionEntry,
      run: selectionRun,
      provider,
      model,
      force: candidateRun !== effectiveRun && Boolean(effectiveRun.autoFallbackPrimaryProbe),
      ...(effectiveRun.autoFallbackPrimaryProbe
        ? {
            origin: {
              provider: effectiveRun.autoFallbackPrimaryProbe.provider,
              model: effectiveRun.autoFallbackPrimaryProbe.model,
            },
          }
        : {}),
    });
    const nextState = applied.nextState;
    if (!applied.updated || !nextState) {
      return undefined;
    }
    params.activeSessionStore[params.sessionKey] = activeSessionEntry;

    try {
      if (params.storePath) {
        await updateSessionStore(params.storePath, (store) => {
          const persistedEntry = store[params.sessionKey!];
          if (!persistedEntry) {
            return;
          }
          applyFallbackSelectionState(persistedEntry, nextState);
          store[params.sessionKey!] = persistedEntry;
        });
      }
    } catch (error) {
      rollbackFallbackSelectionStateIfUnchanged(activeSessionEntry, nextState, previousState);
      params.activeSessionStore[params.sessionKey] = activeSessionEntry;
      throw error;
    }

    return async () => {
      const rolledBackInMemory = rollbackFallbackSelectionStateIfUnchanged(
        activeSessionEntry,
        nextState,
        previousState,
      );
      if (rolledBackInMemory) {
        params.activeSessionStore![params.sessionKey!] = activeSessionEntry;
      }
      if (!params.storePath) {
        return;
      }
      await updateSessionStore(params.storePath, (store) => {
        const persistedEntry = store[params.sessionKey!];
        if (!persistedEntry) {
          return;
        }
        if (rollbackFallbackSelectionStateIfUnchanged(persistedEntry, nextState, previousState)) {
          store[params.sessionKey!] = persistedEntry;
        }
      });
    };
  };
  const clearRecoveredAutoFallbackPrimaryProbe = async (paramsForClear: {
    provider: string;
    model: string;
  }): Promise<void> => {
    const probe = effectiveRun.autoFallbackPrimaryProbe;
    if (!probe) {
      return;
    }
    if (paramsForClear.provider !== probe.provider || paramsForClear.model !== probe.model) {
      return;
    }
    if (!params.sessionKey || !params.activeSessionStore) {
      return;
    }
    const activeSessionEntry =
      params.activeSessionStore[params.sessionKey] ?? params.getActiveSessionEntry();
    if (!activeSessionEntry) {
      return;
    }
    if (!entryMatchesAutoFallbackPrimaryProbe(activeSessionEntry, probe)) {
      return;
    }
    clearAutoFallbackPrimaryProbeSelection(activeSessionEntry);
    params.activeSessionStore[params.sessionKey] = activeSessionEntry;
    if (!params.storePath) {
      return;
    }
    await updateSessionStore(params.storePath, (store) => {
      const persistedEntry = store[params.sessionKey!];
      if (!persistedEntry) {
        return;
      }
      if (!entryMatchesAutoFallbackPrimaryProbe(persistedEntry, probe)) {
        return;
      }
      clearAutoFallbackPrimaryProbeSelection(persistedEntry);
      store[params.sessionKey!] = persistedEntry;
    });
  };

  while (true) {
    try {
      const normalizeStreamingText = (payload: ReplyPayload): { text?: string; skip: boolean } => {
        let text = payload.text;
        const reply = resolveSendableOutboundReplyParts(payload);
        if (params.followupRun.run.silentExpected) {
          return { skip: true };
        }
        if (!params.isHeartbeat && text?.includes("HEARTBEAT_OK")) {
          const stripped = stripHeartbeatToken(text, {
            mode: "message",
          });
          if (stripped.didStrip && !didLogHeartbeatStrip) {
            didLogHeartbeatStrip = true;
            logVerbose("Stripped stray HEARTBEAT_OK token from reply");
          }
          if (stripped.shouldSkip && !reply.hasMedia) {
            return { skip: true };
          }
          text = stripped.text;
        }
        if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
          return { skip: true };
        }
        if (
          isSilentReplyPrefixText(text, SILENT_REPLY_TOKEN) ||
          isSilentReplyPrefixText(text, HEARTBEAT_TOKEN)
        ) {
          return { skip: true };
        }
        if (text && startsWithSilentToken(text, SILENT_REPLY_TOKEN)) {
          text = stripLeadingSilentToken(text, SILENT_REPLY_TOKEN);
        }
        if (!text) {
          // Allow media-only payloads (e.g. tool result screenshots) through.
          if (reply.hasMedia) {
            return { text: undefined, skip: false };
          }
          return { skip: true };
        }
        const sanitized = sanitizeUserFacingText(text, {
          errorContext: Boolean(payload.isError),
        });
        if (!sanitized.trim()) {
          return { skip: true };
        }
        return { text: sanitized, skip: false };
      };
      const handlePartialForTyping = async (payload: ReplyPayload): Promise<string | undefined> => {
        if (isSilentReplyPrefixText(payload.text, SILENT_REPLY_TOKEN)) {
          return undefined;
        }
        const { text, skip } = normalizeStreamingText(payload);
        if (skip || !text) {
          return undefined;
        }
        await params.typingSignals.signalTextDelta(text);
        return text;
      };
      const blockReplyPipeline = params.blockReplyPipeline;
      // Build the delivery handler once so both onAgentEvent (compaction start
      // notice) and the onBlockReply field share the same instance.  This
      // ensures replyToId threading (replyToMode=all|first) is applied to
      // compaction notices just like every other block reply.
      const blockReplyHandler = params.opts?.onBlockReply
        ? createBlockReplyDeliveryHandler({
            onBlockReply: params.opts.onBlockReply,
            currentMessageId: params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid,
            replyThreading: params.replyThreading,
            normalizeStreamingText,
            applyReplyToMode: params.applyReplyToMode,
            normalizeMediaPaths: replyMediaContext.normalizePayload,
            typingSignals: params.typingSignals,
            blockStreamingEnabled: params.blockStreamingEnabled,
            blockReplyPipeline,
            directlySentBlockKeys,
          })
        : undefined;
      const onToolResult = params.opts?.onToolResult;
      const outcomePlan = buildAgentRuntimeOutcomePlan();
      const runLane = CommandLane.Main;
      const fallbackResult = await runWithModelFallback<EmbeddedAgentRunResult>({
        ...resolveModelFallbackOptions(effectiveRun, runtimeConfig),
        runId,
        sessionId: params.followupRun.run.sessionId,
        lane: runLane,
        onFallbackStep: (step) => {
          emitModelFallbackStepLifecycle({
            runId,
            sessionKey: params.sessionKey,
            step,
          });
        },
        classifyResult: async ({ result, provider, model }) => {
          const classification = outcomePlan.classifyRunResult({
            result,
            provider,
            model,
            hasDirectlySentBlockReply: directlySentBlockKeys.size > 0,
            hasBlockReplyPipelineOutput: Boolean(
              blockReplyPipeline?.hasBuffered() || blockReplyPipeline?.didStream(),
            ),
          });
          if (classification) {
            await rollbackClassifiedFallbackCandidateSelection(provider, model);
          }
          return classification;
        },
        run: async (provider, model, runOptions) => {
          const candidateRun = resolveRunForFallbackCandidate(provider, model);
          const activeProbe = effectiveRun.autoFallbackPrimaryProbe;
          if (activeProbe && provider === activeProbe.provider && model === activeProbe.model) {
            markAutoFallbackPrimaryProbe({
              probe: activeProbe,
              sessionKey: params.sessionKey,
            });
          }
          // Notify that model selection is complete (including after fallback).
          // This allows responsePrefix template interpolation with the actual model.
          params.opts?.onModelSelected?.({
            provider,
            model,
            thinkLevel: params.followupRun.run.thinkLevel,
          });
          let rollbackFallbackCandidateSelection: (() => Promise<void>) | undefined;
          try {
            rollbackFallbackCandidateSelection = await persistFallbackCandidateSelection(
              provider,
              model,
              candidateRun,
            );
            if (rollbackFallbackCandidateSelection) {
              pendingFallbackCandidateRollback = {
                provider,
                model,
                rollback: rollbackFallbackCandidateSelection,
              };
            }
          } catch (error) {
            logVerbose(
              `failed to persist fallback candidate selection (non-fatal): ${String(error)}`,
            );
          }

          const sessionRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
            provider,
            entry: params.getActiveSessionEntry(),
          });
          const cliExecutionProvider =
            sessionRuntimeOverride === "pi"
              ? provider
              : ((sessionRuntimeOverride && isCliProvider(sessionRuntimeOverride, runtimeConfig)
                  ? sessionRuntimeOverride
                  : undefined) ??
                resolveCliRuntimeExecutionProvider({
                  provider,
                  cfg: runtimeConfig,
                  agentId: params.followupRun.run.agentId,
                  modelId: model,
                }) ??
                provider);

          if (isCliProvider(cliExecutionProvider, runtimeConfig)) {
            const startedAt = Date.now();
            notifyAgentRunStart();
            emitAgentEvent({
              runId,
              stream: "lifecycle",
              data: {
                phase: "start",
                startedAt,
              },
            });
            const isRoomEventCliRun = params.followupRun.currentInboundEventKind === "room_event";
            const cliSessionBinding = isRoomEventCliRun
              ? undefined
              : getCliSessionBinding(params.getActiveSessionEntry(), cliExecutionProvider);
            const authProfile = resolveRunAuthProfile(candidateRun, cliExecutionProvider, {
              config: runtimeConfig,
            });
            const hookMessageProvider = resolveOriginMessageProvider({
              originatingChannel: params.followupRun.originatingChannel,
              provider: params.sessionCtx.Provider,
            });
            return (async () => {
              let lifecycleTerminalEmitted = false;
              const createAssistantTextBridge = (deliver: (text: string) => Promise<void>) => {
                let lastText: string | undefined;
                let unsubscribed = false;
                let delivery = Promise.resolve();
                const rawUnsubscribe = onAgentEvent((evt) => {
                  if (evt.runId !== runId || evt.stream !== "assistant") {
                    return;
                  }
                  if (params.followupRun.run.silentExpected) {
                    return;
                  }
                  const text = typeof evt.data.text === "string" ? evt.data.text : undefined;
                  if (text === undefined || text === lastText) {
                    return;
                  }
                  lastText = text;
                  delivery = delivery.then(() => deliver(text)).catch(() => undefined);
                });
                return {
                  unsubscribe() {
                    if (unsubscribed) {
                      return;
                    }
                    unsubscribed = true;
                    rawUnsubscribe();
                  },
                  async drain(): Promise<void> {
                    await delivery;
                  },
                };
              };
              const noopBridge = {
                unsubscribe: () => undefined,
                drain: async (): Promise<void> => undefined,
              };
              const assistantBridge = createAssistantTextBridge(async (text) => {
                const textForTyping = await handlePartialForTyping({ text } as ReplyPayload);
                if (textForTyping === undefined || !params.opts?.onPartialReply) {
                  return;
                }
                await params.opts.onPartialReply({ text: textForTyping });
              });
              const reasoningBridge = shouldBridgeCliAssistantTextToReasoning(cliExecutionProvider)
                ? createAssistantTextBridge(async (text) => {
                    await params.opts?.onReasoningStream?.({ text });
                  })
                : noopBridge;
              try {
                const rawResult = await runCliAgent({
                  sessionId: params.followupRun.run.sessionId,
                  sessionKey: params.sessionKey,
                  agentId: params.followupRun.run.agentId,
                  trigger: params.isHeartbeat ? "heartbeat" : "user",
                  sessionFile: params.followupRun.run.sessionFile,
                  workspaceDir: params.followupRun.run.workspaceDir,
                  config: runtimeConfig,
                  prompt: params.commandBody,
                  transcriptPrompt: params.transcriptCommandBody,
                  currentInboundEventKind: params.followupRun.currentInboundEventKind,
                  currentInboundContext: params.followupRun.currentInboundContext,
                  inputProvenance: params.followupRun.run.inputProvenance,
                  provider: cliExecutionProvider,
                  model,
                  thinkLevel: params.followupRun.run.thinkLevel,
                  timeoutMs: params.followupRun.run.timeoutMs,
                  runId,
                  lane: runLane,
                  extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
                  sourceReplyDeliveryMode: params.followupRun.run.sourceReplyDeliveryMode,
                  silentReplyPromptMode: params.followupRun.run.silentReplyPromptMode,
                  extraSystemPromptStatic: params.followupRun.run.extraSystemPromptStatic,
                  ownerNumbers: params.followupRun.run.ownerNumbers,
                  cliSessionId: cliSessionBinding?.sessionId,
                  cliSessionBinding,
                  authProfileId: authProfile.authProfileId,
                  bootstrapPromptWarningSignaturesSeen,
                  bootstrapPromptWarningSignature:
                    bootstrapPromptWarningSignaturesSeen[
                      bootstrapPromptWarningSignaturesSeen.length - 1
                    ],
                  images: params.opts?.images,
                  imageOrder: params.opts?.imageOrder,
                  skillsSnapshot: params.followupRun.run.skillsSnapshot,
                  messageChannel: params.followupRun.originatingChannel ?? undefined,
                  messageProvider: hookMessageProvider,
                  agentAccountId: params.followupRun.run.agentAccountId,
                  senderIsOwner: params.followupRun.run.senderIsOwner,
                  disableTools: params.opts?.disableTools,
                  abortSignal: params.replyOperation?.abortSignal ?? params.opts?.abortSignal,
                  replyOperation: params.replyOperation,
                });
                const result: EmbeddedAgentRunResult =
                  isRoomEventCliRun && rawResult.meta.agentMeta
                    ? (() => {
                        const { cliSessionBinding: _cliSessionBinding, ...agentMeta } =
                          rawResult.meta.agentMeta;
                        return {
                          ...rawResult,
                          meta: {
                            ...rawResult.meta,
                            agentMeta: {
                              ...agentMeta,
                              sessionId: "",
                            },
                          },
                        };
                      })()
                    : rawResult;
                bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
                  result.meta?.systemPromptReport,
                );

                assistantBridge.unsubscribe();
                reasoningBridge.unsubscribe();
                await assistantBridge.drain();
                await reasoningBridge.drain();

                // CLI backends don't emit streaming assistant events, so we need to
                // emit one with the final text so server-chat can populate its buffer
                // and send the response to TUI/WebSocket clients.
                const cliText = normalizeOptionalString(result.payloads?.[0]?.text);
                if (cliText) {
                  emitAgentEvent({
                    runId,
                    stream: "assistant",
                    data: { text: cliText },
                  });
                }

                emitAgentEvent({
                  runId,
                  stream: "lifecycle",
                  data: {
                    phase: "end",
                    startedAt,
                    endedAt: Date.now(),
                  },
                });
                lifecycleTerminalEmitted = true;

                return result;
              } catch (err) {
                assistantBridge.unsubscribe();
                reasoningBridge.unsubscribe();
                await assistantBridge.drain();
                await reasoningBridge.drain();
                if (rollbackFallbackCandidateSelection) {
                  try {
                    await rollbackFallbackCandidateSelection();
                    clearPendingFallbackRollback(rollbackFallbackCandidateSelection);
                  } catch (rollbackError) {
                    logVerbose(
                      `failed to roll back fallback candidate selection (non-fatal): ${String(rollbackError)}`,
                    );
                  }
                }
                emitAgentEvent({
                  runId,
                  stream: "lifecycle",
                  data: {
                    phase: "error",
                    startedAt,
                    endedAt: Date.now(),
                    error: String(err),
                  },
                });
                lifecycleTerminalEmitted = true;
                throw err;
              } finally {
                assistantBridge.unsubscribe();
                reasoningBridge.unsubscribe();
                // Defensive backstop: never let a CLI run complete without a terminal
                // lifecycle event, otherwise downstream consumers can hang.
                if (!lifecycleTerminalEmitted) {
                  emitAgentEvent({
                    runId,
                    stream: "lifecycle",
                    data: {
                      phase: "error",
                      startedAt,
                      endedAt: Date.now(),
                      error: "CLI run completed without lifecycle terminal event",
                    },
                  });
                }
              }
            })();
          }
          const { embeddedContext, senderContext, runBaseParams } = buildEmbeddedRunExecutionParams(
            {
              run: candidateRun,
              sessionCtx: params.sessionCtx,
              hasRepliedRef: params.opts?.hasRepliedRef,
              provider,
              runId,
              allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
              model,
            },
          );
          const agentHarnessPolicy = sessionRuntimeOverride
            ? ({ runtime: sessionRuntimeOverride, runtimeSource: "model" } as const)
            : resolveAgentHarnessPolicy({
                provider,
                modelId: model,
                config: runtimeConfig,
                agentId: params.followupRun.run.agentId,
                sessionKey: params.followupRun.run.runtimePolicySessionKey ?? params.sessionKey,
              });
          const embeddedRunProvider = resolveOpenAIRuntimeProviderForPi({
            provider,
            harnessRuntime: agentHarnessPolicy.runtime,
            authProfileProvider: runBaseParams.authProfileId?.split(":", 1)[0],
            authProfileId: runBaseParams.authProfileId,
            config: runtimeConfig,
            workspaceDir: params.followupRun.run.workspaceDir,
          });
          const embeddedRunHarnessOverride =
            sessionRuntimeOverride ??
            (agentHarnessPolicy.runtime === "pi" && embeddedRunProvider !== provider
              ? "pi"
              : undefined);
          return (async () => {
            let attemptCompactionCount = 0;
            const lifecycleBackstop = createEmbeddedLifecycleTerminalBackstop({
              runId,
              sessionKey: params.sessionKey,
            });
            try {
              const result = await runEmbeddedPiAgent({
                ...embeddedContext,
                allowGatewaySubagentBinding: true,
                trigger: params.isHeartbeat ? "heartbeat" : "user",
                groupId: resolveGroupSessionKey(params.sessionCtx)?.id,
                groupChannel:
                  normalizeOptionalString(params.sessionCtx.GroupChannel) ??
                  normalizeOptionalString(params.sessionCtx.GroupSubject),
                groupSpace: normalizeOptionalString(params.sessionCtx.GroupSpace),
                ...senderContext,
                ...runBaseParams,
                provider: embeddedRunProvider,
                agentHarnessId: embeddedRunHarnessOverride,
                agentHarnessRuntimeOverride: embeddedRunHarnessOverride,
                sandboxSessionKey: params.runtimePolicySessionKey,
                prompt: params.commandBody,
                transcriptPrompt: params.transcriptCommandBody,
                currentInboundEventKind: params.followupRun.currentInboundEventKind,
                currentInboundContext: params.followupRun.currentInboundContext,
                extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
                sourceReplyDeliveryMode: params.followupRun.run.sourceReplyDeliveryMode,
                forceMessageTool:
                  params.followupRun.run.sourceReplyDeliveryMode === "message_tool_only",
                silentReplyPromptMode: params.followupRun.run.silentReplyPromptMode,
                suppressNextUserMessagePersistence:
                  params.followupRun.run.suppressNextUserMessagePersistence,
                suppressTranscriptOnlyAssistantPersistence:
                  params.followupRun.run.suppressTranscriptOnlyAssistantPersistence,
                toolResultFormat: (() => {
                  const channel = resolveMessageChannel(
                    params.sessionCtx.Surface,
                    params.sessionCtx.Provider,
                  );
                  if (!channel) {
                    return "markdown";
                  }
                  return isMarkdownCapableMessageChannel(channel) ? "markdown" : "plain";
                })(),
                toolProgressDetail: params.toolProgressDetail,
                suppressToolErrorWarnings: params.opts?.suppressToolErrorWarnings,
                disableTools: params.opts?.disableTools,
                enableHeartbeatTool: params.opts?.enableHeartbeatTool,
                forceHeartbeatTool: params.opts?.forceHeartbeatTool,
                bootstrapContextMode: params.opts?.bootstrapContextMode,
                bootstrapContextRunKind: params.opts?.isHeartbeat ? "heartbeat" : "default",
                images: params.opts?.images,
                imageOrder: params.opts?.imageOrder,
                abortSignal: params.replyOperation?.abortSignal ?? params.opts?.abortSignal,
                replyOperation: params.replyOperation,
                blockReplyBreak: params.resolvedBlockStreamingBreak,
                blockReplyChunking: params.blockReplyChunking,
                onPartialReply: async (payload) => {
                  const textForTyping = await handlePartialForTyping(payload);
                  if (!params.opts?.onPartialReply || textForTyping === undefined) {
                    return;
                  }
                  await params.opts.onPartialReply({
                    text: textForTyping,
                    mediaUrls: payload.mediaUrls,
                  });
                },
                onAssistantMessageStart: async () => {
                  await params.typingSignals.signalMessageStart();
                  await params.opts?.onAssistantMessageStart?.();
                },
                onReasoningStream:
                  params.typingSignals.shouldStartOnReasoning || params.opts?.onReasoningStream
                    ? async (payload) => {
                        if (params.followupRun.run.silentExpected) {
                          return;
                        }
                        await params.typingSignals.signalReasoningDelta();
                        await params.opts?.onReasoningStream?.({
                          text: payload.text,
                          mediaUrls: payload.mediaUrls,
                        });
                      }
                    : undefined,
                onReasoningEnd: params.opts?.onReasoningEnd,
                onAgentEvent: async (evt) => {
                  lifecycleBackstop.note(evt);
                  // Signal run start only after the embedded agent emits real activity.
                  const hasLifecyclePhase =
                    evt.stream === "lifecycle" && typeof evt.data.phase === "string";
                  if (evt.stream !== "lifecycle" || hasLifecyclePhase) {
                    notifyAgentRunStart();
                  }
                  // Trigger typing when tools start executing.
                  // Must await to ensure typing indicator starts before tool summaries are emitted.
                  if (evt.stream === "tool") {
                    const phase = readStringValue(evt.data.phase) ?? "";
                    const name = readStringValue(evt.data.name);
                    if (phase === "start" || phase === "update") {
                      const toolStartProgressPromise = params.opts?.onToolStart?.({
                        name,
                        phase,
                        args:
                          evt.data.args && typeof evt.data.args === "object"
                            ? (evt.data.args as Record<string, unknown>)
                            : undefined,
                        detailMode: params.toolProgressDetail,
                      });
                      await Promise.all([
                        params.typingSignals.signalToolStart(),
                        toolStartProgressPromise,
                      ]);
                    }
                  }
                  const suppressItemChannelProgress =
                    evt.stream === "item" &&
                    evt.data.suppressChannelProgress === true &&
                    Boolean(params.opts?.onToolStart);
                  if (evt.stream === "item" && !suppressItemChannelProgress) {
                    await params.opts?.onItemEvent?.({
                      itemId: readStringValue(evt.data.itemId),
                      kind: readStringValue(evt.data.kind),
                      title: readStringValue(evt.data.title),
                      name: readStringValue(evt.data.name),
                      phase: readStringValue(evt.data.phase),
                      status: readStringValue(evt.data.status),
                      summary: readStringValue(evt.data.summary),
                      progressText: readStringValue(evt.data.progressText),
                      meta: readStringValue(evt.data.meta),
                      approvalId: readStringValue(evt.data.approvalId),
                      approvalSlug: readStringValue(evt.data.approvalSlug),
                    });
                  }
                  if (evt.stream === "plan") {
                    await params.opts?.onPlanUpdate?.({
                      phase: readStringValue(evt.data.phase),
                      title: readStringValue(evt.data.title),
                      explanation: readStringValue(evt.data.explanation),
                      steps: Array.isArray(evt.data.steps)
                        ? evt.data.steps.filter((step): step is string => typeof step === "string")
                        : undefined,
                      source: readStringValue(evt.data.source),
                    });
                  }
                  if (evt.stream === "approval") {
                    await params.opts?.onApprovalEvent?.({
                      phase: readStringValue(evt.data.phase),
                      kind: readStringValue(evt.data.kind),
                      status: readStringValue(evt.data.status),
                      title: readStringValue(evt.data.title),
                      itemId: readStringValue(evt.data.itemId),
                      toolCallId: readStringValue(evt.data.toolCallId),
                      approvalId: readStringValue(evt.data.approvalId),
                      approvalSlug: readStringValue(evt.data.approvalSlug),
                      command: readStringValue(evt.data.command),
                      host: readStringValue(evt.data.host),
                      reason: readStringValue(evt.data.reason),
                      scope: readApprovalScopeValue(evt.data.scope),
                      message: readStringValue(evt.data.message),
                    });
                  }
                  if (evt.stream === "command_output") {
                    await params.opts?.onCommandOutput?.({
                      itemId: readStringValue(evt.data.itemId),
                      phase: readStringValue(evt.data.phase),
                      title: readStringValue(evt.data.title),
                      toolCallId: readStringValue(evt.data.toolCallId),
                      name: readStringValue(evt.data.name),
                      output: readStringValue(evt.data.output),
                      status: readStringValue(evt.data.status),
                      exitCode:
                        typeof evt.data.exitCode === "number" || evt.data.exitCode === null
                          ? evt.data.exitCode
                          : undefined,
                      durationMs:
                        typeof evt.data.durationMs === "number" ? evt.data.durationMs : undefined,
                      cwd: readStringValue(evt.data.cwd),
                    });
                  }
                  if (evt.stream === "patch") {
                    await params.opts?.onPatchSummary?.({
                      itemId: readStringValue(evt.data.itemId),
                      phase: readStringValue(evt.data.phase),
                      title: readStringValue(evt.data.title),
                      toolCallId: readStringValue(evt.data.toolCallId),
                      name: readStringValue(evt.data.name),
                      added: Array.isArray(evt.data.added)
                        ? evt.data.added.filter(
                            (entry): entry is string => typeof entry === "string",
                          )
                        : undefined,
                      modified: Array.isArray(evt.data.modified)
                        ? evt.data.modified.filter(
                            (entry): entry is string => typeof entry === "string",
                          )
                        : undefined,
                      deleted: Array.isArray(evt.data.deleted)
                        ? evt.data.deleted.filter(
                            (entry): entry is string => typeof entry === "string",
                          )
                        : undefined,
                      summary: readStringValue(evt.data.summary),
                    });
                  }
                  // Track auto-compaction and notify higher layers.
                  if (evt.stream === "compaction") {
                    const phase = readStringValue(evt.data.phase) ?? "";
                    const hookMessages = readCompactionHookMessages(evt.data.messages);
                    if (phase === "start") {
                      // Keep custom compaction callbacks active, but gate the
                      // fallback user-facing notice behind explicit opt-in.
                      if (params.opts?.onCompactionStart) {
                        await params.opts.onCompactionStart();
                      }
                      if (hookMessages.length > 0) {
                        await sendCompactionHookMessages(hookMessages);
                      } else if (
                        !params.opts?.onCompactionStart &&
                        shouldNotifyUserAboutCompaction
                      ) {
                        // Send directly via opts.onBlockReply (bypassing the
                        // pipeline) so the notice does not cause final payloads
                        // to be discarded on non-streaming model paths.
                        await sendCompactionNotice("start");
                      }
                    }
                    if (phase === "end") {
                      const completed = evt.data?.completed === true;
                      if (completed) {
                        attemptCompactionCount += 1;
                        if (params.opts?.onCompactionEnd) {
                          await params.opts.onCompactionEnd();
                        }
                        if (hookMessages.length > 0) {
                          await sendCompactionHookMessages(hookMessages);
                        } else if (
                          !params.opts?.onCompactionEnd &&
                          shouldNotifyUserAboutCompaction
                        ) {
                          await sendCompactionNotice("end");
                        }
                      } else if (hookMessages.length > 0) {
                        await sendCompactionHookMessages(hookMessages);
                      } else if (shouldNotifyUserAboutCompaction) {
                        await sendCompactionNotice("incomplete");
                      }
                    }
                  }
                },
                // Always pass onBlockReply so flushBlockReplyBuffer works before tool execution,
                // even when regular block streaming is disabled. The handler sends directly
                // via opts.onBlockReply when the pipeline isn't available.
                onBlockReply: blockReplyHandler,
                onBlockReplyFlush:
                  params.blockStreamingEnabled && blockReplyPipeline
                    ? async () => {
                        await blockReplyPipeline.flush({ force: true });
                      }
                    : undefined,
                shouldEmitToolResult: params.shouldEmitToolResult,
                shouldEmitToolOutput: params.shouldEmitToolOutput,
                bootstrapPromptWarningSignaturesSeen,
                bootstrapPromptWarningSignature:
                  bootstrapPromptWarningSignaturesSeen[
                    bootstrapPromptWarningSignaturesSeen.length - 1
                  ],
                onToolResult: onToolResult
                  ? (() => {
                      // Serialize tool result delivery to preserve message ordering.
                      // Without this, concurrent tool callbacks race through typing signals
                      // and message sends, causing out-of-order delivery to the user.
                      // See: https://github.com/openclaw/openclaw/issues/11044
                      let toolResultChain: Promise<void> = Promise.resolve();
                      return (payload: ReplyPayload) => {
                        toolResultChain = toolResultChain
                          .then(async () => {
                            const { text, skip } = normalizeStreamingText(payload);
                            if (skip) {
                              return;
                            }
                            if (text !== undefined) {
                              await params.typingSignals.signalTextDelta(text);
                            }
                            await onToolResult({
                              ...payload,
                              text,
                            });
                          })
                          .catch((err) => {
                            // Keep chain healthy after an error so later tool results still deliver.
                            logVerbose(`tool result delivery failed: ${String(err)}`);
                          });
                        const task = toolResultChain.finally(() => {
                          params.pendingToolTasks.delete(task);
                        });
                        params.pendingToolTasks.add(task);
                      };
                    })()
                  : undefined,
              });
              bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
                result.meta?.systemPromptReport,
              );
              lifecycleBackstop.emit("end", result);
              const resultCompactionCount = Math.max(
                0,
                result.meta?.agentMeta?.compactionCount ?? 0,
              );
              attemptCompactionCount = Math.max(attemptCompactionCount, resultCompactionCount);
              return result;
            } catch (err) {
              if (rollbackFallbackCandidateSelection) {
                try {
                  await rollbackFallbackCandidateSelection();
                  clearPendingFallbackRollback(rollbackFallbackCandidateSelection);
                } catch (rollbackError) {
                  logVerbose(
                    `failed to roll back fallback candidate selection (non-fatal): ${String(rollbackError)}`,
                  );
                }
              }
              lifecycleBackstop.emit("error", err);
              throw err;
            } finally {
              autoCompactionCount += attemptCompactionCount;
            }
          })();
        },
      });
      runResult = fallbackResult.result;
      fallbackProvider = fallbackResult.provider;
      fallbackModel = fallbackResult.model;
      fallbackAttempts = Array.isArray(fallbackResult.attempts)
        ? fallbackResult.attempts.map((attempt) => ({
            provider: attempt.provider,
            model: attempt.model,
            error: attempt.error,
            reason: attempt.reason || undefined,
            status: typeof attempt.status === "number" ? attempt.status : undefined,
            code: attempt.code || undefined,
          }))
        : [];
      await clearRecoveredAutoFallbackPrimaryProbe({
        provider: fallbackProvider,
        model: fallbackModel,
      });

      // Some embedded runs surface context overflow as an error payload instead of throwing.
      // Treat those as a session-level failure and auto-recover by starting a fresh session.
      const embeddedError = runResult.meta?.error;
      if (
        embeddedError &&
        isContextOverflowError(embeddedError.message) &&
        !didResetAfterCompactionFailure &&
        (await params.resetSessionAfterCompactionFailure(embeddedError.message))
      ) {
        didResetAfterCompactionFailure = true;
        params.replyOperation?.fail("run_failed", embeddedError);
        return {
          kind: "final",
          payload: markAgentRunFailureReplyPayload({
            text: buildContextOverflowRecoveryText({
              cfg: runtimeConfig,
              agentId: params.followupRun.run.agentId,
              primaryProvider: params.followupRun.run.provider,
              primaryModel: params.followupRun.run.model,
              activeSessionEntry: params.getActiveSessionEntry(),
            }),
          }),
        };
      }
      if (embeddedError?.kind === "role_ordering") {
        const didReset = await params.resetSessionAfterRoleOrderingConflict(embeddedError.message);
        if (didReset) {
          params.replyOperation?.fail("run_failed", embeddedError);
          return {
            kind: "final",
            payload: markAgentRunFailureReplyPayload({
              text: "⚠️ Message ordering conflict. I've reset the conversation - please try again.",
            }),
          };
        }
      }

      break;
    } catch (err) {
      if (err instanceof LiveSessionModelSwitchError) {
        liveModelSwitchRetries += 1;
        if (liveModelSwitchRetries > MAX_LIVE_SWITCH_RETRIES) {
          // Prevent infinite loop when persisted session selection keeps
          // conflicting with fallback model choices (e.g. overloaded primary
          // triggers fallback, but session store keeps pulling back to the
          // overloaded model). Surface the last error to the user instead.
          // See: https://github.com/openclaw/openclaw/issues/58348
          defaultRuntime.error(
            `Live model switch failed after ${MAX_LIVE_SWITCH_RETRIES} retries ` +
              `(${sanitizeForLog(err.provider)}/${sanitizeForLog(err.model)}). The requested model may be unavailable.`,
          );
          const switchErrorText = shouldSurfaceToControlUi
            ? "⚠️ Agent failed before reply: model switch could not be completed. " +
              "The requested model may be temporarily unavailable.\n" +
              "Logs: openclaw logs --follow"
            : isVerboseFailureDetailEnabled(params.resolvedVerboseLevel)
              ? "⚠️ Agent failed before reply: model switch could not be completed. " +
                "The requested model may be temporarily unavailable. Please try again shortly."
              : "⚠️ Model switch could not be completed. The requested model may be temporarily unavailable. Please try again shortly.";
          params.replyOperation?.fail("run_failed", err);
          return {
            kind: "final",
            payload: markAgentRunFailureReplyPayload({
              text: resolveExternalRunFailureTextForConversation({
                text: switchErrorText,
                sessionCtx: params.sessionCtx,
                isGenericRunnerFailure: !shouldSurfaceToControlUi,
                cfg: params.followupRun.run.config,
              }),
            }),
          };
        }
        applyLiveModelSwitchToRun(params.followupRun.run, err);
        if (runnableRun !== params.followupRun.run) {
          applyLiveModelSwitchToRun(runnableRun, err);
        }
        if (effectiveRun !== runnableRun && effectiveRun !== params.followupRun.run) {
          applyLiveModelSwitchToRun(effectiveRun, err);
        }
        fallbackProvider = err.provider;
        fallbackModel = err.model;
        continue;
      }
      const message = formatErrorMessage(err);
      const isBilling = isFallbackSummaryError(err)
        ? isPureBillingSummary(err)
        : isBillingErrorMessage(message);
      const isContextOverflow = !isBilling && isLikelyContextOverflowError(message);
      const isCompactionFailure = !isBilling && isCompactionFailureError(message);
      const isSessionCorruption = /function call turn comes immediately after/i.test(message);
      const isRoleOrderingError = /incorrect role information|roles must alternate/i.test(message);
      const isTransientHttp = isTransientHttpError(message);

      if (isReplyOperationRestartAbort(params.replyOperation)) {
        return {
          kind: "final",
          payload: markAgentRunFailureReplyPayload({
            text: buildRestartLifecycleReplyText(),
          }),
        };
      }

      if (isReplyOperationUserAbort(params.replyOperation)) {
        return {
          kind: "final",
          payload: {
            text: SILENT_REPLY_TOKEN,
          },
        };
      }

      const restartLifecycleError = resolveRestartLifecycleError(err);
      if (restartLifecycleError instanceof GatewayDrainingError) {
        params.replyOperation?.fail("gateway_draining", restartLifecycleError);
        return {
          kind: "final",
          payload: markAgentRunFailureReplyPayload({
            text: buildRestartLifecycleReplyText(),
          }),
        };
      }

      if (restartLifecycleError instanceof CommandLaneClearedError) {
        params.replyOperation?.fail("command_lane_cleared", restartLifecycleError);
        return {
          kind: "final",
          payload: markAgentRunFailureReplyPayload({
            text: buildRestartLifecycleReplyText(),
          }),
        };
      }

      if (
        isCompactionFailure &&
        !didResetAfterCompactionFailure &&
        (await params.resetSessionAfterCompactionFailure(message))
      ) {
        didResetAfterCompactionFailure = true;
        params.replyOperation?.fail("run_failed", err);
        return {
          kind: "final",
          payload: markAgentRunFailureReplyPayload({
            text: buildContextOverflowRecoveryText({
              duringCompaction: true,
              cfg: runtimeConfig,
              agentId: params.followupRun.run.agentId,
              primaryProvider: params.followupRun.run.provider,
              primaryModel: params.followupRun.run.model,
              activeSessionEntry: params.getActiveSessionEntry(),
            }),
          }),
        };
      }
      if (isRoleOrderingError) {
        const didReset = await params.resetSessionAfterRoleOrderingConflict(message);
        if (didReset) {
          params.replyOperation?.fail("run_failed", err);
          return {
            kind: "final",
            payload: markAgentRunFailureReplyPayload({
              text: "⚠️ Message ordering conflict. I've reset the conversation - please try again.",
            }),
          };
        }
      }

      // Auto-recover from Gemini session corruption by resetting the session
      if (
        isSessionCorruption &&
        params.sessionKey &&
        params.activeSessionStore &&
        params.storePath
      ) {
        const sessionKey = params.sessionKey;
        const corruptedSessionId = params.getActiveSessionEntry()?.sessionId;
        defaultRuntime.error(
          `Session history corrupted (Gemini function call ordering). Resetting session: ${params.sessionKey}`,
        );

        try {
          // Delete transcript file if it exists
          if (corruptedSessionId) {
            const transcriptPath = resolveSessionTranscriptPath(corruptedSessionId);
            try {
              fs.unlinkSync(transcriptPath);
            } catch {
              // Ignore if file doesn't exist
            }
          }

          // Keep the in-memory snapshot consistent with the on-disk store reset.
          delete params.activeSessionStore[sessionKey];

          // Remove session entry from store using a fresh, locked snapshot.
          await updateSessionStore(params.storePath, (store) => {
            delete store[sessionKey];
          });
        } catch (cleanupErr) {
          defaultRuntime.error(
            `Failed to reset corrupted session ${params.sessionKey}: ${String(cleanupErr)}`,
          );
        }

        params.replyOperation?.fail("session_corruption_reset", err);
        return {
          kind: "final",
          payload: markAgentRunFailureReplyPayload({
            text: "⚠️ Session history was corrupted. I've reset the conversation - please try again!",
          }),
        };
      }

      if (isTransientHttp && !didRetryTransientHttpError) {
        didRetryTransientHttpError = true;
        // Retry the full runWithModelFallback() cycle — transient errors
        // (502/521/etc.) typically affect the whole provider, so falling
        // back to an alternate model first would not help. Instead we wait
        // and retry the complete primary→fallback chain.
        defaultRuntime.error(
          `Transient HTTP provider error before reply (${message}). Retrying once in ${TRANSIENT_HTTP_RETRY_DELAY_MS}ms.`,
        );
        await new Promise<void>((resolve) => {
          setTimeout(resolve, TRANSIENT_HTTP_RETRY_DELAY_MS);
        });
        continue;
      }

      defaultRuntime.error(`Embedded agent failed before reply: ${message}`);
      // Only classify as rate-limit when we have concrete evidence from the
      // underlying error. FallbackSummaryError messages embed per-attempt
      // reason labels like `(rate_limit)`, so string-matching the summary text
      // would misclassify mixed-cause exhaustion as a pure transient cooldown.
      const isFallbackSummary = isFallbackSummaryError(err);
      const isPureTransientSummary = isFallbackSummary
        ? isPureTransientRateLimitSummary(err)
        : false;
      const isRateLimit = isFallbackSummary
        ? isPureTransientSummary
        : isRateLimitErrorMessage(message);
      const rateLimitOrOverloadedCopy =
        !isFallbackSummary || isPureTransientSummary
          ? formatRateLimitOrOverloadedErrorCopy(message)
          : undefined;
      const safeMessage = isTransientHttp
        ? sanitizeUserFacingText(message, { errorContext: true })
        : message;
      const trimmedMessage = safeMessage.replace(/\.\s*$/, "");
      const externalRunFailureReply =
        !isBilling &&
        !(isRateLimit && !isOverloadedErrorMessage(message)) &&
        !rateLimitOrOverloadedCopy &&
        !isContextOverflow &&
        !isRoleOrderingError &&
        !shouldSurfaceToControlUi
          ? buildExternalRunFailureReply(message, {
              includeDetails: isVerboseFailureDetailEnabled(params.resolvedVerboseLevel),
              isHeartbeat: params.isHeartbeat,
            })
          : undefined;
      const genericFallbackText = params.isHeartbeat
        ? HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT
        : GENERIC_EXTERNAL_RUN_FAILURE_TEXT;
      const fallbackText = isBilling
        ? BILLING_ERROR_USER_MESSAGE
        : isRateLimit && !isOverloadedErrorMessage(message)
          ? buildRateLimitCooldownMessage(err)
          : rateLimitOrOverloadedCopy
            ? rateLimitOrOverloadedCopy
            : isContextOverflow
              ? "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model."
              : isRoleOrderingError
                ? "⚠️ Message ordering conflict - please try again. If this persists, use /new to start a fresh session."
                : shouldSurfaceToControlUi
                  ? `⚠️ Agent failed before reply: ${trimmedMessage}.\nLogs: openclaw logs --follow`
                  : (externalRunFailureReply?.text ?? genericFallbackText);
      const userVisibleFallbackText = resolveExternalRunFailureTextForConversation({
        text: fallbackText,
        sessionCtx: params.sessionCtx,
        isGenericRunnerFailure: externalRunFailureReply?.isGenericRunnerFailure ?? false,
        cfg: params.followupRun.run.config,
      });

      params.replyOperation?.fail("run_failed", err);
      return {
        kind: "final",
        payload: markAgentRunFailureReplyPayload({
          text: userVisibleFallbackText,
        }),
      };
    }
  }

  // If the run completed but with an embedded context overflow error that
  // wasn't recovered from (e.g. compaction reset already attempted), surface
  // the error to the user instead of silently returning an empty response.
  // See #26905: Slack DM sessions silently swallowed messages when context
  // overflow errors were returned as embedded error payloads.
  const finalEmbeddedError = runResult?.meta?.error;
  const hasPayloadText = runResult?.payloads?.some((p) => normalizeOptionalString(p.text));
  if (finalEmbeddedError && !hasPayloadText) {
    const errorMsg = finalEmbeddedError.message ?? "";
    if (isContextOverflowError(errorMsg)) {
      params.replyOperation?.fail("run_failed", finalEmbeddedError);
      return {
        kind: "final",
        payload: markAgentRunFailureReplyPayload({
          text: "⚠️ Context overflow — this conversation is too large for the model. Use /new to start a fresh session.",
        }),
      };
    }
  }

  // Surface rate limit and overload errors that occur mid-turn (after tool
  // calls) instead of silently returning an empty response. See #36142.
  // Only applies when the assistant produced no valid (non-error) reply text,
  // so tool-level rate-limit messages don't override a successful turn.
  // Prioritize metaErrorMsg (raw upstream error) over errorPayloadText to
  // avoid self-matching on pre-formatted "⚠️" messages from run.ts, and
  // skip already-formatted payloads so tool-specific 429 errors (e.g.
  // browser/search tool failures) are preserved rather than overwritten.
  //
  // Instead of early-returning kind:"final" (which would bypass
  // buildReplyPayloads() filtering and session bookkeeping), inject the
  // error payload into runResult so it flows through the normal
  // kind:"success" path — preserving streaming dedup, message_send
  // suppression, and usage/model metadata updates.
  if (runResult) {
    const hasNonErrorContent = runResult.payloads?.some(
      (p) => !p.isError && !p.isReasoning && hasOutboundReplyContent(p, { trimText: true }),
    );
    if (!hasNonErrorContent) {
      const metaErrorMsg = finalEmbeddedError?.message ?? "";
      const rawErrorPayloadText =
        runResult.payloads?.find(
          (p) => p.isError && hasNonEmptyString(p.text) && !p.text.startsWith("⚠️"),
        )?.text ?? "";
      const errorCandidate = metaErrorMsg || rawErrorPayloadText;
      const formattedErrorCandidate = errorCandidate
        ? formatRateLimitOrOverloadedErrorCopy(errorCandidate)
        : undefined;
      if (formattedErrorCandidate) {
        runResult.payloads = [
          markAgentRunFailureReplyPayload({
            text: formattedErrorCandidate,
            isError: true,
          }),
        ];
      }
    }

    applyOpenAIGptChatReplyGuard({
      provider: fallbackProvider,
      model: fallbackModel,
      commandBody: params.commandBody,
      isHeartbeat: params.isHeartbeat,
      payloads: runResult.payloads,
    });
  }

  return {
    kind: "success",
    runId,
    runResult,
    fallbackProvider,
    fallbackModel,
    fallbackAttempts,
    didLogHeartbeatStrip,
    autoCompactionCount,
    directlySentBlockKeys: directlySentBlockKeys.size > 0 ? directlySentBlockKeys : undefined,
  };
}
