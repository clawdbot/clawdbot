// Mattermost plugin module owns draft-preview final delivery.
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
  listMessageReceiptPlatformIds,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  isReasoningReplyPayload,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { updateMattermostPost, type MattermostClient, type MattermostPost } from "./client.js";
import { createMattermostDraftStream } from "./draft-stream.js";
import { canFinalizeMattermostPreviewInPlace } from "./monitor-context.js";
import {
  joinMattermostVisibleContent,
  type MattermostReplyDeliveryResult,
} from "./reply-delivery.js";
import type { ChatType, ReplyPayload } from "./runtime-api.js";

export type MattermostDraftPreviewState = {
  /** True once the preview is the durable final post and must not be reused as a draft. */
  finalizedViaPreviewPost: boolean;
};

export type MattermostPreviewFinalResolution = {
  editText?: string;
  deliveryText?: string;
  confirmedDelivery?: MattermostReplyDeliveryResult;
  alreadyDelivered: boolean;
};

type MattermostDraftPreviewDeliverParams = {
  payload: ReplyPayload;
  info: { kind: "tool" | "block" | "final" };
  kind: ChatType;
  client: MattermostClient;
  draftStream: Pick<
    ReturnType<typeof createMattermostDraftStream>,
    "flush" | "postId" | "clear" | "discardPending" | "seal"
  >;
  effectiveReplyToId?: string;
  resolvePreviewFinalText: (text?: string) => MattermostPreviewFinalResolution | undefined;
  previewState: MattermostDraftPreviewState;
  logVerboseMessage: (message: string) => void;
  deliverPayload: (payload: ReplyPayload) => Promise<MattermostReplyDeliveryResult>;
  // Visible same-thread finals can be delivered by editing the draft preview in
  // place (onPreviewFinalized) without ever calling deliverPayload; this lets the
  // caller record thread participation on that path too.
  recordThreadParticipation?: () => void;
};

function combineMattermostVisibleDeliveryResults(
  results: readonly (MattermostReplyDeliveryResult | undefined)[],
): MattermostReplyDeliveryResult | undefined {
  const visibleResults = results.filter(
    (result): result is MattermostReplyDeliveryResult => result?.visibleReplySent === true,
  );
  if (visibleResults.length === 0) {
    return undefined;
  }
  const receiptResults: Array<{ receipt: MessageReceipt } | { messageId: string }> = [];
  for (const result of visibleResults) {
    if (result.receipt) {
      receiptResults.push({ receipt: result.receipt });
    } else {
      receiptResults.push(...(result.messageIds ?? []).map((messageId) => ({ messageId })));
    }
  }
  const receipt = createMessageReceiptFromOutboundResults({
    results: receiptResults,
  });
  return {
    outcome: visibleResults.some((result) => result.outcome === "media") ? "media" : "text",
    messageIds: listMessageReceiptPlatformIds(receipt),
    receipt,
    visibleReplySent: true,
    content: joinMattermostVisibleContent(visibleResults.map((result) => result.content)),
  };
}

export async function deliverMattermostReplyWithDraftPreview(
  params: MattermostDraftPreviewDeliverParams,
): Promise<MattermostReplyDeliveryResult> {
  if (isReasoningReplyPayload(params.payload)) {
    return {
      outcome: "reasoning_skipped",
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    };
  }

  let normalDeliveryResult: MattermostReplyDeliveryResult | undefined;
  let supplementalDeliveryResult: MattermostReplyDeliveryResult | undefined;
  let previewDeliveryResult: MattermostReplyDeliveryResult | undefined;
  let confirmedPreviewDelivery: MattermostReplyDeliveryResult | undefined;
  let previewFinalDeliveryText: string | undefined;
  let previewFinalTextAlreadyDelivered = false;
  let useConfirmedPreviewAsWholeFinal = false;
  let pendingPreviewFinalContent: string | undefined;
  let finalizedPreviewPost: MattermostPost | undefined;
  try {
    const finalization = await deliverWithFinalizableLivePreviewAdapter({
      kind: params.info.kind,
      payload: params.payload,
      adapter: defineFinalizableLivePreviewAdapter<ReplyPayload, string, { message: string }>({
        // Once the preview is finalized, later payloads must use durable sends.
        // Reusing the sealed draft would clear and delete the successful final post.
        ...(params.previewState.finalizedViaPreviewPost
          ? {}
          : {
              draft: {
                flush: params.draftStream.flush,
                clear: params.draftStream.clear,
                discardPending: params.draftStream.discardPending,
                seal: params.draftStream.seal,
                id: params.draftStream.postId,
              },
            }),
        buildFinalEdit: (payload) => {
          const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
          const ttsSupplement = getReplyPayloadTtsSupplement(payload);
          const previewFinalResolution = params.resolvePreviewFinalText(
            payload.text ?? ttsSupplement?.spokenText,
          );
          confirmedPreviewDelivery = previewFinalResolution?.confirmedDelivery;
          previewFinalDeliveryText = previewFinalResolution?.deliveryText;
          previewFinalTextAlreadyDelivered =
            previewFinalResolution?.alreadyDelivered === true && payload.isError !== true;
          useConfirmedPreviewAsWholeFinal =
            previewFinalTextAlreadyDelivered &&
            !resolveSendableOutboundReplyParts(payload).hasMedia;
          const previewFinalText = previewFinalResolution?.editText;

          if (
            (hasMedia && !ttsSupplement) ||
            typeof previewFinalText !== "string" ||
            payload.isError ||
            !canFinalizeMattermostPreviewInPlace({
              kind: params.kind,
              previewRootId: params.effectiveReplyToId,
              threadRootId: params.effectiveReplyToId,
              replyToId: payload.replyToId,
            })
          ) {
            return undefined;
          }
          pendingPreviewFinalContent = previewFinalText;
          return { message: previewFinalText };
        },
        editFinal: async (previewPostId, edit) => {
          finalizedPreviewPost = await updateMattermostPost(params.client, previewPostId, edit);
        },
        resolveFinalizedId: (previewPostId) => finalizedPreviewPost?.id ?? previewPostId,
        onPreviewFinalized: (_previewPostId, receipt) => {
          params.previewState.finalizedViaPreviewPost = true;
          // Supplemental retries must not repost text already committed by the preview edit.
          previewFinalTextAlreadyDelivered = true;
          previewDeliveryResult = {
            outcome: "text",
            messageIds: listMessageReceiptPlatformIds(receipt),
            receipt,
            visibleReplySent: true,
            content: finalizedPreviewPost?.message ?? pendingPreviewFinalContent ?? "",
          };
          // The visible final reply landed by editing the preview post, so the normal
          // deliverPayload record path is skipped; record participation explicitly here.
          params.recordThreadParticipation?.();
        },
        buildSupplementalPayload: (payload) =>
          getReplyPayloadTtsSupplement(payload)
            ? buildTtsSupplementMediaPayload(payload)
            : undefined,
        deliverSupplemental: async (payload) => {
          supplementalDeliveryResult = await params.deliverPayload(payload);
          return supplementalDeliveryResult.visibleReplySent;
        },
        logPreviewEditFailure: (err) => {
          params.logVerboseMessage(
            `mattermost preview final edit failed; falling back to normal send (${String(err)})`,
          );
        },
      }),
      deliverNormally: async (payload) => {
        if (
          useConfirmedPreviewAsWholeFinal &&
          confirmedPreviewDelivery?.visibleReplySent === true
        ) {
          // The logical final is already durable in sealed preview generations. Report
          // those provider posts as the normal success so cleanup cannot erase the fact.
          return true;
        }
        const supplement = getReplyPayloadTtsSupplement(payload);
        const resolvedDeliveryText =
          previewFinalDeliveryText ?? (previewFinalTextAlreadyDelivered ? "" : undefined);
        const payloadText = payload.text?.trim();
        // TTS metadata is authoritative when its text is already visible. Only restore
        // spoken text when neither that contract nor provider-confirmed preview posts cover it.
        const deliveryPayload =
          payload.isError !== true &&
          supplement &&
          (previewFinalTextAlreadyDelivered ||
            (!payloadText && supplement.visibleTextAlreadyDelivered === true))
            ? buildTtsSupplementMediaPayload(payload)
            : payload.isError !== true && supplement && !payloadText
              ? {
                  ...payload,
                  text: resolvedDeliveryText?.trim() ? resolvedDeliveryText : supplement.spokenText,
                }
              : payload.isError !== true && typeof resolvedDeliveryText === "string"
                ? { ...payload, text: resolvedDeliveryText }
                : payload;
        normalDeliveryResult = await params.deliverPayload(deliveryPayload);
        return normalDeliveryResult.visibleReplySent;
      },
    });

    if (finalization.kind !== "preview-finalized" || !previewDeliveryResult?.receipt) {
      return (
        combineMattermostVisibleDeliveryResults([
          confirmedPreviewDelivery,
          normalDeliveryResult,
        ]) ?? {
          outcome: "empty",
          visibleReplySent: false,
          suppression: { reason: "no_visible_result" },
        }
      );
    }
    return (
      combineMattermostVisibleDeliveryResults([
        confirmedPreviewDelivery,
        previewDeliveryResult,
        supplementalDeliveryResult,
        // Supplemental retries use the normal sender; retain its durable receipt too.
        normalDeliveryResult,
      ]) ?? previewDeliveryResult
    );
  } catch (error: unknown) {
    // Preserve confirmed preview and supplemental receipts so core cannot
    // mistake a later visible-delivery failure for a safe retry.
    const completedVisibleResults: MattermostReplyDeliveryResult[] = [];
    const completedReceiptResults: Array<{ receipt: MessageReceipt } | { messageId: string }> = [];
    for (const result of [
      confirmedPreviewDelivery,
      previewDeliveryResult,
      normalDeliveryResult,
      supplementalDeliveryResult,
    ]) {
      if (result?.visibleReplySent !== true) {
        continue;
      }
      completedVisibleResults.push(result);
      if (result.receipt) {
        completedReceiptResults.push({ receipt: result.receipt });
      } else {
        completedReceiptResults.push(
          ...(result.messageIds ?? []).map((messageId) => ({ messageId })),
        );
      }
    }
    if (completedVisibleResults.length === 0) {
      throw error;
    }
    const failedPartial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
    const receipt = createMessageReceiptFromOutboundResults({
      results: [
        ...completedReceiptResults,
        ...(failedPartial?.receipt
          ? [{ receipt: failedPartial.receipt }]
          : (failedPartial?.messageIds ?? []).map((messageId) => ({ messageId }))),
      ],
    });
    throw createChannelPartialDeliveryError(error, {
      messageIds: listMessageReceiptPlatformIds(receipt),
      receipt,
      visibleReplySent: true,
      content: joinMattermostVisibleContent([
        confirmedPreviewDelivery?.content,
        previewDeliveryResult?.content,
        normalDeliveryResult?.content,
        supplementalDeliveryResult?.content,
        failedPartial?.content,
      ]),
    });
  }
}
