import crypto from "node:crypto";
import fs from "node:fs";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import {
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailure,
} from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { runCliAgent } from "../../agents/cli-runner.js";
import { getCliSessionBinding } from "../../agents/cli-session.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import { runWithModelFallback, isFallbackSummaryError } from "../../agents/model-fallback.js";
import { isCliProvider } from "../../agents/model-selection.js";
import {
  BILLING_ERROR_USER_MESSAGE,
  isCompactionFailureError,
  isContextOverflowError,
  isBillingErrorMessage,
  isLikelyContextOverflowError,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isTransientHttpError,
  sanitizeUserFacingText,
} from "../../agents/pi-embedded-helpers.js";
import { isLikelyExecutionAckPrompt } from "../../agents/pi-embedded-runner/run/incomplete-turn.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import {
  resolveGroupSessionKey,
  resolveSessionTranscriptPath,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { emitAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { CommandLaneClearedError, GatewayDrainingError } from "../../process/command-queue.js";
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
  buildEmbeddedRunExecutionParams,
  resolveQueuedReplyRuntimeConfig,
  resolveModelFallbackOptions,
} from "./agent-runner-utils.js";
import { type BlockReplyPipeline } from "./block-reply-pipeline.js";
import type { FollowupRun } from "./queue.js";
import { createBlockReplyDeliveryHandler } from "./reply-delivery.js";
import { createReplyMediaPathNormalizer } from "./reply-media-paths.runtime.js";
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

type FallbackSelectionState = Pick<
  SessionEntry,
  | "providerOverride"
  | "modelOverride"
  | "modelOverrideSource"
  | "authProfileOverride"
  | "authProfileOverrideSource"
  | "authProfileOverrideCompactionCount"
>;

const FALLBACK_SELECTION_STATE_KEYS = [
  "providerOverride",
  "modelOverride",
  "modelOverrideSource",
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
    authProfileOverride: entry.authProfileOverride,
    authProfileOverrideSource: entry.authProfileOverrideSource,
    authProfileOverrideCompactionCount: entry.authProfileOverrideCompactionCount,
  };
}

function buildFallbackSelectionState(params: {
  provider: string;
  model: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
}): FallbackSelectionState {
  return {
    providerOverride: params.provider,
    modelOverride: params.model,
    modelOverrideSource: "auto",
    authProfileOverride: params.authProfileId,
    authProfileOverrideSource: params.authProfileId ? params.authProfileIdSource : undefined,
    authProfileOverrideCompactionCount: undefined,
  };
}

export function applyFallbackCandidateSelectionToEntry(params: {
  entry: SessionEntry;
  run: FollowupRun["run"];
  provider: string;
  model: string;
  now?: number;
}): { updated: boolean; nextState?: FallbackSelectionState } {
  if (params.provider === params.run.provider && params.model === params.run.model) {
    return { updated: false };
  }
  const scopedAuthProfile = resolveRunAuthProfile(params.run, params.provider);
  const nextState = buildFallbackSelectionState({
    provider: params.provider,
    model: params.model,
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

function buildMissingApiKeyFailureText(message: string): string | null {
  const normalizedMessage = collapseRepeatedFailureDetail(message);
  const providerMatch = normalizedMessage.match(/No API key found for provider "([^"]+)"/u);
  const provider = providerMatch?.[1]?.trim().toLowerCase();
  if (!provider) {
    return null;
  }
  if (provider === "openai" && normalizedMessage.includes("OpenAI Codex OAuth")) {
    return "⚠️ Missing API key for OpenAI on the gateway. Use `openai-codex/gpt-5.4` for OAuth, or set `OPENAI_API_KEY`, then try again.";
  }
  if (SAFE_MISSING_API_KEY_PROVIDERS.has(provider)) {
    return `⚠️ Missing API key for provider "${provider}". Configure the gateway auth for that provider, then try again.`;
  }
  return "⚠️ Missing API key for the selected provider on the gateway. Configure provider auth, then try again.";
}

function buildExternalRunFailureText(message: string): string {
  const normalizedMessage = collapseRepeatedFailureDetail(message);
  if (isToolResultTurnMismatchError(normalizedMessage)) {
    return "⚠️ Session history got out of sync. Please try again, or use /new to start a fresh session.";
  }
  const missingApiKeyFailure = buildMissingApiKeyFailureText(normalizedMessage);
  if (missingApiKeyFailure) {
    return missingApiKeyFailure;
  }
  const oauthRefreshFailure = classifyOAuthRefreshFailure(normalizedMessage);
  if (oauthRefreshFailure) {
    const loginCommand = buildOAuthRefreshFailureLoginCommand(oauthRefreshFailure.provider);
    if (oauthRefreshFailure.reason) {
      return `⚠️ Model login expired on the gateway${oauthRefreshFailure.provider ? ` for ${oauthRefreshFailure.provider}` : ""}. Re-auth with \`${loginCommand}\`, then try again.`;
    }
    return `⚠️ Model login failed on the gateway${oauthRefreshFailure.provider ? ` for ${oauthRefreshFailure.provider}` : ""}. Please try again. If this keeps happening, re-auth with \`${loginCommand}\`.`;
  }
  return "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";
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

  while (pending.length > 0) {
    const candidate = pending.shift();
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

export async function runAgentTurnWithFallback(params: {
  commandBody: string;
  followupRun: FollowupRun;
  sessionCtx: TemplateContext;
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
  getActiveSessionEntry: () => SessionEntry | undefined;
  activeSessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
}): Promise<AgentRunLoopResult> {
  const TRANSIENT_HTTP_RETRY_DELAY_MS = 2_500;
  let didLogHeartbeatStrip = false;
  let autoCompactionCount = 0;
  // Track payloads sent directly (not via pipeline) during tool flush to avoid duplicates.
  const directlySentBlockKeys = new Set<string>();
  const runtimeConfig = resolveQueuedReplyRuntimeConfig(params.followupRun.run.config);
  const effectiveRun =
    runtimeConfig === params.followupRun.run.config
      ? params.followupRun.run
      : {
          ...params.followupRun.run,
          config: runtimeConfig,
        };

  const runId = params.opts?.runId ?? crypto.randomUUID();
  const normalizeReplyMediaPaths = createReplyMediaPathNormalizer({
    cfg: runtimeConfig,
    sessionKey: params.sessionKey,
    workspaceDir: params.followupRun.run.workspaceDir,
  });
  let didNotifyAgentRunStart = false;
  const notifyAgentRunStart = () => {
    if (didNotifyAgentRunStart) {
      return;
    }
    didNotifyAgentRunStart = true;
    params.opts?.onAgentRunStart?.(runId);
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
  const persistFallbackCandidateSelection = async (
    provider: string,
    model: string,
  ): Promise<(() => Promise<void>) | undefined> => {
    if (
      !params.sessionKey ||
      !params.activeSessionStore ||
      (provider === params.followupRun.run.provider && model === params.followupRun.run.model)
    ) {
      return undefined;
    }

    const activeSessionEntry =
      params.getActiveSessionEntry() ?? params.activeSessionStore[params.sessionKey];
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
        Boolean(normalizeOptionalString(activeSessionEntry.modelOverride)));
    if (isUserModelOverride) {
      return undefined;
    }

    const previousState = snapshotFallbackSelectionState(activeSessionEntry);
    const applied = applyFallbackCandidateSelectionToEntry({
      entry: activeSessionEntry,
      run: params.followupRun.run,
      provider,
      model,
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
            normalizeStreamingText,
            applyReplyToMode: params.applyReplyToMode,
            normalizeMediaPaths: normalizeReplyMediaPaths,
            typingSignals: params.typingSignals,
            blockStreamingEnabled: params.blockStreamingEnabled,
            blockReplyPipeline,
            directlySentBlockKeys,
          })
        : undefined;
      const onToolResult = params.opts?.onToolResult;
      const fallbackResult = await runWithModelFallback({
        ...resolveModelFallbackOptions(params.followupRun.run),
        runId,
        run: async (provider, model, runOptions) => {
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
            );
          } catch (error) {
            logVerbose(
              `failed to persist fallback candidate selection (non-fatal): ${String(error)}`,
            );
          }

          if (isCliProvider(provider, runtimeConfig)) {
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
            const cliSessionBinding = getCliSessionBinding(
              params.getActiveSessionEntry(),
              provider,
            );
            const authProfileId =
              provider === params.followupRun.run.provider
                ? params.followupRun.run.authProfileId
                : undefined;
            return (async () => {
              let lifecycleTerminalEmitted = false;
              try {
                const result = await runCliAgent({
                  sessionId: params.followupRun.run.sessionId,
                  sessionKey: params.sessionKey,
                  agentId: params.followupRun.run.agentId,
                  sessionFile: params.followupRun.run.sessionFile,
                  workspaceDir: params.followupRun.run.workspaceDir,
                  config: runtimeConfig,
                  prompt: params.commandBody,
                  provider,
                  model,
                  thinkLevel: params.followupRun.run.thinkLevel,
                  timeoutMs: params.followupRun.run.timeoutMs,
                  runId,
                  extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
                  ownerNumbers: params.followupRun.run.ownerNumbers,
                  cliSessionId: cliSessionBinding?.sessionId,
                  cliSessionBinding,
                  authProfileId,
                  bootstrapPromptWarningSignaturesSeen,
                  bootstrapPromptWarningSignature:
                    bootstrapPromptWarningSignaturesSeen[
                      bootstrapPromptWarningSignaturesSeen.length - 1
                    ],
                  images: params.opts?.images,
                  imageOrder: params.opts?.imageOrder,
                  skillsSnapshot: params.followupRun.run.skillsSnapshot,
                  messageProvider: params.followupRun.run.messageProvider,
                  agentAccountId: params.followupRun.run.agentAccountId,
                  senderIsOwner: params.followupRun.run.senderIsOwner,
                  abortSignal: params.replyOperation?.abortSignal ?? params.opts?.abortSignal,
                  replyOperation: params.replyOperation,
                });
                bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
                  result.meta?.systemPromptReport,
                );

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
                if (rollbackFallbackCandidateSelection) {
                  try {
                    await rollbackFallbackCandidateSelection();
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
              run: effectiveRun,
              sessionCtx: params.sessionCtx,
              hasRepliedRef: params.opts?.hasRepliedRef,
              provider,
              runId,
              allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
              model,
            },
          );
          return (async () => {
            let attemptCompactionCount = 0;
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
                prompt: params.commandBody,
                extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
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
                suppressToolErrorWarnings: params.opts?.suppressToolErrorWarnings,
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
                      await params.typingSignals.signalToolStart();
                      await params.opts?.onToolStart?.({ name, phase });
                    }
                  }
                  if (evt.stream === "item") {
                    await params.opts?.onItemEvent?.({
                      itemId: readStringValue(evt.data.itemId),
                      kind: readStringValue(evt.data.kind),
                      title: readStringValue(evt.data.title),
                      name: readStringValue(evt.data.name),
                      phase: readStringValue(evt.data.phase),
                      status: readStringValue(evt.data.status),
                      summary: readStringValue(evt.data.summary),
                      progressText: readStringValue(evt.data.progressText),
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
                    if (phase === "start") {
                      // Keep custom compaction callbacks active, but gate the
                      // fallback user-facing notice behind explicit opt-in.
                      const notifyUser =
                        runtimeConfig?.agents?.defaults?.compaction?.notifyUser === true;
                      if (params.opts?.onCompactionStart) {
                        await params.opts.onCompactionStart();
                      } else if (notifyUser && params.opts?.onBlockReply) {
                        // Send directly via opts.onBlockReply (bypassing the
                        // pipeline) so the notice does not cause final payloads
                        // to be discarded on non-streaming model paths.
                        const currentMessageId =
                          params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid;
                        const noticePayload = params.applyReplyToMode({
                          text: "🧹 Compacting context...",
                          replyToId: currentMessageId,
                          replyToCurrent: true,
                          isCompactionNotice: true,
                        });
                        try {
                          await params.opts.onBlockReply(noticePayload);
                        } catch (err) {
                          // Non-critical notice delivery failure should not
                          // bubble out of the fire-and-forget event handler.
                          logVerbose(
                            `compaction start notice delivery failed (non-fatal): ${String(err)}`,
                          );
                        }
                      }
                    }
                    const completed = evt.data?.completed === true;
                    if (phase === "end" && completed) {
                      attemptCompactionCount += 1;
                      await params.opts?.onCompactionEnd?.();
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
                } catch (rollbackError) {
                  logVerbose(
                    `failed to roll back fallback candidate selection (non-fatal): ${String(rollbackError)}`,
                  );
                }
              }
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
          payload: {
            text: "⚠️ Context limit exceeded. I've reset our conversation to start fresh - please try again.\n\nTo prevent this, increase your compaction buffer by setting `agents.defaults.compaction.reserveTokensFloor` to 20000 or higher in your config.",
          },
        };
      }
      if (embeddedError?.kind === "role_ordering") {
        const didReset = await params.resetSessionAfterRoleOrderingConflict(embeddedError.message);
        if (didReset) {
          params.replyOperation?.fail("run_failed", embeddedError);
          return {
            kind: "final",
            payload: {
              text: "⚠️ Message ordering conflict. I've reset the conversation - please try again.",
            },
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
            : "⚠️ Agent failed before reply: model switch could not be completed. " +
              "The requested model may be temporarily unavailable. Please try again shortly.";
          params.replyOperation?.fail("run_failed", err);
          return {
            kind: "final",
            payload: {
              text: switchErrorText,
            },
          };
        }
        params.followupRun.run.provider = err.provider;
        params.followupRun.run.model = err.model;
        params.followupRun.run.authProfileId = err.authProfileId;
        params.followupRun.run.authProfileIdSource = err.authProfileId
          ? err.authProfileIdSource
          : undefined;
        fallbackProvider = err.provider;
        fallbackModel = err.model;
        continue;
      }
      const message = formatErrorMessage(err);
      const isBilling = isBillingErrorMessage(message);
      const isContextOverflow = !isBilling && isLikelyContextOverflowError(message);
      const isCompactionFailure = !isBilling && isCompactionFailureError(message);
      const isSessionCorruption = /function call turn comes immediately after/i.test(message);
      const isRoleOrderingError = /incorrect role information|roles must alternate/i.test(message);
      const isTransientHttp = isTransientHttpError(message);

      if (isReplyOperationRestartAbort(params.replyOperation)) {
        return {
          kind: "final",
          payload: {
            text: buildRestartLifecycleReplyText(),
          },
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
          payload: {
            text: buildRestartLifecycleReplyText(),
          },
        };
      }

      if (restartLifecycleError instanceof CommandLaneClearedError) {
        params.replyOperation?.fail("command_lane_cleared", restartLifecycleError);
        return {
          kind: "final",
          payload: {
            text: buildRestartLifecycleReplyText(),
          },
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
          payload: {
            text: "⚠️ Context limit exceeded during compaction. I've reset our conversation to start fresh - please try again.\n\nTo prevent this, increase your compaction buffer by setting `agents.defaults.compaction.reserveTokensFloor` to 20000 or higher in your config.",
          },
        };
      }
      if (isRoleOrderingError) {
        const didReset = await params.resetSessionAfterRoleOrderingConflict(message);
        if (didReset) {
          params.replyOperation?.fail("run_failed", err);
          return {
            kind: "final",
            payload: {
              text: "⚠️ Message ordering conflict. I've reset the conversation - please try again.",
            },
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
          payload: {
            text: "⚠️ Session history was corrupted. I've reset the conversation - please try again!",
          },
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
      const isRateLimit = isFallbackSummaryError(err)
        ? isPureTransientRateLimitSummary(err)
        : isRateLimitErrorMessage(message);
      const safeMessage = isTransientHttp
        ? sanitizeUserFacingText(message, { errorContext: true })
        : message;
      const trimmedMessage = safeMessage.replace(/\.\s*$/, "");
      const fallbackText = isBilling
        ? BILLING_ERROR_USER_MESSAGE
        : isRateLimit
          ? buildRateLimitCooldownMessage(err)
          : isContextOverflow
            ? "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model."
            : isRoleOrderingError
              ? "⚠️ Message ordering conflict - please try again. If this persists, use /new to start a fresh session."
              : shouldSurfaceToControlUi
                ? `⚠️ Agent failed before reply: ${trimmedMessage}.\nLogs: openclaw logs --follow`
                : buildExternalRunFailureText(message);

      params.replyOperation?.fail("run_failed", err);
      return {
        kind: "final",
        payload: {
          text: fallbackText,
        },
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
        payload: {
          text: "⚠️ Context overflow — this conversation is too large for the model. Use /new to start a fresh session.",
        },
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
      if (
        errorCandidate &&
        (isRateLimitErrorMessage(errorCandidate) || isOverloadedErrorMessage(errorCandidate))
      ) {
        const isOverloaded = isOverloadedErrorMessage(errorCandidate);
        runResult.payloads = [
          {
            text: isOverloaded
              ? "⚠️ The AI service is temporarily overloaded. Please try again in a moment."
              : "⚠️ API rate limit reached — the model couldn't generate a response. Please try again in a moment.",
            isError: true,
          },
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
