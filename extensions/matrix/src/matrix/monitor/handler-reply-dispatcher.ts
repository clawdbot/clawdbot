import {
  createPreviewMessageReceipt,
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  resolveSendableOutboundReplyParts,
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
import {
  deliverMatrixReplies,
  mergeMatrixReplyDeliveryResults,
  toMatrixPartialDeliveryError,
  type MatrixReplyDeliveryResult,
} from "./replies.js";
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
  replyToMode: ReplyToMode;
  threadTarget?: string;
  replyToEventId?: string;
  accountId: string;
  mediaLocalRoots: readonly string[];
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
    replyToMode,
    threadTarget,
    replyToEventId,
    accountId,
    mediaLocalRoots,
    logVerboseMessage,
  } = config;
  const quietDraftStreaming = streaming === "quiet" || streaming === "progress";
  // Tool, block, and final payloads are delivered separately but share one first-reply slot.
  const hasRepliedRef = { value: false };
  let finalReplyDeliveryFailed = false;
  let nonFinalReplyDeliveryFailed = false;
  const beginNextBlockDraft = () => {
    // Each block owns a new draft generation; prior retained/consumed state must not
    // suppress settlement or cleanup for the next provider-visible event.
    draftController.beginDraftGeneration();
    draftController.advanceDraftBlockBoundary({ fallbackToLatestEnd: true });
    draftStream?.reset();
    draftController.resetReplyToIdForNextBlock();
    draftController.updateDraftFromLatestFullText();
  };

  const dispatcherOptions = {
    ...prefixOptions,
    humanDelay,
    deliver: async (payload: ReplyPayload, info: { kind: string }) => {
      const completeDelivery = async (
        result: MatrixReplyDeliveryResult,
      ): Promise<MatrixReplyDeliveryResult> => {
        if (info.kind === "block") {
          beginNextBlockDraft();

          // Re-assert typing so the user still sees the indicator while
          // the next block generates.
          await typingCallbacks.onReplyStart();
        }
        return result;
      };
      const createDraftReceipt = (id: string): MessageReceipt =>
        createPreviewMessageReceipt({
          id,
          ...(threadTarget ? { threadId: threadTarget } : {}),
          ...(draftController.currentReplyToId()
            ? { replyToId: draftController.currentReplyToId() }
            : {}),
        });
      const createDraftDeliveryResult = (
        id: string,
        content: string,
      ): MatrixReplyDeliveryResult => {
        const receipt = createDraftReceipt(id);
        return {
          messageIds: receipt.platformMessageIds,
          receipt,
          visibleReplySent: true,
          content,
        };
      };
      const settleDraftReplacement = async (params: {
        draftEventId: string;
        draftContent: string;
        deliver: () => Promise<MatrixReplyDeliveryResult>;
      }): Promise<MatrixReplyDeliveryResult> => {
        const draftDelivery = createDraftDeliveryResult(params.draftEventId, params.draftContent);
        let replacement: MatrixReplyDeliveryResult;
        try {
          replacement = await params.deliver();
        } catch (error: unknown) {
          draftController.markDraftRetained();
          throw toMatrixPartialDeliveryError(error, [draftDelivery]);
        }
        if (!replacement.visibleReplySent) {
          draftController.markDraftRetained();
          return draftDelivery;
        }
        const draftRedacted = await redactMatrixDraftEvent(client, roomId, params.draftEventId);
        if (!draftRedacted) {
          draftController.markDraftRetained();
          return mergeMatrixReplyDeliveryResults([draftDelivery, replacement]);
        }
        draftController.markDraftConsumed();
        return replacement;
      };
      if (draftStream && info.kind !== "tool" && !payload.isCompactionNotice) {
        const { hasMedia } = resolveSendableOutboundReplyParts(payload);
        const ttsSupplement = getReplyPayloadTtsSupplement(payload);
        const fallbackPayload =
          ttsSupplement &&
          ttsSupplement.visibleTextAlreadyDelivered !== true &&
          !payload.text?.trim()
            ? { ...payload, text: ttsSupplement.spokenText }
            : payload;

        if (draftController.draftDisposition() !== "active") {
          await draftStream.discardPending();
          return await completeDelivery(
            await deliverMatrixReplies({
              cfg,
              replies: [fallbackPayload],
              roomId,
              client,
              runtime,
              replyToMode,
              hasRepliedRef,
              threadId: threadTarget,
              replyToId: threadTarget ?? replyToEventId ?? undefined,
              accountId,
              mediaLocalRoots,
            }),
          );
        }

        const payloadReplyMismatch =
          !threadTarget &&
          (replyToMode !== "off" || payload.replyToTag || payload.replyToCurrent) &&
          normalizeOptionalString(payload.replyToId) !== draftController.currentReplyToId();
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
          const { prepareMatrixSingleText } = await loadMatrixSendModule();
          const preparedFinalPreviewContent = prepareMatrixSingleText(finalPreviewText, {
            cfg,
            accountId,
            preserveWhitespace: true,
          }).convertedText;
          let finalizedDraftContent = draftStream.content() ?? preparedFinalPreviewContent;
          let fallbackResult: MatrixReplyDeliveryResult | undefined;
          const previewResult = await deliverWithFinalizableLivePreviewAdapter<
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
                  finalizedDraftContent = draftStream.content() ?? preparedFinalPreviewContent;
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
                finalizedDraftContent = prepareMatrixSingleText(edit.text, {
                  cfg,
                  accountId,
                  preserveWhitespace: true,
                }).convertedText;
              },
              createPreviewReceipt: createDraftReceipt,
              logPreviewEditFailure: (err) => {
                logVerboseMessage(`matrix: preview final edit failed: ${String(err)}`);
              },
            }),
            deliverNormally: async () => {
              fallbackResult = await settleDraftReplacement({
                draftEventId,
                draftContent: draftStream.content() ?? preparedFinalPreviewContent,
                deliver: async () =>
                  await deliverMatrixReplies({
                    cfg,
                    replies: [fallbackPayload],
                    roomId,
                    client,
                    runtime,
                    replyToMode,
                    hasRepliedRef,
                    threadId: threadTarget,
                    replyToId: threadTarget ?? replyToEventId ?? undefined,
                    accountId,
                    mediaLocalRoots,
                  }),
              });
              return fallbackResult.visibleReplySent;
            },
          });
          if (previewResult.kind === "preview-finalized") {
            draftController.markDraftConsumed();
          }
          const settledResult =
            previewResult.kind === "preview-finalized" && previewResult.liveState?.receipt
              ? createDraftDeliveryResult(
                  draftEventId,
                  finalizedDraftContent ?? preparedFinalPreviewContent,
                )
              : (fallbackResult ?? mergeMatrixReplyDeliveryResults([]));
          return await completeDelivery(settledResult);
        } else if (draftEventId && hasMedia && !payloadReplyMismatch) {
          let textEditOk = !mustDeliverFinalNormally;
          const payloadText = payload.text ?? ttsSupplement?.spokenText;
          const preparedPayloadContent =
            typeof payloadText === "string"
              ? (await loadMatrixSendModule()).prepareMatrixSingleText(payloadText, {
                  cfg,
                  accountId,
                  preserveWhitespace: true,
                }).convertedText
              : undefined;
          let finalizedDraftContent = draftStream.content() ?? preparedPayloadContent;
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
            const { editMessageMatrix, prepareMatrixSingleText } = await loadMatrixSendModule();
            textEditOk = await editMessageMatrix(roomId, draftEventId, payloadText, {
              client,
              cfg,
              threadId: threadTarget,
              accountId,
              extraContent: quietDraftStreaming ? buildMatrixFinalizedPreviewContent() : undefined,
            }).then(
              () => {
                finalizedDraftContent = prepareMatrixSingleText(payloadText, {
                  cfg,
                  accountId,
                  preserveWhitespace: true,
                }).convertedText;
                return true;
              },
              () => false,
            );
          } else if (textEditOk && reusesDraftTextUnchanged) {
            textEditOk = await draftStream.finalizeLive();
            finalizedDraftContent = draftStream.content();
          }
          const reusesDraftAsFinalText = Boolean(payloadText?.trim()) && textEditOk;
          const draftContent = draftStream.content();
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
          const providerDraftContent = finalizedDraftContent ?? preparedPayloadContent;
          const previewDelivery =
            reusesDraftAsFinalText && providerDraftContent
              ? createDraftDeliveryResult(draftEventId, providerDraftContent)
              : draftContent
                ? createDraftDeliveryResult(draftEventId, draftContent)
                : mergeMatrixReplyDeliveryResults([]);
          const deliverMedia = async () =>
            await deliverMatrixReplies({
              cfg,
              replies: [mediaPayload],
              roomId,
              client,
              runtime,
              replyToMode,
              hasRepliedRef,
              threadId: threadTarget,
              replyToId: threadTarget ?? replyToEventId ?? undefined,
              accountId,
              mediaLocalRoots,
            });
          if (reusesDraftAsFinalText) {
            draftController.markDraftConsumed();
            let mediaDelivery: MatrixReplyDeliveryResult;
            try {
              mediaDelivery = await deliverMedia();
            } catch (error: unknown) {
              throw toMatrixPartialDeliveryError(error, [previewDelivery]);
            }
            return await completeDelivery(
              mergeMatrixReplyDeliveryResults([previewDelivery, mediaDelivery]),
            );
          }
          if (draftContent) {
            return await completeDelivery(
              await settleDraftReplacement({
                draftEventId,
                draftContent,
                deliver: deliverMedia,
              }),
            );
          }
          return await completeDelivery(await deliverMedia());
        }
        const shouldRedactDraft =
          Boolean(draftEventId) &&
          (payload.isError ||
            payloadReplyMismatch ||
            mustDeliverFinalNormally ||
            draftFinalTextNeedsNormalMentionDelivery);
        const deliverFallback = async () =>
          await deliverMatrixReplies({
            cfg,
            replies: [fallbackPayload],
            roomId,
            client,
            runtime,
            replyToMode,
            hasRepliedRef,
            threadId: threadTarget,
            replyToId: threadTarget ?? replyToEventId ?? undefined,
            accountId,
            mediaLocalRoots,
          });
        const draftContent = draftStream.content();
        if (shouldRedactDraft && draftEventId && draftContent) {
          return await completeDelivery(
            await settleDraftReplacement({
              draftEventId,
              draftContent,
              deliver: deliverFallback,
            }),
          );
        }
        return await completeDelivery(await deliverFallback());
      }
      return await completeDelivery(
        await deliverMatrixReplies({
          cfg,
          replies: [payload],
          roomId,
          client,
          runtime,
          replyToMode,
          hasRepliedRef,
          threadId: threadTarget,
          replyToId: threadTarget ?? replyToEventId ?? undefined,
          accountId,
          mediaLocalRoots,
        }),
      );
    },
    onError: (err: unknown, info: { kind: "tool" | "block" | "final" }) => {
      if (info.kind === "final") {
        finalReplyDeliveryFailed = true;
      } else {
        nonFinalReplyDeliveryFailed = true;
      }
      if (info.kind === "block") {
        beginNextBlockDraft();
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
