import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { replaceGenericExternalRunFailureText } from "../agents/failover/user-copy.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  type ReplyPayload,
} from "../auto-reply/reply-payload.js";
import { buildRecoverablePendingFinalDeliveryText } from "../auto-reply/reply/pending-final-delivery.js";
import { isSilentReplyPayloadText } from "../auto-reply/tokens.js";
import {
  durableMessageBatchMayHaveReachedRecipient,
  sendDurableMessageBatchCore,
} from "../channels/message/runtime.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { resolveMirroredTranscriptText } from "../config/sessions/transcript-mirror.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { formatErrorMessage } from "./errors.js";
import {
  normalizeHeartbeatReply,
  normalizeHeartbeatToolNotification,
} from "./heartbeat-delivery-normalization.js";
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
import type { HeartbeatRunResult } from "./heartbeat-wake.js";
import { isOutboundDeliveryError } from "./outbound/deliver-types.js";
import type { resolveAgentOutboundIdentity } from "./outbound/identity.js";
import {
  projectDeliveredOutboundPayloadsForMirror,
  type NormalizedOutboundPayload,
} from "./outbound/payloads.js";
import type { buildOutboundSessionContext } from "./outbound/session-context.js";
import {
  commitTargetSessionProjection,
  formatHeartbeatTargetSessionAwareness,
  refreshTargetSessionProjection,
  type PreparedTargetSessionProjection,
  type TargetSessionProjectionCoordinator,
} from "./outbound/target-session-projection.js";
import { consumeSelectedSystemEventEntries } from "./system-events.js";

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

function buildHeartbeatDeliveryIdempotencyKey(agentId: string, startedAt: number): string {
  return `heartbeat-delivery:v1:${encodeURIComponent(agentId.trim().toLowerCase())}:${startedAt}`;
}

type HeartbeatDeliverySendResult = Awaited<ReturnType<typeof sendDurableMessageBatchCore>>;
type HeartbeatDeliveryAttempt = {
  send: HeartbeatDeliverySendResult;
  projection: Promise<void>;
};

async function projectHeartbeatDeliveryOutcome(params: {
  wake: ReadyHeartbeatWake;
  prepared: PreparedHeartbeatRun;
  channel: ChannelId;
  target: PreparedTargetSessionProjection | undefined;
  send: HeartbeatDeliverySendResult;
  attemptedPayloads: NormalizedOutboundPayload[];
  deliveredPayloads: NormalizedOutboundPayload[];
  targetProjectionCoordinator?: TargetSessionProjectionCoordinator;
}): Promise<void> {
  const target = params.target;
  if (!target) {
    return;
  }
  const { cfg, agentId, startedAt } = params.wake;
  const { delivery, runSessionKey } = params.prepared;
  const mayHaveReachedRecipient = durableMessageBatchMayHaveReachedRecipient(params.send);
  const recoveryOwnsRetry =
    params.send.status === "failed" &&
    isOutboundDeliveryError(params.send.error) &&
    params.send.error.recoveryOwnedRetry === true;
  const targetsDifferent =
    target.agentId !== agentId || target.route.sessionKey.trim() !== runSessionKey.trim();
  const routeBinding =
    mayHaveReachedRecipient && targetsDifferent
      ? {
          channel: params.channel,
          ...(delivery.accountId ? { accountId: delivery.accountId } : {}),
        }
      : undefined;
  const deliveredMirror =
    params.send.status === "sent" || params.send.status === "partial_failed"
      ? projectDeliveredOutboundPayloadsForMirror(params.deliveredPayloads)
      : undefined;
  const attemptedMirror = projectDeliveredOutboundPayloadsForMirror(params.attemptedPayloads);
  const mirror =
    deliveredMirror &&
    targetsDifferent &&
    (deliveredMirror.text || deliveredMirror.mediaUrls.length > 0)
      ? deliveredMirror
      : undefined;
  const awarenessText = recoveryOwnsRetry
    ? undefined
    : params.send.status === "failed" || params.send.status === "partial_failed"
      ? formatHeartbeatTargetSessionAwareness({
          status: "failed",
          mayHaveReachedRecipient,
        })
      : params.send.status === "suppressed" && params.send.reason === "adapter_returned_no_identity"
        ? formatHeartbeatTargetSessionAwareness({
            status: "uncertain",
            text: resolveMirroredTranscriptText(attemptedMirror) ?? undefined,
          })
        : params.send.status === "sent" && targetsDifferent
          ? formatHeartbeatTargetSessionAwareness({
              status: "delivered",
              text: resolveMirroredTranscriptText(deliveredMirror ?? {}) ?? undefined,
            })
          : undefined;
  if (!routeBinding && !mirror && !awarenessText) {
    return;
  }
  const projection = await commitTargetSessionProjection({
    cfg,
    prepared: target,
    idempotencyKey: buildHeartbeatDeliveryIdempotencyKey(agentId, startedAt),
    ...(routeBinding ? { routeBinding } : {}),
    ...(mirror ? { mirror } : {}),
    ...(awarenessText ? { awarenessText } : {}),
    ...(params.targetProjectionCoordinator
      ? { coordinator: params.targetProjectionCoordinator }
      : {}),
  });
  if (projection.status === "skipped") {
    log.warn("heartbeat: skipped target session projection", {
      reason: projection.reason,
      sessionKey: target.route.sessionKey,
      deliveryStatus: params.send.status,
    });
  } else if (projection.warnings.length > 0) {
    log.warn("heartbeat: target session projection completed with warnings", {
      warnings: projection.warnings,
      sessionKey: target.route.sessionKey,
      deliveryStatus: params.send.status,
    });
  }
}

async function sendHeartbeatPayloads(params: {
  wake: ReadyHeartbeatWake;
  prepared: PreparedHeartbeatRun;
  outboundSession: ReturnType<typeof buildOutboundSessionContext>;
  outboundIdentity: ReturnType<typeof resolveAgentOutboundIdentity>;
  payloads: ReplyPayload[];
  deps: HeartbeatRunOptions["deps"];
  silent?: boolean;
  targetProjectionCoordinator?: TargetSessionProjectionCoordinator;
}): Promise<HeartbeatDeliveryAttempt> {
  const { cfg } = params.wake;
  const { delivery } = params.prepared;
  if (delivery.channel === "none" || !delivery.to) {
    throw new Error("Heartbeat delivery target is unavailable.");
  }
  const attemptedPayloads: NormalizedOutboundPayload[] = [];
  const deliveredPayloads: NormalizedOutboundPayload[] = [];
  // The model run and its message tools may legitimately create or reset the
  // target session. Freeze the generation immediately before platform I/O so
  // only resets in the send/commit window invalidate this direct delivery.
  const target = params.prepared.targetSessionProjection
    ? refreshTargetSessionProjection(params.prepared.targetSessionProjection)
    : undefined;
  const deliveryIdempotencyKey = buildHeartbeatDeliveryIdempotencyKey(
    params.wake.agentId,
    params.wake.startedAt,
  );
  const durableTargetMirror =
    target?.observedSession &&
    (target.agentId !== params.wake.agentId ||
      target.route.sessionKey.trim() !== params.prepared.runSessionKey.trim())
      ? {
          sessionKey: target.route.sessionKey,
          agentId: target.agentId,
          expectedSessionId: target.observedSession.sessionId,
          ...(target.observedSession.lifecycleRevision
            ? { expectedLifecycleRevision: target.observedSession.lifecycleRevision }
            : {}),
          idempotencyKey: deliveryIdempotencyKey,
        }
      : undefined;
  const send = await sendDurableMessageBatchCore({
    cfg,
    channel: delivery.channel,
    to: delivery.to,
    accountId: delivery.accountId,
    session: params.outboundSession,
    identity: params.outboundIdentity,
    threadId: delivery.threadId,
    payloads: params.payloads,
    mirror: durableTargetMirror,
    deferLiveTranscriptMirror: Boolean(durableTargetMirror),
    onPayload: (payload) => {
      attemptedPayloads.push(payload);
    },
    onDeliveredPayload: (payload) => {
      deliveredPayloads.push(payload);
    },
    deps: params.deps,
    silent: params.silent,
  });
  // The irreversible send settles before target-session bookkeeping. Returning
  // that fact first lets the heartbeat owner record dedupe state even when the
  // target is busy and the projection must wait between its turns.
  const projection = projectHeartbeatDeliveryOutcome({
    wake: params.wake,
    prepared: params.prepared,
    channel: delivery.channel,
    target,
    send,
    attemptedPayloads,
    deliveredPayloads,
    ...(params.targetProjectionCoordinator
      ? { targetProjectionCoordinator: params.targetProjectionCoordinator }
      : {}),
  }).catch((error: unknown) => {
    log.warn("heartbeat: target session projection failed", {
      error: formatErrorMessage(error),
      sessionKey: target?.route.sessionKey,
      deliveryStatus: send.status,
    });
  });
  return { send, projection };
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
  targetProjectionCoordinator?: TargetSessionProjectionCoordinator;
}): Promise<HeartbeatRunResult> {
  const { cfg, agentId, scheduledTasks, startedAt, wakeSource } = params.wake;
  const { delivery, entry, previousUpdatedAt } = params.prepared;
  const { runSessionKey, sessionKey, storePath, visibility } = params.prepared;
  const outcome = params.outcome;
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
              const deliveryAttempt = await sendHeartbeatPayloads({
                wake: params.wake,
                prepared: params.prepared,
                outboundSession: params.outboundSession,
                outboundIdentity: params.outboundIdentity,
                payloads: [
                  copyReplyPayloadMetadata(failureReplyPayload ?? {}, {
                    ...failureReplyPayload,
                    text: outcome.normalized.text || undefined,
                  }),
                ],
                deps: params.opts.deps,
                silent: outcome.normalized.silent,
                ...(params.targetProjectionCoordinator
                  ? { targetProjectionCoordinator: params.targetProjectionCoordinator }
                  : {}),
              });
              const { send } = deliveryAttempt;
              if (send.status === "failed" || send.status === "partial_failed") {
                await deliveryAttempt.projection;
                throw send.error;
              }
              await deliveryAttempt.projection;
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
      persistHeartbeatOutcome({
        agentId,
        sessionKey,
        storePath,
        runSessionKey,
        response: outcome.response,
        taskNames: scheduledTasks.map((task) => task.name),
        wakeSource,
        wakeReason: params.opts.reason,
        occurredAt: startedAt,
      });
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
    const readiness = await heartbeatPlugin.heartbeat.checkReady({
      cfg,
      accountId: deliveryAccountId,
      deps: params.opts.deps,
    });
    if (!readiness.ok) {
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
      return { status: "skipped", reason: readiness.reason };
    }
  }

  const deliveryPayload = copyReplyPayloadMetadata(replyPayload ?? {}, {
    ...replyPayload,
    text: deliveryText,
    mediaUrls,
  });
  const deliveryAttempt = await sendHeartbeatPayloads({
    wake: params.wake,
    prepared: params.prepared,
    outboundSession: params.outboundSession,
    outboundIdentity: params.outboundIdentity,
    payloads: [deliveryPayload],
    deps: params.opts.deps,
    silent: normalized.silent,
    ...(params.targetProjectionCoordinator
      ? { targetProjectionCoordinator: params.targetProjectionCoordinator }
      : {}),
  });
  const { send } = deliveryAttempt;
  if (send.status === "failed" || send.status === "partial_failed") {
    await deliveryAttempt.projection;
    throw send.error;
  }
  const visibleSendSucceeded = send.status === "sent";
  try {
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
  } finally {
    // The platform send is irreversible. Preserve its target-session fact even
    // when source-session accounting fails after the send has settled.
    await deliveryAttempt.projection;
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
