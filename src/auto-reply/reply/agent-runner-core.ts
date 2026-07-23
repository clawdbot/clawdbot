import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasSessionAutoModelFallbackProvenance } from "../../agents/agent-scope.js";
import { hasVisibleCommittedMessagingToolDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { enqueueCommitmentExtraction } from "../../commitments/runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveSessionPluginStatusLines,
  resolveSessionPluginTraceLines,
  type SessionEntry,
} from "../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { parseSessionThreadInfoFast } from "../../config/sessions/thread-info.js";
import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { CommandLaneClearedError, GatewayDrainingError } from "../../process/command-queue.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import {
  type DeliveryContext,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { resolveFallbackTransition } from "../fallback-state.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import {
  isReplyPayloadStatusNotice,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { buildKnownAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import type { BlockReplyPipeline } from "./block-reply-pipeline.js";
import { resolveEffectiveReplyRoute } from "./effective-reply-route.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import { resolveOriginMessageTo } from "./origin-routing.js";
import {
  buildPendingFinalDeliveryText,
  sanitizePendingFinalDeliveryText,
} from "./pending-final-delivery.js";
import { type FollowupRun, type QueueSettings, scheduleFollowupDrain } from "./queue.js";
import { normalizeReplyPayloadDirectives } from "./reply-delivery.js";
import { type ReplyOperation, runAfterReplyOperationClear } from "./reply-run-registry.js";
import { resolveSourceReplyVisibilityPolicy } from "./source-reply-delivery-mode.js";
import type { TypingController } from "./typing.js";
export const BLOCK_REPLY_SEND_TIMEOUT_MS = 15_000;

const RESTART_LIFECYCLE_REPLY_TEXT =
  "⚠️ Gateway is restarting. Please wait a few seconds and try again.";

export function scheduleFollowupDrainAfterReplyOperationClear(params: {
  operation: ReplyOperation;
  queueKey: string;
  runFollowup: (run: FollowupRun) => Promise<void>;
}): void {
  runAfterReplyOperationClear(params.operation, (admissionSessionId) => {
    const completedSessionId = params.operation.sessionId;
    const runFollowupAfterClear =
      admissionSessionId === completedSessionId
        ? params.runFollowup
        : (queued: FollowupRun) =>
            params.runFollowup(
              queued.run.sessionId === completedSessionId
                ? { ...queued, admissionSessionId }
                : queued,
            );
    scheduleFollowupDrain(params.queueKey, runFollowupAfterClear);
  });
}

export function markBeforeAgentRunBlockedPayloads(payloads: ReplyPayload[]): ReplyPayload[] {
  return payloads.map((payload) =>
    setReplyPayloadMetadata(payload, { beforeAgentRunBlocked: true }),
  );
}

export function resolvePendingFinalDeliveryRetryText(params: {
  isHeartbeat: boolean;
  payload: ReplyPayload;
}): string {
  const pendingText = buildPendingFinalDeliveryText([params.payload]);
  if (!params.isHeartbeat) {
    return pendingText;
  }
  const stripped = stripHeartbeatToken(pendingText, { mode: "message" });
  return stripped.shouldSkip ? "" : stripped.text || pendingText;
}

export function buildSilentFallbackFailurePayload(params: {
  fallbackTransition: ReturnType<typeof resolveFallbackTransition>;
  fallbackFailureKnown: boolean;
  isHeartbeat: boolean;
  hasSuccessfulTerminalDelivery: boolean;
  allowEmptyAssistantReplyAsSilent?: boolean;
  silentExpected?: boolean;
}): ReplyPayload | undefined {
  if (
    params.isHeartbeat ||
    params.allowEmptyAssistantReplyAsSilent === true ||
    params.silentExpected === true ||
    params.hasSuccessfulTerminalDelivery ||
    !params.fallbackTransition.fallbackActive ||
    !params.fallbackFailureKnown
  ) {
    return undefined;
  }
  return markReplyPayloadForSourceSuppressionDelivery({
    text:
      `⚠️ I couldn't reach the configured model backend ${params.fallbackTransition.selectedModelRef}. ` +
      `Fallback used ${params.fallbackTransition.activeModelRef}, but it produced no visible reply.`,
    isError: true,
  });
}

export function resolveSourceReplyPolicy(params: {
  cfg: OpenClawConfig;
  sessionCtx: TemplateContext;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  runtimePolicySessionKey?: string;
  opts?: GetReplyOptions;
}): ReturnType<typeof resolveSourceReplyVisibilityPolicy> {
  const sendPolicy = resolveSendPolicy({
    cfg: params.cfg,
    entry: params.sessionEntry,
    sessionKey: params.runtimePolicySessionKey ?? params.sessionKey,
    channel:
      params.sessionCtx.OriginatingChannel ??
      params.sessionCtx.Surface ??
      params.sessionCtx.Provider ??
      sessionDeliveryChannel(params.sessionEntry),
    chatType: params.sessionEntry?.chatType,
  });
  return resolveSourceReplyVisibilityPolicy({
    cfg: params.cfg,
    ctx: params.sessionCtx,
    requested: params.opts?.sourceReplyDeliveryMode,
    sendPolicy,
  });
}

export function resolveReplyRunDeliveryContext(params: {
  cfg: OpenClawConfig;
  sessionCtx: TemplateContext;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  runtimePolicySessionKey?: string;
  opts?: GetReplyOptions;
}): DeliveryContext | undefined {
  const sourceReplyPolicy = resolveSourceReplyPolicy(params);
  if (
    params.sessionCtx.InboundEventKind === "room_event" ||
    sourceReplyPolicy.sendPolicyDenied ||
    (sourceReplyPolicy.suppressDelivery &&
      sourceReplyPolicy.sourceReplyDeliveryMode !== "message_tool_only")
  ) {
    return undefined;
  }
  const threadId =
    normalizeOptionalString(params.sessionCtx.MessageThreadId) ??
    normalizeOptionalString(params.sessionCtx.TransportThreadId) ??
    normalizeOptionalString(
      parseSessionThreadInfoFast(params.sessionCtx.SessionKey ?? params.sessionKey).threadId,
    );
  return normalizeDeliveryContext({
    ...resolveEffectiveReplyRoute({
      ctx: params.sessionCtx,
      entry: params.sessionEntry,
    }),
    threadId,
  });
}

export function hasSuccessfulSourceReplyDelivery(params: {
  blockReplyPipeline: { didStream: () => boolean; isAborted: () => boolean } | null;
  directlySentBlockKeys?: Set<string>;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: unknown[];
}): boolean {
  return (
    (params.blockReplyPipeline?.didStream() && !params.blockReplyPipeline.isAborted()) ||
    (params.directlySentBlockKeys?.size ?? 0) > 0 ||
    hasVisibleCommittedMessagingToolDeliveryEvidence(params)
  );
}

export function hasSuccessfulTerminalSourceReplyDelivery(params: {
  blockReplyPipeline: {
    didStreamTerminalReply?: () => boolean;
    isAborted: () => boolean;
  } | null;
  directlySentBlockPayloads?: ReplyPayload[];
}): boolean {
  const sentTerminalBlock = params.directlySentBlockPayloads?.some(
    (payload) =>
      payload.isReasoning !== true &&
      payload.isCommentary !== true &&
      !isReplyPayloadStatusNotice(payload) &&
      normalizeReplyPayload(payload, { applyChannelTransforms: false }) !== null,
  );
  return (
    (params.blockReplyPipeline?.didStreamTerminalReply?.() === true &&
      !params.blockReplyPipeline.isAborted()) ||
    sentTerminalBlock === true
  );
}

export function resolveConfiguredFallbackModel(params: {
  run: FollowupRun["run"];
  fallbackStateEntry?: SessionEntry;
}): { provider: string; model: string; persistedAutoFallback: boolean } {
  const entry = params.fallbackStateEntry;
  const isAutoFallbackOverride =
    entry?.modelOverrideSource === "auto" ||
    (entry !== undefined &&
      entry.modelOverrideSource === undefined &&
      hasSessionAutoModelFallbackProvenance(entry));
  if (isAutoFallbackOverride && entry !== undefined) {
    const originProvider = normalizeOptionalString(entry.modelOverrideFallbackOriginProvider);
    const originModel = normalizeOptionalString(entry.modelOverrideFallbackOriginModel);
    if (originProvider && originModel) {
      return { provider: originProvider, model: originModel, persistedAutoFallback: true };
    }
  }
  return {
    provider: params.run.provider,
    model: params.run.model,
    persistedAutoFallback: false,
  };
}

export function buildInlinePluginStatusPayload(params: {
  entry: SessionEntry | undefined;
  includeTraceLines: boolean;
}): ReplyPayload | undefined {
  const statusLines =
    params.entry?.verboseLevel && params.entry.verboseLevel !== "off"
      ? resolveSessionPluginStatusLines(params.entry)
      : [];
  const traceLines =
    params.includeTraceLines &&
    (params.entry?.traceLevel === "on" || params.entry?.traceLevel === "raw")
      ? resolveSessionPluginTraceLines(params.entry)
      : [];
  const lines = [...statusLines, ...traceLines];
  if (lines.length === 0) {
    return undefined;
  }
  return { text: lines.join("\n") };
}

function joinCommitmentAssistantText(payloads: ReplyPayload[]): string {
  return payloads
    .filter(
      (payload) => !payload.isError && !payload.isReasoning && !isReplyPayloadStatusNotice(payload),
    )
    .map((payload) => payload.text?.trim())
    .filter((text): text is string => Boolean(text))
    .join("\n")
    .trim();
}

export function normalizeAssistantFinalDeliveryText(text: string): string {
  const parsed = normalizeReplyPayloadDirectives({
    payload: { text },
    trimLeadingWhitespace: true,
    parseMode: "auto",
  });
  return sanitizePendingFinalDeliveryText(parsed.payload.text ?? "");
}

export function enqueueCommitmentExtractionForTurn(params: {
  cfg: OpenClawConfig;
  commandBody: string;
  isHeartbeat: boolean;
  followupRun: FollowupRun;
  sessionCtx: TemplateContext;
  sessionKey?: string;
  replyToChannel?: string;
  payloads: ReplyPayload[];
  runId: string;
}): void {
  if (params.isHeartbeat) {
    return;
  }
  const userText = params.commandBody.trim() || params.sessionCtx.agentText?.trim() || "";
  const assistantText = joinCommitmentAssistantText(params.payloads);
  const sessionKey = params.sessionKey ?? params.followupRun.run.sessionKey;
  const channel =
    params.replyToChannel ??
    params.followupRun.run.messageProvider ??
    params.sessionCtx.Surface ??
    params.sessionCtx.Provider;
  if (!userText || !assistantText || !sessionKey || !channel) {
    return;
  }
  const to = resolveOriginMessageTo({
    originatingTo: params.sessionCtx.OriginatingTo,
    to: params.sessionCtx.To,
  });
  enqueueCommitmentExtraction({
    cfg: params.cfg,
    agentId: params.followupRun.run.agentId,
    sessionKey,
    channel,
    ...(params.sessionCtx.AccountId ? { accountId: params.sessionCtx.AccountId } : {}),
    ...(to ? { to } : {}),
    ...(params.sessionCtx.MessageThreadId !== undefined
      ? { threadId: String(params.sessionCtx.MessageThreadId) }
      : {}),
    ...(params.followupRun.run.senderId ? { senderId: params.followupRun.run.senderId } : {}),
    userText,
    assistantText,
    ...(params.sessionCtx.MessageSidFull || params.sessionCtx.MessageSid
      ? { sourceMessageId: params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid }
      : {}),
    sourceRunId: params.runId,
  });
}

export function refreshSessionEntryFromStore(params: {
  storePath?: string;
  sessionKey?: string;
  fallbackEntry?: SessionEntry;
  activeSessionStore?: Record<string, SessionEntry>;
}): SessionEntry | undefined {
  const { storePath, sessionKey, fallbackEntry, activeSessionStore } = params;
  if (!storePath || !sessionKey) {
    return fallbackEntry;
  }
  try {
    const latestEntry = loadSessionEntryReadOnly({
      storePath,
      sessionKey,
    });
    if (!latestEntry) {
      return fallbackEntry;
    }
    if (activeSessionStore) {
      activeSessionStore[sessionKey] = latestEntry;
    }
    return latestEntry;
  } catch {
    return fallbackEntry;
  }
}

export function resolveAdmittedRunSessionFile(params: {
  agentId: string;
  sessionId: string;
  sessionFile?: string;
  storePath?: string;
}): string | undefined {
  if (params.sessionFile) {
    return params.sessionFile;
  }
  if (params.storePath) {
    return params.sessionId;
  }
  return params.sessionFile;
}

export async function handleReplyAgentRunError(
  error: unknown,
  context: {
    cfg: OpenClawConfig;
    isRestartRecoveryArmed: () => boolean;
    replyOperation: ReplyOperation;
    resolvedVerboseLevel: VerboseLevel;
    returnWithQueuedFollowupDrain: <T>(value: T) => T;
    sessionCtx: TemplateContext;
  },
): Promise<ReplyPayload | undefined> {
  const {
    cfg,
    isRestartRecoveryArmed,
    replyOperation,
    resolvedVerboseLevel,
    returnWithQueuedFollowupDrain,
    sessionCtx,
  } = context;

  if (
    replyOperation.result?.kind === "aborted" &&
    replyOperation.result.code === "aborted_by_user"
  ) {
    return returnWithQueuedFollowupDrain({ text: SILENT_REPLY_TOKEN });
  }
  if (
    replyOperation.result?.kind === "aborted" &&
    replyOperation.result.code === "aborted_for_restart"
  ) {
    if (isRestartRecoveryArmed()) {
      return returnWithQueuedFollowupDrain({ text: SILENT_REPLY_TOKEN });
    }
    return returnWithQueuedFollowupDrain(
      markReplyPayloadForSourceSuppressionDelivery({
        text: RESTART_LIFECYCLE_REPLY_TEXT,
      }),
    );
  }
  if (error instanceof GatewayDrainingError) {
    replyOperation.fail("gateway_draining", error);
    return returnWithQueuedFollowupDrain(
      markReplyPayloadForSourceSuppressionDelivery({
        text: RESTART_LIFECYCLE_REPLY_TEXT,
      }),
    );
  }
  if (error instanceof CommandLaneClearedError) {
    replyOperation.fail("command_lane_cleared", error);
    return returnWithQueuedFollowupDrain(
      markReplyPayloadForSourceSuppressionDelivery({
        text: RESTART_LIFECYCLE_REPLY_TEXT,
      }),
    );
  }
  const knownFailurePayload = buildKnownAgentRunFailureReplyPayload({
    err: error,
    sessionCtx,
    resolvedVerboseLevel,
    cfg,
  });
  if (knownFailurePayload) {
    replyOperation.fail("run_failed", error);
    return returnWithQueuedFollowupDrain(knownFailurePayload);
  }
  replyOperation.fail("run_failed", error);
  // Keep the followup queue moving even when an unexpected exception escapes
  // the run path; the caller still receives the original error.
  returnWithQueuedFollowupDrain(undefined);
  throw error;
}

export async function cleanupReplyAgentRun(context: {
  blockReplyPipeline: BlockReplyPipeline | null;
  clearRestartRecoveryDeliveryClaim: () => Promise<void>;
  providedReplyOperation: ReplyOperation | undefined;
  queueKey: string;
  replyOperation: ReplyOperation;
  runFollowupTurn: (queued: FollowupRun) => Promise<void>;
  sessionKey: string | undefined;
  shouldDrainQueuedFollowupsAfterClear: boolean;
  typing: TypingController;
}): Promise<void> {
  const {
    blockReplyPipeline,
    clearRestartRecoveryDeliveryClaim,
    providedReplyOperation,
    queueKey,
    replyOperation,
    runFollowupTurn,
    sessionKey,
    shouldDrainQueuedFollowupsAfterClear,
    typing,
  } = context;

  try {
    await clearRestartRecoveryDeliveryClaim();
  } catch (error) {
    logVerbose(
      `failed to clear restart recovery delivery context for ${sessionKey ?? "unknown"}: ${String(
        error,
      )}`,
    );
  }
  if (shouldDrainQueuedFollowupsAfterClear) {
    scheduleFollowupDrainAfterReplyOperationClear({
      operation: replyOperation,
      queueKey,
      runFollowup: runFollowupTurn,
    });
    if (!providedReplyOperation) {
      replyOperation.complete();
    }
  } else if (!providedReplyOperation) {
    replyOperation.complete();
  }
  blockReplyPipeline?.stop();
  typing.markRunComplete();
  // Safety net: the dispatcher's onIdle callback normally fires
  // markDispatchIdle(), but if the dispatcher exits early, errors,
  // or the reply path doesn't go through it cleanly, the second
  // signal never fires and the typing keepalive loop runs forever.
  // Calling this twice is harmless — cleanup() is guarded by the
  // `active` flag.  Same pattern as the followup runner fix (#26881).
  typing.markDispatchIdle();
}

export type RunReplyAgentParams = {
  commandBody: string;
  transcriptCommandBody?: string;
  followupRun: FollowupRun;
  queueKey: string;
  resolvedQueue: QueueSettings;
  shouldSteer: boolean;
  shouldFollowup: boolean;
  isActive: boolean;
  isRunActive?: () => boolean;
  isStreaming: boolean;
  opts?: InternalGetReplyOptions;
  typing: TypingController;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  toolProgressDetail?: "explain" | "raw";
  isNewSession: boolean;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  sessionCtx: TemplateContext;
  shouldInjectGroupIntro: boolean;
  typingMode: TypingMode;
  resetTriggered?: boolean;
  replyThreadingOverride?: TemplateContext["ReplyThreading"];
  replyOperation?: ReplyOperation;
};
