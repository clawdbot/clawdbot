import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { replaceGenericExternalRunFailureText } from "../agents/failover/user-copy.js";
import type { HeartbeatToolResponse } from "../auto-reply/heartbeat-tool-response.js";
import { copyReplyPayloadMetadata, getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { buildRecoverablePendingFinalDeliveryText } from "../auto-reply/reply/pending-final-delivery.js";
import { isSilentReplyPayloadText } from "../auto-reply/tokens.js";
import { sendDurableMessageBatchCore } from "../channels/message/runtime.js";
import {
  loadExactSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { resolveMirroredTranscriptText } from "../config/sessions/transcript-mirror.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { formatErrorMessage } from "./errors.js";
import {
  normalizeHeartbeatReply,
  normalizeHeartbeatToolNotification,
} from "./heartbeat-delivery-normalization.js";
import { HEARTBEAT_DELIVERY_CONTEXT_KEY_PREFIX } from "./heartbeat-events-filter.js";
import { emitHeartbeatEvent, resolveIndicatorType } from "./heartbeat-events.js";
import { handleHeartbeatFailureNotice } from "./heartbeat-failure-notice.js";
import { persistHeartbeatOutcome } from "./heartbeat-outcome-store.js";
import { heartbeatLog, resolveHeartbeatChannelPlugin } from "./heartbeat-runner-config.js";
import type {
  CompletedHeartbeatAgentRun,
  HeartbeatRunOptions,
  PreparedHeartbeatRun,
  ReadyHeartbeatWake,
} from "./heartbeat-runner-execution.js";
import { truncateHeartbeatPreview } from "./heartbeat-runner-prompt.js";
import { restoreHeartbeatUpdatedAt } from "./heartbeat-runner-session.js";
import {
  HEARTBEAT_IDLE_RETRY_GRACE_MS,
  HEARTBEAT_SKIP_CHANNEL_NOT_READY,
  type HeartbeatRunResult,
} from "./heartbeat-wake.js";
import type { resolveAgentOutboundIdentity } from "./outbound/identity.js";
import {
  resolveOutboundPayloadMirrorText,
  type NormalizedOutboundPayload,
} from "./outbound/payloads.js";
import type { buildOutboundSessionContext } from "./outbound/session-context.js";
import { withSystemEventOwner } from "./system-event-ownership.js";
import { consumeSelectedSystemEventEntries, enqueueSystemEvent } from "./system-events.js";

const log = heartbeatLog;

// Recovery fields a completed heartbeat delivery must clear. Mirrors the
// canonical clearPendingFinalDeliveryAfterSuccess in dispatch-from-config.ts so
// the send-success and duplicate-skip paths drop the exact same set; leaving any
// behind keeps the session stuck on a delivery that already happened.
const CLEARED_PENDING_FINAL_DELIVERY_FIELDS = {
  pendingFinalDelivery: undefined,
} as const;

const FIRST_HEARTBEAT_ALERT_PREAMBLE =
  'First heartbeat alert: your bot runs periodic background checks and messages you only when something needs attention. Set agents.defaults.heartbeat.target: "none" to keep these internal.';
const MAX_HEARTBEAT_TARGET_AWARENESS_CHARS = 1_000;

type HeartbeatTargetProjection = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  expectedSessionId: string;
  expectedLifecycleRevision: string | undefined;
  idempotencyKey: string;
};

function resolveHeartbeatTargetProjection(params: {
  agentId: string;
  storePath: string;
  runSessionKey: string;
  targetSessionKey?: string;
  startedAt: number;
}): HeartbeatTargetProjection | undefined {
  const sessionKey = params.targetSessionKey?.trim();
  if (!sessionKey || sessionKey === params.runSessionKey) {
    return undefined;
  }
  try {
    if (resolveAgentIdFromSessionKey(sessionKey, params.agentId) !== params.agentId) {
      return undefined;
    }
    const entry = loadExactSessionEntryReadOnly({ storePath: params.storePath, sessionKey })?.entry;
    if (!entry?.sessionId) {
      return undefined;
    }
    return {
      agentId: params.agentId,
      sessionKey,
      storePath: params.storePath,
      expectedSessionId: entry.sessionId,
      expectedLifecycleRevision: entry.lifecycleRevision,
      idempotencyKey: `${HEARTBEAT_DELIVERY_CONTEXT_KEY_PREFIX}${params.startedAt}:${params.runSessionKey}`,
    };
  } catch (error) {
    log.warn("heartbeat: failed to resolve existing target session projection", {
      error: formatErrorMessage(error),
    });
    return undefined;
  }
}

function queueHeartbeatTargetAwareness(params: {
  projection: HeartbeatTargetProjection;
  payload: NormalizedOutboundPayload;
}) {
  try {
    // Recheck the exact pre-send lifecycle before publishing awareness. Resets
    // can preserve sessionId while rotating lifecycleRevision.
    const latest = loadExactSessionEntryReadOnly({
      storePath: params.projection.storePath,
      sessionKey: params.projection.sessionKey,
    })?.entry;
    if (
      latest?.sessionId !== params.projection.expectedSessionId ||
      latest.lifecycleRevision !== params.projection.expectedLifecycleRevision
    ) {
      return;
    }
    const deliveredText = resolveMirroredTranscriptText({
      text: params.payload.hookContent ?? resolveOutboundPayloadMirrorText(params.payload),
      mediaUrls: params.payload.mediaUrls,
    });
    if (!deliveredText) {
      return;
    }
    const text = truncateUtf16Safe(deliveredText, MAX_HEARTBEAT_TARGET_AWARENESS_CHARS);
    const suffix = text.length < deliveredText.length ? "\n[truncated]" : "";
    enqueueSystemEvent(
      `A heartbeat delivered this message to this channel:\n${text}${suffix}`,
      withSystemEventOwner(
        {
          sessionKey: params.projection.sessionKey,
          contextKey: params.projection.idempotencyKey,
        },
        params.projection.agentId,
      ),
    );
  } catch (error) {
    // Platform delivery already succeeded; projection remains best-effort bookkeeping.
    log.warn("heartbeat: failed to queue target session awareness", {
      error: formatErrorMessage(error),
    });
  }
}

// Clear pending-final only when this run produced it: the agent run stamps
// createdAt during the run, so createdAt >= run start means we own it. An older
// final (e.g. one a message_tool_only run never refreshed) must keep its recovery path.
function heartbeatRunOwnsPendingFinalDelivery(
  entry: SessionEntry | undefined,
  runStartedAt: number,
): boolean {
  const createdAt = entry?.pendingFinalDelivery?.createdAt;
  return typeof createdAt === "number" && createdAt >= runStartedAt;
}

export function classifyHeartbeatAgentOutcome(params: {
  agentRun: CompletedHeartbeatAgentRun;
  hasRelayableExecCompletion: boolean;
  suppressUnmarkedSourceReplies: boolean;
  responsePrefix: string | undefined;
  ackMaxChars: number;
}) {
  const { agentRunFailed, heartbeatToolResponse, heartbeatTerminalToolFailure, replyPayload } =
    params.agentRun;
  const replyMetadata = replyPayload ? getReplyPayloadMetadata(replyPayload) : undefined;
  const hasExplicitFailure = Boolean(heartbeatTerminalToolFailure || agentRunFailed);
  const shouldSuppressSourceReply =
    params.suppressUnmarkedSourceReplies &&
    !params.hasRelayableExecCompletion &&
    replyPayload &&
    replyPayload.isError !== true &&
    replyMetadata?.deliverDespiteSourceReplySuppression !== true &&
    ((!hasExplicitFailure && !heartbeatToolResponse) ||
      (agentRunFailed && !heartbeatTerminalToolFailure));
  if (heartbeatToolResponse && !heartbeatToolResponse.notify && !hasExplicitFailure) {
    return {
      kind: "ack",
      eventStatus: "ok-token",
      preview: truncateHeartbeatPreview(heartbeatToolResponse.summary),
      response: heartbeatToolResponse,
    } as const;
  }
  if (shouldSuppressSourceReply && !hasExplicitFailure) {
    // Message-tool privacy never makes an ordinary assistant final outbound;
    // marked operator notices and terminal failures keep their visible paths.
    return { kind: "ack", eventStatus: "ok-token", silent: true } as const;
  }
  if (
    !heartbeatToolResponse &&
    !hasExplicitFailure &&
    (!replyPayload || !hasOutboundReplyContent(replyPayload))
  ) {
    return { kind: "ack", eventStatus: "ok-empty" } as const;
  }
  const mode = params.hasRelayableExecCompletion ? "message" : "heartbeat";
  const normalized = shouldSuppressSourceReply
    ? {
        shouldSkip: true,
        text: "",
        hasMedia: false,
        isInternalPlaceholderOnly: false,
      }
    : hasExplicitFailure && replyPayload
      ? normalizeHeartbeatReply(replyPayload, params.responsePrefix, params.ackMaxChars, mode)
      : heartbeatToolResponse
        ? normalizeHeartbeatToolNotification(heartbeatToolResponse, params.responsePrefix)
        : replyPayload
          ? normalizeHeartbeatReply(replyPayload, params.responsePrefix, params.ackMaxChars, mode)
          : {
              shouldSkip: true,
              text: "",
              hasMedia: false,
              isInternalPlaceholderOnly: false,
            };
  if (agentRunFailed) {
    const replacement = replaceGenericExternalRunFailureText(normalized.text);
    if (replacement.replaced) {
      normalized.text = replacement.text;
      normalized.shouldSkip = false;
    }
  }
  const hasStructuredReplyContent =
    !shouldSuppressSourceReply &&
    (!heartbeatToolResponse || agentRunFailed) &&
    replyPayload !== undefined &&
    hasOutboundReplyContent({
      ...replyPayload,
      text: undefined,
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
  const shouldSkipMain =
    normalized.shouldSkip &&
    !normalized.hasMedia &&
    (!hasStructuredReplyContent || normalized.isInternalPlaceholderOnly);
  if (hasExplicitFailure) {
    return {
      kind: "failure",
      reason: heartbeatTerminalToolFailure ? "agent-tool-failure" : "agent-runner-failure",
      ...(heartbeatTerminalToolFailure
        ? {
            previewText: heartbeatToolResponse?.summary || heartbeatTerminalToolFailure.toolName,
          }
        : {}),
      replyPayload: shouldSuppressSourceReply ? undefined : replyPayload,
      normalized,
      shouldSkipMain,
    } as const;
  }
  if (shouldSkipMain) {
    // A heartbeat's canonical quiet reply still honors explicit showOk; event
    // relays and message-tool privacy retain their unconditional silence.
    const silent =
      normalized.silent && !(mode === "heartbeat" && isSilentReplyPayloadText(replyPayload?.text));
    return { kind: "ack", eventStatus: "ok-token", silent } as const;
  }
  return {
    kind: "delivery",
    response: heartbeatToolResponse,
    normalized,
    hasStructuredReplyContent,
    replyPayload: heartbeatToolResponse ? undefined : replyPayload,
    mediaUrls:
      heartbeatToolResponse || !replyPayload
        ? []
        : resolveSendableOutboundReplyParts(replyPayload).mediaUrls,
  } as const;
}

type ClassifiedHeartbeatOutcome = ReturnType<typeof classifyHeartbeatAgentOutcome>;

export async function finalizeHeartbeatOutcome(params: {
  opts: HeartbeatRunOptions;
  wake: ReadyHeartbeatWake;
  prepared: PreparedHeartbeatRun;
  outcome: ClassifiedHeartbeatOutcome;
  maybeSendHeartbeatOk: () => Promise<boolean>;
  outboundSession: ReturnType<typeof buildOutboundSessionContext>;
  outboundIdentity: ReturnType<typeof resolveAgentOutboundIdentity>;
}): Promise<HeartbeatRunResult> {
  const { cfg, agentId, scheduledTasks, startedAt, wakeSource } = params.wake;
  const { delivery, entry, previousUpdatedAt } = params.prepared;
  const { runSessionKey, sessionKey, storePath, visibility } = params.prepared;
  const outcome = params.outcome;
  const recordOutcome = (response: HeartbeatToolResponse) =>
    persistHeartbeatOutcome({
      agentId,
      sessionKey,
      storePath,
      runSessionKey,
      response,
      taskNames: scheduledTasks.map((task) => task.name),
      wakeSource,
      wakeReason: params.opts.reason,
      occurredAt: startedAt,
    });
  const recordUnconfirmedAlert = (reason: string) => {
    if (outcome.kind !== "delivery" || !outcome.response) {
      return;
    }
    const response = outcome.response;
    // This is the delivery owner's non-outcome, not a model decision to stay
    // quiet. The existing bounded context store is not an alert replay queue.
    recordOutcome({
      ...response,
      outcome: "blocked",
      notify: false,
      summary: `Alert delivery was not confirmed for this attempt.\n${response.notificationText ?? response.summary}${response.notificationText ? `\nModel summary: ${response.summary}` : ""}`,
      reason: `notify:true; delivery=${reason}; model outcome=${response.outcome}; ${response.reason ?? response.summary}`,
    });
  };
  if (outcome.kind === "failure") {
    const failureReplyPayload = outcome.replyPayload;
    const failureChannel = delivery.channel;
    const failureTarget = delivery.to;
    const heartbeatPlugin =
      failureChannel !== "none" ? resolveHeartbeatChannelPlugin(failureChannel) : undefined;
    const checkReady = heartbeatPlugin?.heartbeat?.checkReady;
    return await handleHeartbeatFailureNotice({
      reason: outcome.reason,
      ...(outcome.previewText ? { previewText: outcome.previewText } : {}),
      normalized: outcome.normalized,
      shouldSkipMain: outcome.shouldSkipMain,
      delivery,
      showAlerts: visibility.showAlerts,
      useIndicator: visibility.useIndicator,
      startedAt,
      preview: truncateHeartbeatPreview,
      restoreUpdatedAt: async () => {
        await restoreHeartbeatUpdatedAt({ storePath, sessionKey, updatedAt: previousUpdatedAt });
      },
      ...(checkReady
        ? {
            checkReady: async () =>
              await checkReady({
                cfg,
                accountId: delivery.accountId,
                deps: params.opts.deps,
              }),
          }
        : {}),
      ...(failureChannel !== "none" && failureTarget
        ? {
            deliver: async () => {
              const send = await sendDurableMessageBatchCore({
                cfg,
                channel: failureChannel,
                to: failureTarget,
                accountId: delivery.accountId,
                session: params.outboundSession,
                identity: params.outboundIdentity,
                threadId: delivery.threadId,
                payloads: [
                  copyReplyPayloadMetadata(failureReplyPayload ?? {}, {
                    ...failureReplyPayload,
                    text: outcome.normalized.text || undefined,
                  }),
                ],
                deps: params.opts.deps,
                silent: outcome.normalized.silent,
              });
              if (send.status === "failed" || send.status === "partial_failed") {
                throw send.error;
              }
              return send.status === "sent" ? "sent" : "suppressed";
            },
          }
        : {}),
      ...(failureReplyPayload
        ? {
            clearSatisfiedPendingFinalDelivery: async () => {
              const pendingFinalText = buildRecoverablePendingFinalDeliveryText([
                failureReplyPayload,
              ]);
              if (!pendingFinalText) {
                return;
              }
              await clearSatisfiedPendingFinalDelivery(
                params.wake,
                params.prepared,
                pendingFinalText,
              );
            },
          }
        : {}),
      onChannelNotReady: (reason) => {
        log.info("heartbeat: channel not ready for failure notice", {
          channel: failureChannel,
          reason,
        });
      },
      onDeliveryError: (error) => {
        log.warn("heartbeat: failure notice delivery failed", {
          channel: failureChannel,
          error: formatErrorMessage(error),
        });
      },
    });
  }
  if (outcome.kind === "ack") {
    if ("response" in outcome && outcome.response) {
      recordOutcome(outcome.response);
    }
    await restoreHeartbeatUpdatedAt({ storePath, sessionKey, updatedAt: previousUpdatedAt });
    const okSent =
      "silent" in outcome && outcome.silent ? false : await params.maybeSendHeartbeatOk();
    emitHeartbeatEvent({
      status: outcome.eventStatus,
      reason: params.opts.reason,
      ...("preview" in outcome ? { preview: outcome.preview } : {}),
      durationMs: Date.now() - startedAt,
      channel: delivery.channel !== "none" ? delivery.channel : undefined,
      accountId: delivery.accountId,
      silent: !okSent,
      indicatorType: visibility.useIndicator
        ? resolveIndicatorType(outcome.eventStatus)
        : undefined,
    });
    consumeInspectedSystemEvents(params.wake, params.prepared);
    return { status: "ran", durationMs: Date.now() - startedAt };
  }
  const { hasStructuredReplyContent, mediaUrls, normalized, replyPayload } = outcome;
  // Suppress duplicate heartbeats (same payload) within a short window.
  // This prevents "nagging" when nothing changed but the model repeats the same items.
  const prevHeartbeatText =
    typeof entry?.lastHeartbeatText === "string" ? entry.lastHeartbeatText : "";
  const prevHeartbeatAt =
    typeof entry?.lastHeartbeatSentAt === "number" ? entry.lastHeartbeatSentAt : undefined;
  const isDuplicateMain =
    !mediaUrls.length &&
    !hasStructuredReplyContent &&
    Boolean(prevHeartbeatText.trim()) &&
    normalized.text.trim() === prevHeartbeatText.trim() &&
    typeof prevHeartbeatAt === "number" &&
    // A future timestamp after clock rollback cannot prove a recent prior send.
    prevHeartbeatAt <= startedAt &&
    startedAt - prevHeartbeatAt < 24 * 60 * 60 * 1000;

  if (isDuplicateMain) {
    await restoreHeartbeatUpdatedAt({ storePath, sessionKey, updatedAt: previousUpdatedAt });
    await clearSatisfiedPendingFinalDelivery(params.wake, params.prepared);
    emitHeartbeatEvent({
      status: "skipped",
      reason: "duplicate",
      preview: truncateHeartbeatPreview(normalized.text),
      durationMs: Date.now() - startedAt,
      hasMedia: false,
      channel: delivery.channel !== "none" ? delivery.channel : undefined,
      accountId: delivery.accountId,
    });
    consumeInspectedSystemEvents(params.wake, params.prepared);
    return { status: "ran", durationMs: Date.now() - startedAt };
  }

  const deliveryText =
    delivery.implicitDefaultRoute && prevHeartbeatAt === undefined
      ? `${FIRST_HEARTBEAT_ALERT_PREAMBLE}\n${normalized.text}`
      : normalized.text;
  const previewText = deliveryText;
  if (delivery.channel === "none" || !delivery.to) {
    recordUnconfirmedAlert(delivery.reason ?? "no-target");
    emitHeartbeatEvent({
      status: "skipped",
      reason: delivery.reason ?? "no-target",
      preview: truncateHeartbeatPreview(previewText),
      durationMs: Date.now() - startedAt,
      hasMedia: mediaUrls.length > 0,
      accountId: delivery.accountId,
    });
    consumeInspectedSystemEvents(params.wake, params.prepared);
    return { status: "ran", durationMs: Date.now() - startedAt };
  }
  if (!visibility.showAlerts) {
    recordUnconfirmedAlert("alerts-disabled");
    await restoreHeartbeatUpdatedAt({ storePath, sessionKey, updatedAt: previousUpdatedAt });
    emitHeartbeatEvent({
      status: "skipped",
      reason: "alerts-disabled",
      preview: truncateHeartbeatPreview(previewText),
      durationMs: Date.now() - startedAt,
      channel: delivery.channel,
      hasMedia: mediaUrls.length > 0,
      accountId: delivery.accountId,
      indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : undefined,
    });
    consumeInspectedSystemEvents(params.wake, params.prepared);
    return { status: "ran", durationMs: Date.now() - startedAt };
  }

  const deliveryAccountId = delivery.accountId;
  const heartbeatPlugin = resolveHeartbeatChannelPlugin(delivery.channel);
  if (heartbeatPlugin?.heartbeat?.checkReady) {
    const readiness = await heartbeatPlugin.heartbeat
      .checkReady({ cfg, accountId: deliveryAccountId, deps: params.opts.deps })
      .catch((error: unknown) => ({ ok: false, reason: formatErrorMessage(error) }));
    if (!readiness.ok) {
      recordUnconfirmedAlert(readiness.reason);
      await restoreHeartbeatUpdatedAt({ storePath, sessionKey, updatedAt: previousUpdatedAt });
      emitHeartbeatEvent({
        status: "skipped",
        reason: readiness.reason,
        preview: truncateHeartbeatPreview(previewText),
        durationMs: Date.now() - startedAt,
        hasMedia: mediaUrls.length > 0,
        channel: delivery.channel,
        accountId: delivery.accountId,
      });
      log.info("heartbeat: channel not ready", {
        channel: delivery.channel,
        reason: readiness.reason,
      });
      return {
        status: "skipped",
        reason: HEARTBEAT_SKIP_CHANNEL_NOT_READY,
        retryAtMs: Date.now() + HEARTBEAT_IDLE_RETRY_GRACE_MS,
      };
    }
  }

  const targetProjection = resolveHeartbeatTargetProjection({
    agentId,
    storePath,
    runSessionKey,
    targetSessionKey: delivery.targetSessionKey,
    startedAt,
  });
  const send = await sendDurableMessageBatchCore({
    cfg,
    channel: delivery.channel,
    to: delivery.to,
    accountId: deliveryAccountId,
    session: params.outboundSession,
    identity: params.outboundIdentity,
    threadId: delivery.threadId,
    payloads: [
      copyReplyPayloadMetadata(replyPayload ?? {}, {
        ...replyPayload,
        text: deliveryText,
        mediaUrls,
      }),
    ],
    deps: params.opts.deps,
    silent: normalized.silent,
    onDeliveredPayload: targetProjection
      ? (payload) => queueHeartbeatTargetAwareness({ projection: targetProjection, payload })
      : undefined,
  }).catch((error: unknown) => {
    recordUnconfirmedAlert(formatErrorMessage(error));
    throw error;
  });
  if (send.status !== "sent") {
    recordUnconfirmedAlert("reason" in send ? send.reason : formatErrorMessage(send.error));
  }
  if (send.status === "failed" || send.status === "partial_failed") {
    throw send.error;
  }
  const visibleSendSucceeded = send.status === "sent";
  if (visibleSendSucceeded) {
    const hasHeartbeatText = Boolean(deliveryText.trim());
    await patchSessionEntryCore(
      { storePath, sessionKey },
      (current, context) => {
        if (!context.existingEntry) {
          return null;
        }
        // Visible structured-only sends satisfy their own pending final too;
        // preserve old text dedupe markers and another run's recovery state.
        const ownsPendingFinalDelivery = heartbeatRunOwnsPendingFinalDelivery(current, startedAt);
        if (!hasHeartbeatText && !ownsPendingFinalDelivery) {
          return null;
        }
        return {
          ...(hasHeartbeatText
            ? { lastHeartbeatText: normalized.text, lastHeartbeatSentAt: startedAt }
            : {}),
          ...(ownsPendingFinalDelivery ? CLEARED_PENDING_FINAL_DELIVERY_FIELDS : {}),
        };
      },
      { preserveActivity: true },
    );
  }

  const eventStatus = visibleSendSucceeded ? "sent" : "skipped";
  emitHeartbeatEvent({
    status: eventStatus,
    to: delivery.to,
    ...(!visibleSendSucceeded ? { reason: send.reason } : {}),
    preview: truncateHeartbeatPreview(previewText),
    durationMs: Date.now() - startedAt,
    hasMedia: mediaUrls.length > 0,
    channel: delivery.channel,
    accountId: delivery.accountId,
    ...(normalized.silent === true ? { silent: true } : {}),
    indicatorType: visibility.useIndicator ? resolveIndicatorType(eventStatus) : undefined,
  });
  // Intentional internal-only/no-target runs consume above. Once this branch
  // expects visible delivery, suppressed sends must retain the original event.
  if (visibleSendSucceeded) {
    consumeInspectedSystemEvents(params.wake, params.prepared);
  }
  return { status: "ran", durationMs: Date.now() - startedAt };
}

// The duplicate-suppression branch returns before any send, so it never hits
// the send-success clear. A duplicate means this run's own output was already
// delivered within the dedupe window, so this run's pending-final is satisfied
// and gets cleared the same way the send-success path does. We must not
// text-match the pending against the delivered text: agent-runner stores it
// pre-normalization (no responsePrefix), so a byte compare would leave
// prefixed agents permanently stuck. Ownership is gated on createdAt instead,
// so an older final this run did not produce is preserved, not erased.
async function clearSatisfiedPendingFinalDelivery(
  wake: ReadyHeartbeatWake,
  prepared: PreparedHeartbeatRun,
  expectedText?: string,
) {
  await patchSessionEntryCore(
    { storePath: prepared.storePath, sessionKey: prepared.sessionKey },
    (current, context) => {
      if (!context.existingEntry) {
        return null;
      }
      if (!current?.pendingFinalDelivery) {
        return null;
      }
      if (!heartbeatRunOwnsPendingFinalDelivery(current, wake.startedAt)) {
        return null;
      }
      // A terminal failure can send only the last payload while recovery owns
      // several. Clear only when the delivered payload represents the whole final.
      if (
        expectedText !== undefined &&
        (current.pendingFinalDelivery.kind !== "replayable" ||
          current.pendingFinalDelivery.text !== expectedText)
      ) {
        return null;
      }
      return CLEARED_PENDING_FINAL_DELIVERY_FIELDS;
    },
    { preserveActivity: true },
  );
}

function consumeInspectedSystemEvents(wake: ReadyHeartbeatWake, prepared: PreparedHeartbeatRun) {
  if (wake.preflight.shouldInspectPendingEvents && prepared.inspectedSystemEventsToConsume.length) {
    consumeSelectedSystemEventEntries(prepared.sessionKey, prepared.inspectedSystemEventsToConsume);
  }
}
