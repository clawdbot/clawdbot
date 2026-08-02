import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { copyReplyPayloadMetadata, getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { replaceGenericExternalRunFailureText } from "../auto-reply/reply/agent-runner-failure-copy.js";
import { buildRecoverablePendingFinalDeliveryText } from "../auto-reply/reply/pending-final-delivery.js";
import { sendDurableMessageBatch } from "../channels/message/runtime.js";
import { markCommitmentsStatus } from "../commitments/store.js";
import { patchSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { formatErrorMessage } from "./errors.js";
import {
  normalizeHeartbeatReply,
  normalizeHeartbeatToolNotification,
  stripTrailingHeartbeatNotifyFalse,
} from "./heartbeat-delivery-normalization.js";
import { emitHeartbeatEvent, resolveIndicatorType } from "./heartbeat-events.js";
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
import { handleHeartbeatTerminalToolFailure } from "./heartbeat-terminal-tool-failure.js";
import type { HeartbeatRunResult } from "./heartbeat-wake.js";
import type { resolveAgentOutboundIdentity } from "./outbound/identity.js";
import type { buildOutboundSessionContext } from "./outbound/session-context.js";
import { consumeSelectedSystemEventEntries } from "./system-events.js";

const log = heartbeatLog;

// Recovery fields a completed heartbeat delivery must clear. Mirrors the
// canonical clearPendingFinalDeliveryAfterSuccess in dispatch-from-config.ts so
// the send-success and duplicate-skip paths drop the exact same set; leaving any
// behind keeps the session stuck on a delivery that already happened.
const CLEARED_PENDING_FINAL_DELIVERY_FIELDS = {
  pendingFinalDelivery: undefined,
} as const;

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
  const { heartbeatToolResponse, heartbeatTerminalToolFailure, replyPayload } = params.agentRun;
  if (heartbeatToolResponse && !heartbeatToolResponse.notify && !heartbeatTerminalToolFailure) {
    return {
      kind: "ack",
      eventStatus: "ok-token",
      preview: truncateHeartbeatPreview(heartbeatToolResponse.summary),
      response: heartbeatToolResponse,
    } as const;
  }
  if (
    params.suppressUnmarkedSourceReplies &&
    !params.hasRelayableExecCompletion &&
    !heartbeatToolResponse &&
    !heartbeatTerminalToolFailure &&
    replyPayload &&
    replyPayload.isError !== true &&
    getReplyPayloadMetadata(replyPayload)?.deliverDespiteSourceReplySuppression !== true
  ) {
    // Message-tool privacy never makes an ordinary assistant final outbound;
    // marked operator notices and terminal failures keep their visible paths.
    return { kind: "ack", eventStatus: "ok-token", silent: true } as const;
  }
  if (!heartbeatToolResponse && (!replyPayload || !hasOutboundReplyContent(replyPayload))) {
    return { kind: "ack", eventStatus: "ok-empty" } as const;
  }
  const normalized =
    heartbeatTerminalToolFailure && replyPayload
      ? normalizeHeartbeatReply(replyPayload, params.responsePrefix, params.ackMaxChars)
      : heartbeatToolResponse
        ? normalizeHeartbeatToolNotification(heartbeatToolResponse, params.responsePrefix)
        : replyPayload
          ? normalizeHeartbeatReply(replyPayload, params.responsePrefix, params.ackMaxChars)
          : {
              shouldSkip: true,
              text: "",
              hasMedia: false,
              isInternalPlaceholderOnly: false,
            };
  // For exec completion events, don't skip even if the response looks like HEARTBEAT_OK.
  // The model should be responding with exec results, not ack tokens.
  // Also, if normalized.text is empty due to token stripping but we have exec completion,
  // fall back to the original reply text.
  const execFallbackText =
    !heartbeatToolResponse &&
    params.hasRelayableExecCompletion &&
    !normalized.text.trim() &&
    !normalized.isInternalPlaceholderOnly &&
    replyPayload?.text?.trim()
      ? replyPayload.text.trim()
      : null;
  if (execFallbackText) {
    const execNotifyFalse = stripTrailingHeartbeatNotifyFalse(execFallbackText);
    normalized.text = execNotifyFalse.text;
    normalized.shouldSkip = !normalized.hasMedia && !normalized.text.trim();
    if (execNotifyFalse.silent) {
      normalized.silent = true;
    }
  }
  const replacement = !heartbeatToolResponse
    ? replaceGenericExternalRunFailureText(normalized.text)
    : { text: normalized.text, replaced: false };
  const deliveredAgentRunFailure = replacement.replaced;
  if (deliveredAgentRunFailure) {
    normalized.text = replacement.text;
    normalized.shouldSkip = false;
  }
  const shouldSkipMain =
    normalized.shouldSkip &&
    !normalized.hasMedia &&
    (!params.hasRelayableExecCompletion || normalized.isInternalPlaceholderOnly);
  if (heartbeatTerminalToolFailure) {
    return {
      kind: "terminal-failure",
      failure: heartbeatTerminalToolFailure,
      heartbeatToolResponse,
      replyPayload,
      normalized,
      shouldSkipMain,
    } as const;
  }
  if (shouldSkipMain) {
    return { kind: "ack", eventStatus: "ok-token", silent: normalized.silent } as const;
  }
  return {
    kind: "delivery",
    normalized,
    deliveredAgentRunFailure,
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
  const { delivery, dueCommitmentIds, entry, previousUpdatedAt } = params.prepared;
  const { runSessionKey, sessionKey, storePath, visibility } = params.prepared;
  const markDueCommitments = (status: "dismissed" | "sent") =>
    markCommitmentsStatus({ ids: dueCommitmentIds, status, nowMs: startedAt });
  const outcome = params.outcome;
  if (outcome.kind === "terminal-failure") {
    const failureChannel = delivery.channel;
    const failureTarget = delivery.to;
    const terminalPendingFinalText = outcome.replyPayload
      ? buildRecoverablePendingFinalDeliveryText([outcome.replyPayload])
      : undefined;
    const heartbeatPlugin =
      failureChannel !== "none" ? resolveHeartbeatChannelPlugin(failureChannel) : undefined;
    const checkReady = heartbeatPlugin?.heartbeat?.checkReady;
    return await handleHeartbeatTerminalToolFailure({
      failure: outcome.failure,
      ...(outcome.heartbeatToolResponse ? { response: outcome.heartbeatToolResponse } : {}),
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
              const send = await sendDurableMessageBatch({
                cfg,
                channel: failureChannel,
                to: failureTarget,
                accountId: delivery.accountId,
                session: params.outboundSession,
                identity: params.outboundIdentity,
                threadId: delivery.threadId,
                payloads: [
                  copyReplyPayloadMetadata(outcome.replyPayload ?? {}, {
                    ...outcome.replyPayload,
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
      ...(terminalPendingFinalText
        ? {
            clearSatisfiedPendingFinalDelivery: async () => {
              await clearSatisfiedPendingFinalDelivery(
                params.wake,
                params.prepared,
                terminalPendingFinalText,
              );
            },
          }
        : {}),
      onChannelNotReady: (reason) => {
        log.info("heartbeat: channel not ready for terminal tool failure", {
          channel: failureChannel,
          reason,
        });
      },
      onDeliveryError: (error) => {
        log.warn("heartbeat: terminal tool failure alert delivery failed", {
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
    await markDueCommitments("dismissed");
    consumeInspectedSystemEvents(params.wake, params.prepared);
    return { status: "ran", durationMs: Date.now() - startedAt };
  }
  const { deliveredAgentRunFailure, mediaUrls, normalized } = outcome;
  // Suppress duplicate heartbeats (same payload) within a short window.
  // This prevents "nagging" when nothing changed but the model repeats the same items.
  const prevHeartbeatText =
    typeof entry?.lastHeartbeatText === "string" ? entry.lastHeartbeatText : "";
  const prevHeartbeatAt =
    typeof entry?.lastHeartbeatSentAt === "number" ? entry.lastHeartbeatSentAt : undefined;
  const isDuplicateMain =
    !mediaUrls.length &&
    Boolean(prevHeartbeatText.trim()) &&
    normalized.text.trim() === prevHeartbeatText.trim() &&
    typeof prevHeartbeatAt === "number" &&
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
    await markDueCommitments("dismissed");
    consumeInspectedSystemEvents(params.wake, params.prepared);
    return { status: "ran", durationMs: Date.now() - startedAt };
  }

  const previewText = normalized.text;
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

  const send = await sendDurableMessageBatch({
    cfg,
    channel: delivery.channel,
    to: delivery.to,
    accountId: deliveryAccountId,
    session: params.outboundSession,
    identity: params.outboundIdentity,
    threadId: delivery.threadId,
    payloads: [{ text: normalized.text, mediaUrls }],
    deps: params.opts.deps,
    silent: normalized.silent,
  });
  if (send.status === "failed" || send.status === "partial_failed") {
    throw send.error;
  }
  const visibleSendSucceeded = send.status === "sent";
  // Suppressed durable sends committed no visible channel message. Keep due
  // commitments and heartbeat dedupe state active so a later heartbeat can retry.
  if (visibleSendSucceeded) {
    await markDueCommitments("sent");
  }

  // Record last delivered heartbeat payload for dedupe.
  if (visibleSendSucceeded && normalized.text.trim()) {
    await patchSessionEntry(
      { storePath, sessionKey },
      (current, context) => {
        if (!context.existingEntry) {
          return null;
        }
        // A heartbeat-driven agent run can leave its own pendingFinalDelivery
        // set; a successful send completes it, so clear the recovery fields.
        // Only clear the pending-final this run owns — an older final the run
        // did not produce keeps its own recovery path.
        const clearedRecoveryFields = heartbeatRunOwnsPendingFinalDelivery(current, startedAt)
          ? CLEARED_PENDING_FINAL_DELIVERY_FIELDS
          : {};
        return {
          lastHeartbeatText: normalized.text,
          lastHeartbeatSentAt: startedAt,
          ...clearedRecoveryFields,
        };
      },
      { preserveActivity: true },
    );
  }

  const eventStatus = deliveredAgentRunFailure
    ? "failed"
    : visibleSendSucceeded
      ? "sent"
      : "skipped";
  emitHeartbeatEvent({
    status: eventStatus,
    to: delivery.to,
    ...(deliveredAgentRunFailure ? { reason: "agent-runner-failure" } : {}),
    ...(!deliveredAgentRunFailure && !visibleSendSucceeded ? { reason: send.reason } : {}),
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
  await patchSessionEntry(
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
