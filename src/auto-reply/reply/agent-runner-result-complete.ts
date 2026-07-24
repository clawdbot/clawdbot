import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasConfiguredModelFallbacks, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveModelAuthMode } from "../../agents/model-auth.js";
import { isCliProvider } from "../../agents/model-selection.js";
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS, stripHeartbeatToken } from "../heartbeat.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  buildInlinePluginStatusPayload,
  markBeforeAgentRunBlockedPayloads,
  resolvePendingFinalDeliveryRetryText,
  resolveReplyRunDeliveryContext,
  resolveSourceReplyPolicy,
} from "./agent-runner-core.js";
import { normalizeAssistantFinalDeliveryText } from "./agent-runner-core.js";
import type { accountReplyAgentRun } from "./agent-runner-result-accounting.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import {
  accumulateSessionUsageFromTranscript,
  buildInlineRawTracePayload,
  derivePromptSegments,
} from "./agent-runner-trace.js";
import {
  type TraceCompletionView,
  type TraceContextManagementView,
  type TraceExecutionView,
  type TracePromptSegmentView,
  type TraceToolSummaryView,
  mergeExecutionTrace,
} from "./agent-runner-trace.js";
import { appendUsageLine } from "./agent-runner-usage-line.js";
import { buildPendingFinalDeliveryText } from "./pending-final-delivery.js";
import { readPostCompactionContext } from "./post-compaction-context.js";
import {
  shouldWarnAboutPrivateMessageToolFinal,
  warnPrivateMessageToolFinal,
} from "./private-message-tool-final.js";
import { enqueueFollowupRun, refreshQueuedFollowupSession } from "./queue.js";
import { incrementRunCompactionCount } from "./session-run-accounting.js";
import {
  buildStrandedReplyDeliveryFailurePayload,
  buildStrandedReplyRetryFollowupRun,
} from "./stranded-reply-recovery.js";
type ReplyAgentAccounting = Awaited<ReturnType<typeof accountReplyAgentRun>>;
type PreparedReplyAgentPayloads = {
  kind: "continue";
  activeSessionEntry: SessionEntry | undefined;
  completedSourceReplyDelivery: boolean;
  guardedReplyPayloads: ReplyPayload[];
  responseUsageLine: string | undefined;
};

export async function completeReplyAgentRun(input: {
  context: FinalizeReplyAgentRunInput;
  accounting: ReplyAgentAccounting;
  prepared: PreparedReplyAgentPayloads;
}) {
  const { context, accounting, prepared } = input;
  const {
    activeIsNewSession,
    activeSessionStore,
    cfg,
    followupRun,
    isHeartbeat,
    opts,
    preflightCompactionApplied,
    queueKey,
    resolvedBlockStreamingBreak,
    resolvedQueue,
    resolvedVerboseLevel,
    returnWithQueuedFollowupDrain,
    runFollowupTurn,
    runtimePolicySessionKey,
    sessionCtx,
    sessionKey,
    storePath,
  } = context;
  const {
    autoCompactionCount,
    contextTokensUsed,
    fallbackAttempts,
    fallbackExhausted,
    modelUsed,
    promptTokens,
    providerUsed,
    runResult,
    verboseEnabled,
  } = accounting;
  const { completedSourceReplyDelivery, guardedReplyPayloads, responseUsageLine } = prepared;
  let { activeSessionEntry } = prepared;

  // Prepend verbose operational notices. Model fallback notices are prepared
  // earlier so they pass through normal reply threading and stream-dedupe.
  let finalPayloads = guardedReplyPayloads;
  const prefixNotices: ReplyPayload[] = [];

  if (verboseEnabled && activeIsNewSession) {
    prefixNotices.push({ text: `🧭 New session: ${followupRun.run.sessionId}` });
  }

  if (autoCompactionCount > 0) {
    const previousSessionId = activeSessionEntry?.sessionId ?? followupRun.run.sessionId;
    const count = await incrementRunCompactionCount({
      cfg,
      sessionEntry: activeSessionEntry,
      sessionStore: activeSessionStore,
      sessionKey,
      storePath,
      amount: autoCompactionCount,
      compactionTokensAfter: runResult.meta?.agentMeta?.compactionTokensAfter,
      lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
      contextTokensUsed,
      newSessionId: runResult.meta?.agentMeta?.sessionId,
      newSessionFile: runResult.meta?.agentMeta?.sessionFile,
    });
    const refreshedSessionEntry =
      sessionKey && activeSessionStore ? activeSessionStore[sessionKey] : undefined;
    if (refreshedSessionEntry) {
      activeSessionEntry = refreshedSessionEntry;
      refreshQueuedFollowupSession({
        key: queueKey,
        previousSessionId,
        nextSessionId: refreshedSessionEntry.sessionId,
        nextSessionFile: refreshedSessionEntry.sessionFile,
      });
    }

    // Inject post-compaction workspace context for the next agent turn
    if (sessionKey) {
      readPostCompactionContext(followupRun.run.workspaceDir, {
        cfg,
        agentId: resolveSessionAgentId({ sessionKey, config: cfg }),
      })
        .then((contextContent) => {
          if (contextContent) {
            enqueueSystemEvent(contextContent, { sessionKey });
          }
        })
        .catch(() => {
          // Silent failure — post-compaction context is best-effort
        });
    }

    if (verboseEnabled) {
      const suffix = typeof count === "number" ? ` (count ${count})` : "";
      prefixNotices.push({ text: `🧹 Auto-compaction complete${suffix}.` });
    }
  }
  const prefixPayloads = [...prefixNotices];
  const isHookBlockedRun = runResult.meta?.error?.kind === "hook_block";
  const rawUserText = isHookBlockedRun
    ? runResult.meta?.finalPromptText
    : (runResult.meta?.finalPromptText ?? (sessionCtx.commandText || sessionCtx.agentText));
  const rawAssistantText = isHookBlockedRun
    ? undefined
    : (runResult.meta?.finalAssistantRawText ?? runResult.meta?.finalAssistantVisibleText);
  const traceAuthorized = followupRun.run.traceAuthorized === true;
  const executionTrace = mergeExecutionTrace({
    fallbackAttempts,
    executionTrace: runResult.meta?.executionTrace as TraceExecutionView | undefined,
    provider: providerUsed,
    model: modelUsed,
    runner: isCliProvider(providerUsed, cfg) ? "cli" : "embedded",
    exhausted: fallbackExhausted,
  });
  const requestShaping = {
    authMode:
      runResult.meta?.requestShaping?.authMode ??
      (cfg?.models?.providers && providerUsed in cfg.models.providers
        ? (resolveModelAuthMode(providerUsed, cfg, undefined, {
            workspaceDir: followupRun.run.workspaceDir,
          }) ?? undefined)
        : undefined),
    thinking:
      runResult.meta?.requestShaping?.thinking ??
      normalizeOptionalString(followupRun.run.thinkLevel),
    reasoning:
      runResult.meta?.requestShaping?.reasoning ??
      normalizeOptionalString(followupRun.run.reasoningLevel),
    verbose:
      runResult.meta?.requestShaping?.verbose ?? normalizeOptionalString(resolvedVerboseLevel),
    trace:
      runResult.meta?.requestShaping?.trace ??
      normalizeOptionalString(activeSessionEntry?.traceLevel),
    fallbackEligible:
      runResult.meta?.requestShaping?.fallbackEligible ??
      hasConfiguredModelFallbacks({
        cfg,
        agentId: followupRun.run.agentId,
        sessionKey: followupRun.run.sessionKey,
      }),
    blockStreaming:
      runResult.meta?.requestShaping?.blockStreaming ??
      normalizeOptionalString(resolvedBlockStreamingBreak),
  };
  const promptSegments =
    (runResult.meta?.promptSegments as TracePromptSegmentView[] | undefined) ??
    derivePromptSegments(rawUserText);
  const toolSummary = runResult.meta?.toolSummary as TraceToolSummaryView | undefined;
  const completion =
    (runResult.meta?.completion as TraceCompletionView | undefined) ??
    (runResult.meta?.stopReason
      ? {
          stopReason: runResult.meta.stopReason,
          finishReason: runResult.meta.stopReason,
          ...(runResult.meta.stopReason.toLowerCase().includes("refusal") ? { refusal: true } : {}),
        }
      : undefined);
  const contextManagement = {
    ...(typeof activeSessionEntry?.compactionCount === "number"
      ? { sessionCompactions: activeSessionEntry.compactionCount }
      : {}),
    ...(typeof runResult.meta?.contextManagement?.lastTurnCompactions === "number"
      ? { lastTurnCompactions: runResult.meta.contextManagement.lastTurnCompactions }
      : typeof runResult.meta?.agentMeta?.compactionCount === "number"
        ? { lastTurnCompactions: runResult.meta.agentMeta.compactionCount }
        : {}),
    ...(runResult.meta?.contextManagement &&
    typeof runResult.meta.contextManagement.preflightCompactionApplied === "boolean"
      ? {
          preflightCompactionApplied: runResult.meta.contextManagement.preflightCompactionApplied,
        }
      : preflightCompactionApplied
        ? { preflightCompactionApplied }
        : {}),
    ...(runResult.meta?.contextManagement &&
    typeof runResult.meta.contextManagement.postCompactionContextInjected === "boolean"
      ? {
          postCompactionContextInjected:
            runResult.meta.contextManagement.postCompactionContextInjected,
        }
      : {}),
  } satisfies TraceContextManagementView;
  const sessionUsage =
    traceAuthorized && activeSessionEntry?.traceLevel === "raw"
      ? await accumulateSessionUsageFromTranscript({
          sessionId: runResult.meta?.agentMeta?.sessionId ?? followupRun.run.sessionId,
          storePath,
          sessionFile: followupRun.run.sessionFile,
        })
      : undefined;
  const traceEnabledForSender =
    traceAuthorized &&
    (activeSessionEntry?.traceLevel === "on" || activeSessionEntry?.traceLevel === "raw");
  const shouldAppendTracePayload = verboseEnabled || traceEnabledForSender;
  let trailingPluginStatusPayload: ReplyPayload | undefined;
  if (shouldAppendTracePayload) {
    const pluginStatusPayload = buildInlinePluginStatusPayload({
      entry: activeSessionEntry,
      includeTraceLines: traceEnabledForSender,
    });
    const rawTracePayload =
      traceAuthorized && activeSessionEntry?.traceLevel === "raw"
        ? buildInlineRawTracePayload({
            entry: activeSessionEntry,
            rawUserText,
            rawAssistantText,
            sessionUsage,
            usage: runResult.meta?.agentMeta?.usage,
            lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
            provider: providerUsed,
            model: modelUsed,
            contextLimit: contextTokensUsed,
            promptTokens,
            executionTrace,
            requestShaping,
            promptSegments,
            toolSummary,
            completion,
            contextManagement,
          })
        : undefined;
    trailingPluginStatusPayload =
      pluginStatusPayload && rawTracePayload
        ? { text: `${pluginStatusPayload.text}\n\n${rawTracePayload.text}` }
        : (pluginStatusPayload ?? rawTracePayload);
  }
  if (prefixPayloads.length > 0) {
    finalPayloads = [...prefixPayloads, ...finalPayloads];
  }
  if (trailingPluginStatusPayload) {
    finalPayloads = [...finalPayloads, trailingPluginStatusPayload];
  }
  if (responseUsageLine) {
    finalPayloads = appendUsageLine(finalPayloads, responseUsageLine);
  }
  if (isHookBlockedRun) {
    finalPayloads = markBeforeAgentRunBlockedPayloads(finalPayloads);
  }

  // Capture only policy-visible final payloads in session store to support
  // durable delivery retries. Hidden reasoning, message-tool-only replies,
  // and sendPolicy-denied replies must not become heartbeat-replayable text.
  const isStrandedReplyRetryRun = followupRun.strandedReplyRetry === true;
  if (sessionKey && storePath && (finalPayloads.length > 0 || isStrandedReplyRetryRun)) {
    const sourceReplyPolicy = resolveSourceReplyPolicy({
      cfg,
      sessionCtx,
      sessionEntry: activeSessionEntry,
      sessionKey,
      runtimePolicySessionKey,
      opts,
    });
    const finalDeliveryText = buildPendingFinalDeliveryText(finalPayloads);
    // #85714: warn only for unusually substantive private final text. In
    // message_tool_only, no tool call can be intentional silence, and
    // finalDeliveryText also includes verbose/status/usage metadata.
    const assistantFinalText = normalizeAssistantFinalDeliveryText(
      typeof runResult.meta?.finalAssistantVisibleText === "string"
        ? runResult.meta.finalAssistantVisibleText
        : (rawAssistantText ?? ""),
    );
    const isRoomEvent = sessionCtx.InboundEventKind === "room_event";
    // Heartbeats already deliver fallback finals via sendDurableMessageBatch;
    // recovering here would duplicate that message.
    const isStrandedReply =
      !isHeartbeat &&
      !isRoomEvent &&
      shouldWarnAboutPrivateMessageToolFinal({
        sourceReplyDeliveryMode: sourceReplyPolicy.sourceReplyDeliveryMode,
        sendPolicyDenied: sourceReplyPolicy.sendPolicyDenied,
        successfulSourceReplyDelivery: completedSourceReplyDelivery,
        finalText: assistantFinalText,
      });
    const retryMissingSourceDelivery =
      isStrandedReplyRetryRun &&
      !isHeartbeat &&
      !isRoomEvent &&
      sourceReplyPolicy.sourceReplyDeliveryMode === "message_tool_only" &&
      !sourceReplyPolicy.sendPolicyDenied &&
      !completedSourceReplyDelivery;
    if (isStrandedReply) {
      warnPrivateMessageToolFinal({
        sessionKey,
        channel:
          sessionCtx.OriginatingChannel ??
          sessionCtx.Surface ??
          sessionCtx.Provider ??
          sessionDeliveryChannel(activeSessionEntry),
        finalTextLength: assistantFinalText.trim().length,
      });
    }
    if (isStrandedReply || retryMissingSourceDelivery) {
      if (isStrandedReplyRetryRun) {
        finalPayloads = [...finalPayloads, buildStrandedReplyDeliveryFailurePayload()];
      } else {
        const retryEnqueued = enqueueFollowupRun(
          queueKey,
          buildStrandedReplyRetryFollowupRun(followupRun, {
            finalText: assistantFinalText,
            sourceReplyDeliveryMode: sourceReplyPolicy.sourceReplyDeliveryMode,
          }),
          resolvedQueue,
          "none",
          runFollowupTurn,
          false,
          { position: "front" },
        );
        if (!retryEnqueued) {
          finalPayloads = [...finalPayloads, buildStrandedReplyDeliveryFailurePayload()];
        }
      }
    }
    const pendingText = sourceReplyPolicy.suppressDelivery ? "" : finalDeliveryText;
    const heartbeatAckMaxChars = DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
    const resolvedPendingText = isHeartbeat
      ? (() => {
          const stripped = stripHeartbeatToken(pendingText, {
            mode: "heartbeat",
            maxAckChars: heartbeatAckMaxChars,
          });
          return stripped.shouldSkip ? "" : stripped.text || pendingText;
        })()
      : pendingText;
    if (resolvedPendingText) {
      const pendingFinalDeliveryIntentId = crypto.randomUUID();
      for (const payload of finalPayloads) {
        setReplyPayloadMetadata(payload, {
          pendingFinalDeliveryIntentId,
          pendingFinalDeliveryRetryText: resolvePendingFinalDeliveryRetryText({
            isHeartbeat,
            payload,
          }),
        });
      }
      const pendingFinalDeliveryContext = resolveReplyRunDeliveryContext({
        cfg,
        sessionCtx,
        sessionEntry: activeSessionEntry,
        sessionKey,
        runtimePolicySessionKey,
        opts,
      });
      await updateSessionEntry(
        { storePath, sessionKey },
        () => ({
          pendingFinalDelivery: true,
          pendingFinalDeliveryText: resolvedPendingText,
          pendingFinalDeliveryIntentId,
          pendingFinalDeliveryContext,
          pendingFinalDeliveryCreatedAt: Date.now(),
          updatedAt: Date.now(),
        }),
        {
          skipMaintenance: true,
          takeCacheOwnership: true,
        },
      );
    }
  }
  const result = returnWithQueuedFollowupDrain(
    finalPayloads.length === 1 ? finalPayloads[0] : finalPayloads,
  );
  return result;
}
