import {
  createPreviewMessageReceipt,
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
} from "openclaw/plugin-sdk/reply-payload";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CoreConfig, MatrixStreamingMode, ReplyToMode } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import type { createMatrixDraftController } from "./handler-draft-controller.js";
import {
  buildMatrixFinalizedPreviewContent,
  loadMatrixSendModule,
  matrixTextWouldActivateMentions,
  redactMatrixDraftEvent,
  type MatrixDraftStreamHandle,
} from "./handler-runtime.js";
import { deliverMatrixReplies } from "./replies.js";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  type ReplyPayload,
  type RuntimeEnv,
} from "./runtime-api.js";

type MatrixDraftController = Awaited<ReturnType<typeof createMatrixDraftController>>;

export function createMatrixReplyDispatcher(config: {
  cfg: CoreConfig;
  prefixOptions: Omit<ReturnType<typeof createReplyPrefixOptions>, "onModelSelected">;
  humanDelay: ReturnType<
    typeof import("openclaw/plugin-sdk/agent-runtime").resolveHumanDelayConfig
  >;
  typingCallbacks: ReturnType<typeof createTypingCallbacks>;
  streaming: MatrixStreamingMode;
  draftStream: MatrixDraftStreamHandle | undefined;
  draftController: MatrixDraftController;
  client: MatrixClient;
  roomId: string;
  runtime: RuntimeEnv;
  textLimit: number;
  replyToMode: ReplyToMode;
  threadTarget?: string;
  replyToEventId?: string;
  accountId: string;
  mediaLocalRoots: readonly string[];
  tableMode: Parameters<typeof deliverMatrixReplies>[0]["tableMode"];
  logVerboseMessage: (message: string) => void;
}) {
  const {
    cfg,
    prefixOptions,
    humanDelay,
    typingCallbacks,
    streaming,
    draftStream,
    draftController,
    client,
    roomId,
    runtime,
    textLimit,
    replyToMode,
    threadTarget,
    replyToEventId,
    accountId,
    mediaLocalRoots,
    tableMode,
    logVerboseMessage,
  } = config;
  const quietDraftStreaming = streaming === "quiet" || streaming === "progress";
  let finalReplyDeliveryFailed = false;
  let nonFinalReplyDeliveryFailed = false;

  const dispatcherOptions = {
    ...prefixOptions,
    humanDelay,
    deliver: async (payload: ReplyPayload, info: { kind: string }) => {
      if (draftStream && info.kind !== "tool" && !payload.isCompactionNotice) {
        const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
        const ttsSupplement = getReplyPayloadTtsSupplement(payload);
        const fallbackPayload =
          ttsSupplement &&
          ttsSupplement.visibleTextAlreadyDelivered !== true &&
          !payload.text?.trim()
            ? { ...payload, text: ttsSupplement.spokenText }
            : payload;

        if (draftController.isDraftConsumed()) {
          await draftStream.discardPending();
          await deliverMatrixReplies({
            cfg,
            replies: [fallbackPayload],
            roomId,
            client,
            runtime,
            textLimit,
            replyToMode,
            threadId: threadTarget,
            replyToId: threadTarget ?? replyToEventId ?? undefined,
            accountId,
            mediaLocalRoots,
            tableMode,
          });
          return;
        }

        const payloadReplyToId = normalizeOptionalString(payload.replyToId);
        const payloadReplyMismatch =
          replyToMode !== "off" &&
          !threadTarget &&
          payloadReplyToId !== draftController.currentReplyToId();
        let mustDeliverFinalNormally = draftStream.mustDeliverFinalNormally();
        const canPotentiallyFinalizeDraft =
          Boolean(payload.text?.trim()) &&
          !payload.isError &&
          !payloadReplyMismatch &&
          !mustDeliverFinalNormally;

        if (canPotentiallyFinalizeDraft) {
          await draftStream.stop();
          mustDeliverFinalNormally = draftStream.mustDeliverFinalNormally();
        } else {
          await draftStream.discardPending();
        }
        const draftEventId = draftStream.eventId();
        const draftFinalTextNeedsNormalMentionDelivery =
          Boolean(draftEventId) &&
          typeof payload.text === "string" &&
          Boolean(payload.text.trim()) &&
          !payload.isError &&
          !payloadReplyMismatch &&
          !mustDeliverFinalNormally &&
          (await matrixTextWouldActivateMentions(client, payload.text));

        if (
          draftEventId &&
          payload.text &&
          !payload.isError &&
          !hasMedia &&
          !payloadReplyMismatch &&
          !mustDeliverFinalNormally &&
          !draftFinalTextNeedsNormalMentionDelivery
        ) {
          const finalPreviewText = payload.text;
          await deliverWithFinalizableLivePreviewAdapter<
            ReplyPayload,
            string,
            {
              text: string;
              finalizeLive: boolean;
              extraContent?: Record<string, unknown>;
            }
          >({
            kind: "final",
            payload,
            adapter: defineFinalizableLivePreviewAdapter({
              draft: {
                flush: async () => {},
                clear: async () => {},
                discardPending: async () => {},
                id: () => draftEventId,
              },
              buildFinalEdit: () => ({
                text: finalPreviewText,
                finalizeLive: !(
                  quietDraftStreaming || !draftStream.matchesPreparedText(finalPreviewText)
                ),
                ...(quietDraftStreaming
                  ? { extraContent: buildMatrixFinalizedPreviewContent() }
                  : {}),
              }),
              editFinal: async (_draftEventId, edit) => {
                if (edit.finalizeLive) {
                  if (!(await draftStream.finalizeLive())) {
                    throw new Error("Matrix draft live finalize failed");
                  }
                  return;
                }
                const { editMessageMatrix } = await loadMatrixSendModule();
                await editMessageMatrix(roomId, _draftEventId, edit.text, {
                  client,
                  cfg,
                  threadId: threadTarget,
                  accountId,
                  extraContent: edit.extraContent,
                });
              },
              createPreviewReceipt: (id): MessageReceipt =>
                createPreviewMessageReceipt({
                  id,
                  ...(threadTarget ? { threadId: threadTarget } : {}),
                  ...(draftController.currentReplyToId()
                    ? { replyToId: draftController.currentReplyToId() }
                    : {}),
                }),
              logPreviewEditFailure: (err) => {
                logVerboseMessage(`matrix: preview final edit failed: ${String(err)}`);
              },
            }),
            deliverNormally: async () => {
              await redactMatrixDraftEvent(client, roomId, draftEventId);
              await deliverMatrixReplies({
                cfg,
                replies: [fallbackPayload],
                roomId,
                client,
                runtime,
                textLimit,
                replyToMode,
                threadId: threadTarget,
                replyToId: threadTarget ?? replyToEventId ?? undefined,
                accountId,
                mediaLocalRoots,
                tableMode,
              });
            },
          });
          draftController.markDraftConsumed();
        } else if (draftEventId && hasMedia && !payloadReplyMismatch) {
          let textEditOk = !mustDeliverFinalNormally;
          const payloadText = payload.text ?? ttsSupplement?.spokenText;
          const payloadTextMatchesDraft =
            typeof payloadText === "string" && draftStream.matchesPreparedText(payloadText);
          const reusesDraftTextUnchanged =
            typeof payloadText === "string" &&
            Boolean(payloadText.trim()) &&
            payloadTextMatchesDraft;
          const mediaTextNeedsNormalMentionDelivery =
            typeof payloadText === "string" &&
            Boolean(payloadText.trim()) &&
            (await matrixTextWouldActivateMentions(client, payloadText));
          const requiresFinalTextEdit =
            quietDraftStreaming || (typeof payloadText === "string" && !payloadTextMatchesDraft);
          if (textEditOk && mediaTextNeedsNormalMentionDelivery) {
            textEditOk = false;
          } else if (textEditOk && payloadText && requiresFinalTextEdit) {
            const { editMessageMatrix } = await loadMatrixSendModule();
            textEditOk = await editMessageMatrix(roomId, draftEventId, payloadText, {
              client,
              cfg,
              threadId: threadTarget,
              accountId,
              extraContent: quietDraftStreaming ? buildMatrixFinalizedPreviewContent() : undefined,
            }).then(
              () => true,
              () => false,
            );
          } else if (textEditOk && reusesDraftTextUnchanged) {
            textEditOk = await draftStream.finalizeLive();
          }
          const reusesDraftAsFinalText = Boolean(payloadText?.trim()) && textEditOk;
          if (!reusesDraftAsFinalText) {
            await redactMatrixDraftEvent(client, roomId, draftEventId);
          }
          const mediaPayload =
            ttsSupplement && reusesDraftAsFinalText
              ? buildTtsSupplementMediaPayload(payload)
              : {
                  ...payload,
                  text: reusesDraftAsFinalText
                    ? undefined
                    : (payload.text ??
                      (ttsSupplement?.visibleTextAlreadyDelivered === true
                        ? undefined
                        : ttsSupplement?.spokenText)),
                };
          await deliverMatrixReplies({
            cfg,
            replies: [mediaPayload],
            roomId,
            client,
            runtime,
            textLimit,
            replyToMode,
            threadId: threadTarget,
            replyToId: threadTarget ?? replyToEventId ?? undefined,
            accountId,
            mediaLocalRoots,
            tableMode,
          });
          draftController.markDraftConsumed();
        } else {
          const draftRedacted =
            Boolean(draftEventId) &&
            (payload.isError ||
              payloadReplyMismatch ||
              mustDeliverFinalNormally ||
              draftFinalTextNeedsNormalMentionDelivery);
          if (draftRedacted && draftEventId) {
            await redactMatrixDraftEvent(client, roomId, draftEventId);
          }
          const deliveredFallback = await deliverMatrixReplies({
            cfg,
            replies: [fallbackPayload],
            roomId,
            client,
            runtime,
            textLimit,
            replyToMode,
            threadId: threadTarget,
            replyToId: threadTarget ?? replyToEventId ?? undefined,
            accountId,
            mediaLocalRoots,
            tableMode,
          });
          if (draftRedacted || deliveredFallback) {
            draftController.markDraftConsumed();
          }
        }

        if (info.kind === "block") {
          draftController.clearDraftConsumed();
          draftController.advanceDraftBlockBoundary({ fallbackToLatestEnd: true });
          draftStream.reset();
          draftController.resetReplyToIdForNextBlock();
          draftController.updateDraftFromLatestFullText();

          // Re-assert typing so the user still sees the indicator while
          // the next block generates.
          const { sendTypingMatrix } = await loadMatrixSendModule();
          await sendTypingMatrix(roomId, true, undefined, client).catch(() => {});
        }
      } else {
        await deliverMatrixReplies({
          cfg,
          replies: [payload],
          roomId,
          client,
          runtime,
          textLimit,
          replyToMode,
          threadId: threadTarget,
          replyToId: threadTarget ?? replyToEventId ?? undefined,
          accountId,
          mediaLocalRoots,
          tableMode,
        });
      }
    },
    onError: (err: unknown, info: { kind: "tool" | "block" | "final" }) => {
      if (info.kind === "final") {
        finalReplyDeliveryFailed = true;
      } else {
        nonFinalReplyDeliveryFailed = true;
      }
      if (info.kind === "block") {
        draftController.advanceDraftBlockBoundary({ fallbackToLatestEnd: true });
      }
      runtime.error?.(`matrix ${info.kind} reply failed: ${String(err)}`);
    },
    onReplyStart: typingCallbacks.onReplyStart,
    onIdle: typingCallbacks.onIdle,
  };
  const {
    deliver: deliverReply,
    onError: onReplyError,
    ...turnDispatcherOptions
  } = dispatcherOptions;

  return {
    deliverReply,
    onReplyError,
    turnDispatcherOptions,
    finalReplyDeliveryFailed: () => finalReplyDeliveryFailed,
    nonFinalReplyDeliveryFailed: () => nonFinalReplyDeliveryFailed,
  };
}
