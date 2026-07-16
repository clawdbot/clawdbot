// Mattermost plugin module owns draft-preview final delivery.
import {
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  isReasoningReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { updateMattermostPost, type MattermostClient } from "./client.js";
import { createMattermostDraftStream } from "./draft-stream.js";
import { canFinalizeMattermostPreviewInPlace } from "./monitor-context.js";
import type { ChatType, ReplyPayload } from "./runtime-api.js";

export type MattermostDraftPreviewState = {
  finalizedViaPreviewPost: boolean;
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
  resolvePreviewFinalText: (text?: string) => string | undefined;
  previewState: MattermostDraftPreviewState;
  logVerboseMessage: (message: string) => void;
  deliverPayload: (payload: ReplyPayload) => Promise<void>;
  // Visible same-thread finals can be delivered by editing the draft preview in
  // place (onPreviewFinalized) without ever calling deliverPayload; this lets the
  // caller record thread participation on that path too.
  recordThreadParticipation?: () => void;
};

export async function deliverMattermostReplyWithDraftPreview(
  params: MattermostDraftPreviewDeliverParams,
): Promise<void> {
  if (isReasoningReplyPayload(params.payload)) {
    return;
  }

  await deliverWithFinalizableLivePreviewAdapter({
    kind: params.info.kind,
    payload: params.payload,
    adapter: defineFinalizableLivePreviewAdapter<ReplyPayload, string, { message: string }>({
      draft: {
        flush: params.draftStream.flush,
        clear: params.draftStream.clear,
        discardPending: params.draftStream.discardPending,
        seal: params.draftStream.seal,
        id: params.draftStream.postId,
      },
      buildFinalEdit: (payload) => {
        const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
        const ttsSupplement = getReplyPayloadTtsSupplement(payload);
        const previewFinalText = params.resolvePreviewFinalText(
          payload.text ?? ttsSupplement?.spokenText,
        );

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
        return { message: previewFinalText };
      },
      editFinal: async (previewPostId, edit) => {
        await updateMattermostPost(params.client, previewPostId, edit);
      },
      onPreviewFinalized: () => {
        params.previewState.finalizedViaPreviewPost = true;
        // The visible final reply landed by editing the preview post, so the normal
        // deliverPayload record path is skipped; record participation explicitly here.
        params.recordThreadParticipation?.();
      },
      buildSupplementalPayload: (payload) =>
        getReplyPayloadTtsSupplement(payload) ? buildTtsSupplementMediaPayload(payload) : undefined,
      deliverSupplemental: async (payload) => {
        await params.deliverPayload(payload);
      },
      logPreviewEditFailure: (err) => {
        params.logVerboseMessage(
          `mattermost preview final edit failed; falling back to normal send (${String(err)})`,
        );
      },
    }),
    deliverNormally: async (payload) => {
      const supplement = getReplyPayloadTtsSupplement(payload);
      await params.deliverPayload(
        supplement && !payload.text?.trim() && supplement.visibleTextAlreadyDelivered !== true
          ? { ...payload, text: supplement.spokenText }
          : payload,
      );
    },
  });
}
