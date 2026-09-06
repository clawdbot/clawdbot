import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { replaceGenericExternalRunFailureText } from "../agents/failover/user-copy.js";
import type { HeartbeatToolResponse } from "../auto-reply/heartbeat-tool-response.js";
import { copyReplyPayloadMetadata, getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import {
  clearPendingFinalDeliveryAfterSuccess,
  suppressPendingFinalDelivery,
} from "../auto-reply/reply/dispatch-from-config.pending-final.js";
import { isSilentReplyPayloadText } from "../auto-reply/tokens.js";
import { sendDurableMessageBatchCore } from "../channels/message/runtime.js";
import {
  loadExactSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { resolveMirroredTranscriptText } from "../config/sessions/transcript-mirror.js";
import { mergeSessionEntry } from "../config/sessions/types.js";
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
  replyPayloadSource: CompletedHeartbeatAgentRun["replyPayload"];
  maybeSendHeartbeatOk: () => Promise<boolean>;
  outboundSession: ReturnType<typeof buildOutboundSessionContext>;
  outboundIdentity: ReturnType<typeof resolveAgentOutboundIdentity>;
}): Promise<HeartbeatRunResult> {
  const { cfg, agentId, scheduledTasks, startedAt, wakeSource } = params.wake;
  const { delivery, previousUpdatedAt } = params.prepared;
  const { runSessionKey, sessionKey, storePath, visibility } = params.prepared;
  // Delivery markers belong to the policy session, not a rotating isolated run or recipient.
  const stateKey = params.prepared.outboundPolicySessionKey ?? sessionKey;
  const stateEntry = loadExactSessionEntryReadOnly({ storePath, sessionKey: stateKey })?.entry;
  const outcome = params.outcome;
  const replyPayloadSource = params.replyPayloadSource;
  const pendingFinalIdentity = replyPayloadSource
    ? getReplyPayloadMetadata(replyPayloadSource)?.pendingFinalDeliveryCompletion
    : undefined;
  const finish = (event: Parameters<typeof emitHeartbeatEvent>[0], consumeEvents = true) => {
    emitHeartbeatEvent({
      ...event,
      durationMs: Date.now() - startedAt,
      accountId: delivery.accountId,
    });
    if (
      consumeEvents &&
      params.wake.preflight.shouldInspectPendingEvents &&
      params.prepared.inspectedSystemEventsToConsume.length
    ) {
      consumeSelectedSystemEventEntries(sessionKey, params.prepared.inspectedSystemEventsToConsume);
    }
    return { status: "ran", durationMs: Date.now() - startedAt } as const;
  };
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
      checkReady: checkReady
        ? async () =>
            await checkReady({ cfg, accountId: delivery.accountId, deps: params.opts.deps })
        : undefined,
      deliver:
        failureChannel !== "none" && failureTarget
          ? async () => {
              const send = await sendDurableMessageBatchCore({
                cfg,
                channel: failureChannel,
                to: failureTarget,
                accountId: delivery.accountId,
                session: params.outboundSession,
                identity: params.outboundIdentity,
                threadId: delivery.threadId,
                payloads: [
                  copyReplyPayloadMetadata(replyPayloadSource ?? {}, {
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
            }
          : undefined,
      clearSatisfiedPendingFinalDelivery: () =>
        clearPendingFinalDeliveryAfterSuccess(pendingFinalIdentity, { preserveActivity: true }),
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
    await suppressPendingFinalDelivery(replyPayloadSource, { preserveActivity: true });
    const okSent =
      "silent" in outcome && outcome.silent ? false : await params.maybeSendHeartbeatOk();
    return finish({
      status: outcome.eventStatus,
      reason: params.opts.reason,
      ...("preview" in outcome ? { preview: outcome.preview } : {}),
      channel: delivery.channel !== "none" ? delivery.channel : undefined,
      silent: !okSent,
      indicatorType: visibility.useIndicator
        ? resolveIndicatorType(outcome.eventStatus)
        : undefined,
    });
  }
  const { hasStructuredReplyContent, mediaUrls, normalized, replyPayload } = outcome;
  // Suppress duplicate heartbeats (same payload) within a short window.
  // This prevents "nagging" when nothing changed but the model repeats the same items.
  const prevHeartbeatText = stateEntry?.lastHeartbeatText ?? "";
  const prevHeartbeatAt = stateEntry?.lastHeartbeatSentAt;
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
    await suppressPendingFinalDelivery(replyPayloadSource, { preserveActivity: true });
    return finish({
      status: "skipped",
      reason: "duplicate",
      preview: truncateHeartbeatPreview(normalized.text),
      hasMedia: false,
      channel: delivery.channel !== "none" ? delivery.channel : undefined,
    });
  }

  const deliveryText =
    delivery.implicitDefaultRoute && prevHeartbeatAt === undefined
      ? `${FIRST_HEARTBEAT_ALERT_PREAMBLE}\n${normalized.text}`
      : normalized.text;
  if (delivery.channel === "none" || !delivery.to) {
    recordUnconfirmedAlert(delivery.reason ?? "no-target");
    await suppressPendingFinalDelivery(replyPayloadSource, { preserveActivity: true });
    return finish({
      status: "skipped",
      reason: delivery.reason ?? "no-target",
      preview: truncateHeartbeatPreview(deliveryText),
      hasMedia: mediaUrls.length > 0,
    });
  }
  if (!visibility.showAlerts) {
    recordUnconfirmedAlert("alerts-disabled");
    await suppressPendingFinalDelivery(replyPayloadSource, { preserveActivity: true });
    await restoreHeartbeatUpdatedAt({ storePath, sessionKey, updatedAt: previousUpdatedAt });
    return finish({
      status: "skipped",
      reason: "alerts-disabled",
      preview: truncateHeartbeatPreview(deliveryText),
      channel: delivery.channel,
      hasMedia: mediaUrls.length > 0,
      indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : undefined,
    });
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
        preview: truncateHeartbeatPreview(deliveryText),
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
      // Tool notifications replace content but retain the exact producer-owned delivery intent.
      copyReplyPayloadMetadata(replyPayloadSource ?? {}, {
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
  await clearPendingFinalDeliveryAfterSuccess(pendingFinalIdentity, { preserveActivity: true });
  if (visibleSendSucceeded && deliveryText.trim()) {
    // Delivery policy owns dedupe; the exact payload intent owns recovery cleanup above.
    await patchSessionEntryCore(
      { storePath, sessionKey: stateKey },
      () => ({ lastHeartbeatText: normalized.text, lastHeartbeatSentAt: startedAt }),
      {
        fallbackEntry: mergeSessionEntry(undefined, { updatedAt: startedAt }),
        preserveActivity: true,
      },
    );
  }

  const eventStatus = visibleSendSucceeded ? "sent" : "skipped";
  // Intentional internal-only/no-target runs consume above. Once this branch
  // expects visible delivery, suppressed sends must retain the original event.
  return finish(
    {
      status: eventStatus,
      to: delivery.to,
      ...(!visibleSendSucceeded ? { reason: send.reason } : {}),
      preview: truncateHeartbeatPreview(deliveryText),
      hasMedia: mediaUrls.length > 0,
      channel: delivery.channel,
      ...(normalized.silent === true ? { silent: true } : {}),
      indicatorType: visibility.useIndicator ? resolveIndicatorType(eventStatus) : undefined,
    },
    visibleSendSucceeded,
  );
}
