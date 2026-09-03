import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasSessionAutoModelFallbackProvenance } from "../../agents/agent-scope.js";
import { hasVisibleCommittedMessagingToolDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import type { ModelRef } from "../../agents/model-ref-shared.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveSessionPluginStatusLines,
  resolveSessionPluginTraceLines,
  type SessionEntry,
} from "../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { CommandLaneClearedError, GatewayDrainingError } from "../../process/command-queue.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import {
  sessionDeliveryChannel,
  type DeliveryContext,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { resolveFallbackTransition } from "../fallback-state.js";
import {
  isReplyPayloadTerminalContent,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  buildKnownAgentRunFailureReplyPayload,
  buildTerminalAgentRunFailureReplyPayload,
} from "./agent-runner-failure-reply.js";
import type { BlockReplyPipeline } from "./block-reply-pipeline.js";
import { resolveEffectiveReplyRoute } from "./effective-reply-route.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import { sanitizePendingFinalDeliveryText } from "./pending-final-delivery.js";
import { type FollowupRun, type QueueSettings, scheduleFollowupDrain } from "./queue.js";
import { normalizeReplyPayloadDirectives } from "./reply-delivery.js";
import { isReplyOperationSuperseded } from "./reply-operation-abort.js";
import { type ReplyOperation, runAfterReplyOperationClear } from "./reply-run-registry.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
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
  return normalizeDeliveryContext({
    ...resolveEffectiveReplyRoute({
      ctx: params.sessionCtx,
      entry: params.sessionEntry,
    }),
    threadId: resolveRoutedDeliveryThreadId({
      ctx: params.sessionCtx,
      sessionKey: params.sessionCtx.SessionKey ?? params.sessionKey,
    }),
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
      isReplyPayloadTerminalContent(payload) &&
      normalizeReplyPayload(payload, { applyChannelTransforms: false }) !== null,
  );
  return (
    (params.blockReplyPipeline?.didStreamTerminalReply?.() === true &&
      !params.blockReplyPipeline.isAborted()) ||
    sentTerminalBlock === true
  );
}

export function resolveFallbackOriginModel(params: {
  run: FollowupRun["run"];
  fallbackStateEntry?: SessionEntry;
  runtimeModelSelection?: ModelRef;
}): { provider: string; model: string; persistedAutoFallback: boolean } {
  // Runtime-owned selection is not a fallback from the caller's nominal model.
  if (params.runtimeModelSelection) {
    return { ...params.runtimeModelSelection, persistedAutoFallback: false };
  }
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

export function normalizeAssistantFinalDeliveryText(text: string): string {
  const parsed = normalizeReplyPayloadDirectives({
    payload: { text },
    trimLeadingWhitespace: true,
    parseMode: "auto",
  });
  return sanitizePendingFinalDeliveryText(parsed.payload.text ?? "");
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
  sessionKey?: string;
  storePath?: string;
}): string | undefined {
  if (params.sessionKey?.trim()) {
    return params.sessionKey.trim();
  }
  return params.sessionFile;
}

export async function handleReplyAgentRunError(
  error: unknown,
  context: {
    cfg: OpenClawConfig;
    resolveVisibleReplyDelivery: () => Promise<boolean>;
    isHeartbeat: boolean;
    isRestartRecoveryArmed: () => boolean;
    replyOperation: ReplyOperation;
    resolvedVerboseLevel: VerboseLevel;
    returnWithQueuedFollowupDrain: <T>(value: T) => T;
    sessionCtx: TemplateContext;
  },
): Promise<ReplyPayload | undefined> {
  const {
    cfg,
    resolveVisibleReplyDelivery,
    isHeartbeat,
    isRestartRecoveryArmed,
    replyOperation,
    resolvedVerboseLevel,
    returnWithQueuedFollowupDrain,
    sessionCtx,
  } = context;

  if (isReplyOperationSuperseded(replyOperation)) {
    return { text: SILENT_REPLY_TOKEN };
  }
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
  const visibleReplyDelivered = await resolveVisibleReplyDelivery();
  if (!isHeartbeat && visibleReplyDelivered && !replyOperation.abortSignal.aborted) {
    replyOperation.fail("run_failed", error);
    return returnWithQueuedFollowupDrain(
      buildTerminalAgentRunFailureReplyPayload({
        visibleReplyDelivered: true,
        sessionCtx,
        cfg,
      }),
    );
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
  queueAdmissionState?: "empty" | "steering" | "ready";
  isActive: boolean;
  isRunActive?: () => boolean;
  opts?: InternalGetReplyOptions;
  typing: TypingController;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  storePath?: string;
  defaultModel: string;
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
