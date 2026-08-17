import { copyReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
// Finalizes outbound modifying policy before durable queue custody is created.
import type { ReplyPayload } from "../../auto-reply/types.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { throwIfAborted } from "./abort.js";
import { createChannelHandler, resolveChannelOutboundDirectiveOptions } from "./deliver-channel.js";
import type { DeliverOutboundPayloadsParams } from "./deliver-contracts.js";
import { applyMessageSendingHook, applyReplyPayloadSendingHook } from "./deliver-hooks.js";
import {
  buildPayloadSummary,
  normalizeEmptyPayloadForDelivery,
  normalizePayloadsForChannelDelivery,
  resolveOutboundMediaAccessForSend,
  stripInternalRuntimeScaffoldingFromPayload,
} from "./deliver-payload.js";
import { createOutboundPayloadPlan } from "./payloads.js";
import {
  PREPARED_OUTBOUND_BATCH_SCHEMA_VERSION,
  type PreparedOutboundBatch,
  type PreparedOutboundBatchEntry,
} from "./prepared-batch.js";
import { createReplyToDeliveryPolicy } from "./reply-policy.js";

class OutboundPayloadPreparationError extends Error {
  readonly sourceIndex: number;
  readonly payload: ReplyPayload;

  constructor(error: unknown, sourceIndex: number, payload: ReplyPayload) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = "OutboundPayloadPreparationError";
    this.sourceIndex = sourceIndex;
    this.payload = payload;
  }
}

function throwIfPreparationAborted(
  signal: AbortSignal | undefined,
  sourceIndex: number,
  payload: ReplyPayload,
): void {
  try {
    throwIfAborted(signal);
  } catch (error) {
    throw new OutboundPayloadPreparationError(error, sourceIndex, payload);
  }
}

async function createPreparationHandler(params: DeliverOutboundPayloadsParams) {
  return await createChannelHandler({
    cfg: params.cfg,
    agentId: params.session?.agentId,
    channel: params.channel,
    to: params.to,
    deps: params.deps,
    accountId: params.accountId,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    formatting: params.formatting,
    threadId: params.threadId,
    identity: params.identity,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    silent: params.silent,
    mediaAccess: resolveOutboundMediaAccessForSend(params, params.channel, []),
    gatewayClientScopes: params.gatewayClientScopes,
    conversationReadOrigin: params.conversationReadOrigin,
    preparedMessageId: params.preparedMessageId,
    requiredUnknownSendReconciliation: params.requiredUnknownSendReconciliation,
  });
}

function suppressionReasonForEmpty(params: {
  replyHookChanged: boolean;
  messageHookChanged: boolean;
}) {
  return params.messageHookChanged
    ? ("empty_after_message_sending_hook" as const)
    : params.replyHookChanged
      ? ("empty_after_reply_payload_sending_hook" as const)
      : ("no_visible_payload" as const);
}

function compactPreparedPayload(payload: ReplyPayload): ReplyPayload {
  const summary = buildPayloadSummary(payload);
  const {
    audioAsVoice,
    mediaUrl: _mediaUrl,
    mediaUrls: _mediaUrls,
    replyToCurrent,
    replyToId,
    replyToTag,
    text: _text,
    ...rest
  } = payload;
  return copyReplyPayloadMetadata(
    payload,
    Object.fromEntries(
      Object.entries({
        ...rest,
        ...(typeof payload.text === "string" ? { text: summary.text } : {}),
        ...(summary.mediaUrls.length === 1
          ? { mediaUrl: summary.mediaUrls[0] }
          : summary.mediaUrls.length > 1
            ? { mediaUrls: summary.mediaUrls }
            : {}),
        ...(replyToId !== undefined ? { replyToId } : {}),
        ...(replyToTag === true ? { replyToTag: true } : {}),
        ...(replyToCurrent === true ? { replyToCurrent: true } : {}),
        ...(audioAsVoice === true ? { audioAsVoice: true } : {}),
      }).filter(([, value]) => value !== undefined),
    ) as ReplyPayload,
  );
}

/**
 * Runs each modifier exactly once and returns the sole payload representation
 * eligible for durable persistence or provider delivery.
 */
export async function prepareOutboundPayloadBatch(
  params: DeliverOutboundPayloadsParams,
  options?: { onBeforeFirstModifier?: () => void },
): Promise<PreparedOutboundBatch> {
  const directiveOptions = await resolveChannelOutboundDirectiveOptions({
    cfg: params.cfg,
    agentId: params.session?.agentId,
    channel: params.channel,
  });
  const plan = createOutboundPayloadPlan(params.payloads, {
    cfg: params.cfg,
    sessionKey: params.session?.policyKey ?? params.session?.key,
    surface: params.channel,
    conversationType: params.session?.conversationType,
    extractMarkdownImages: directiveOptions.extractMarkdownImages,
  });
  const handler = await createPreparationHandler(params);
  const normalized = normalizePayloadsForChannelDelivery(plan, handler);
  const normalizedIndexes = new Set(normalized.map((entry) => entry.index));
  const entries: PreparedOutboundBatchEntry[] = [];
  for (const [sourceIndex] of params.payloads.entries()) {
    if (!normalizedIndexes.has(sourceIndex)) {
      entries.push({ sourceIndex, status: "suppressed", reason: "no_visible_payload" });
    }
  }

  const hookRunner = getGlobalHookRunner();
  const hasReplyPayloadSendingHooks =
    params.replyPayloadSendingHook !== undefined &&
    (hookRunner?.hasHooks("reply_payload_sending") ?? false);
  const hasMessageSendingHooks = hookRunner?.hasHooks("message_sending") ?? false;
  const hasModifyingHooks = hasReplyPayloadSendingHooks || hasMessageSendingHooks;
  const { resolveCurrentReplyTo } = createReplyToDeliveryPolicy({
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
  });
  const sessionKeyForHooks = params.mirror?.sessionKey ?? params.session?.key;
  let modifierBoundaryEntered = false;

  for (const { index: sourceIndex, payload } of normalized) {
    throwIfPreparationAborted(params.abortSignal, sourceIndex, payload);
    if (hasModifyingHooks && !modifierBoundaryEntered) {
      options?.onBeforeFirstModifier?.();
      modifierBoundaryEntered = true;
    }
    let replyHookResult: Awaited<ReturnType<typeof applyReplyPayloadSendingHook>>;
    try {
      replyHookResult = await applyReplyPayloadSendingHook({
        hook: params.replyPayloadSendingHook,
        payload,
      });
    } catch (error) {
      throw new OutboundPayloadPreparationError(error, sourceIndex, payload);
    }
    throwIfPreparationAborted(params.abortSignal, sourceIndex, replyHookResult.payload);
    if (replyHookResult.cancelled) {
      entries.push({
        sourceIndex,
        status: "suppressed",
        reason: "cancelled_by_reply_payload_sending_hook",
      });
      continue;
    }

    const replyPayload = stripInternalRuntimeScaffoldingFromPayload(replyHookResult.payload);
    let messageHookResult: Awaited<ReturnType<typeof applyMessageSendingHook>>;
    try {
      messageHookResult = await applyMessageSendingHook({
        hookRunner,
        enabled: hasMessageSendingHooks,
        payload: replyPayload,
        payloadSummary: buildPayloadSummary(replyPayload),
        to: params.to,
        channel: params.channel,
        accountId: params.accountId,
        replyToId: resolveCurrentReplyTo(replyPayload).replyToId,
        threadId: params.threadId,
        sessionKey: sessionKeyForHooks,
      });
    } catch (error) {
      // Modifier handlers are fail-open. Only a host invariant failure can
      // escape here, and atomic preparation must attribute it before aborting.
      throw new OutboundPayloadPreparationError(error, sourceIndex, replyPayload);
    }
    throwIfPreparationAborted(params.abortSignal, sourceIndex, messageHookResult.payload);
    if (messageHookResult.cancelled) {
      const hookEffect =
        messageHookResult.cancelReason || messageHookResult.hookMetadata
          ? {
              ...(messageHookResult.cancelReason
                ? { cancelReason: messageHookResult.cancelReason }
                : {}),
              ...(messageHookResult.hookMetadata
                ? { metadata: messageHookResult.hookMetadata }
                : {}),
            }
          : undefined;
      entries.push({
        sourceIndex,
        status: "suppressed",
        reason: "cancelled_by_message_sending_hook",
        ...(hookEffect ? { hookEffect } : {}),
      });
      continue;
    }

    const postHookPayload = stripInternalRuntimeScaffoldingFromPayload(messageHookResult.payload);
    // Adapter normalization may project visible text into transport fields. Re-run it
    // after policy so durable custody cannot retain a stale pre-rewrite projection.
    const normalizedPostHookPayload = handler.normalizePayload
      ? handler.normalizePayload(postHookPayload)
      : postHookPayload;
    const preparedPayload = normalizedPostHookPayload
      ? normalizeEmptyPayloadForDelivery(
          stripInternalRuntimeScaffoldingFromPayload(normalizedPostHookPayload),
        )
      : null;
    if (!preparedPayload) {
      entries.push({
        sourceIndex,
        status: "suppressed",
        reason: suppressionReasonForEmpty({
          replyHookChanged: replyHookResult.changed,
          messageHookChanged: messageHookResult.contentRewritten,
        }),
      });
      continue;
    }
    const compactPayload = compactPreparedPayload(preparedPayload);
    entries.push({
      sourceIndex,
      status: "accepted",
      payload: compactPayload,
      replyHookChanged: replyHookResult.changed,
      messageHookChanged: messageHookResult.contentRewritten,
      preparedMediaCount: buildPayloadSummary(compactPayload).mediaUrls.length,
    });
  }

  return {
    schemaVersion: PREPARED_OUTBOUND_BATCH_SCHEMA_VERSION,
    sourcePayloadCount: params.payloads.length,
    channelNormalized: true,
    ...(params.replyPayloadSendingHook?.runId
      ? { runId: params.replyPayloadSendingHook.runId }
      : {}),
    entries,
  };
}
