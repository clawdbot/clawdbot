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
    // #41966: never persist plan-time fenced-MEDIA diagnostics inside nested
    // durable payload JSON. Entry-level facts are rebuilt post-policy below;
    // rest-spread would otherwise retain pre-redaction MEDIA paths/URLs.
    mediaTokenSkippedInFence: _mediaTokenSkippedInFence,
    fencedSkippedMediaDirectives: _fencedSkippedMediaDirectives,
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
    // Durable custody may only retain post-policy fenced-skip facts. Never copy
    // pre-hook directive identities into the accepted batch after redaction/rewrite
    // (queue recovery would otherwise keep raw MEDIA paths). Fence-stripping
    // adapters may still keep the exact directive line as plain text — those
    // retained identities are safe and needed for post-send diagnostics (#41966).
    const sourcePlan = plan.find((entry) => entry.sourceIndex === sourceIndex);
    const acceptedText = compactPayload.text;
    const retainedDirectives = (sourcePlan?.fencedSkippedMediaDirectives ?? []).filter(
      (directive) => {
        const identity = directive.trim();
        if (!identity || !acceptedText) {
          return false;
        }
        return acceptedText.split("\n").some((line) => line.trim() === identity);
      },
    );
    // Preserve block-reply / disabled parsing mode on accepted replan. Passing
    // text-only would default extractMediaDirectives on and falsely mark fenced
    // MEDIA as skipped for durable diagnostics (#41966 / ClawSweeper P2).
    const acceptedPlan = acceptedText
      ? createOutboundPayloadPlan(
          [
            {
              text: acceptedText,
              ...(compactPayload.extractMediaDirectives === false
                ? { extractMediaDirectives: false as const }
                : compactPayload.extractMediaDirectives === true
                  ? { extractMediaDirectives: true as const }
                  : {}),
            },
          ],
          {
            cfg: params.cfg,
            sessionKey: params.session?.policyKey ?? params.session?.key,
            surface: params.channel,
            conversationType: params.session?.conversationType,
            extractMediaDirectives: compactPayload.extractMediaDirectives,
          },
        )[0]
      : undefined;
    const durableDirectives =
      retainedDirectives.length > 0
        ? retainedDirectives
        : acceptedPlan?.mediaTokenSkippedInFence
          ? [...(acceptedPlan.fencedSkippedMediaDirectives ?? [])]
          : [];
    const fencedSkip =
      durableDirectives.length > 0 || acceptedPlan?.mediaTokenSkippedInFence === true
        ? {
            mediaTokenSkippedInFence: true as const,
            ...(durableDirectives.length > 0
              ? { fencedSkippedMediaDirectives: durableDirectives }
              : {}),
          }
        : {};
    entries.push({
      sourceIndex,
      status: "accepted",
      payload: compactPayload,
      replyHookChanged: replyHookResult.changed,
      messageHookChanged: messageHookResult.contentRewritten,
      preparedMediaCount: buildPayloadSummary(compactPayload).mediaUrls.length,
      ...fencedSkip,
    });
  }

  return {
    schemaVersion: PREPARED_OUTBOUND_BATCH_SCHEMA_VERSION,
    sourcePayloadCount: params.payloads.length,
    channelNormalized: true,
    ...((params.runId ?? params.replyPayloadSendingHook?.runId)
      ? { runId: params.runId ?? params.replyPayloadSendingHook?.runId }
      : {}),
    ...(params.executionIdentityToken
      ? { executionIdentityToken: params.executionIdentityToken }
      : {}),
    entries,
  };
}
