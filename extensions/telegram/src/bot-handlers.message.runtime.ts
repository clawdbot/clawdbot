// Telegram message/session/prompt pipeline shared by bot handler registrars.
import type { Message } from "grammy/types";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { evaluateSupplementalContextVisibility } from "openclaw/plugin-sdk/security-runtime";
import { expandTelegramAllowFromWithAccessGroups } from "./access-groups.js";
import { resolveTelegramAccount, resolveTelegramMediaRuntimeOptions } from "./accounts.js";
import { firstDefined, isSenderAllowed, normalizeAllowFrom } from "./bot-access.js";
import { hasInboundMedia, resolveInboundMediaFileId } from "./bot-handlers.media.js";
import {
  createTelegramMessageContextRuntime,
  type TelegramPromptContextMessageSelection,
} from "./bot-handlers.message-context.runtime.js";
import { createTelegramMessageLifecycleRuntime } from "./bot-handlers.message-lifecycle.runtime.js";
import { createTelegramMessageSessionRuntime } from "./bot-handlers.message-session.runtime.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type { TelegramMessageContextOptions } from "./bot-message-context.types.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  createTelegramSpooledReplayDeferredParticipant,
  createTelegramSpooledReplayParticipant,
  getTelegramSpooledReplayDeferredParticipant,
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
  type TelegramMessageProcessingResult,
  type TelegramSpooledReplayDeferredParticipant,
} from "./bot-processing-outcome.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import { resolveTelegramForumThreadId } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import type { TelegramCachedMessageNode, TelegramReplyChainEntry } from "./message-cache.js";
import type { TelegramMessageDispatchReplayClaim } from "./message-dispatch-dedupe.js";
import { resolveTelegramPromptMediaPath } from "./prompt-media-path.js";

export function createTelegramHandlerMessageRuntime({
  cfg,
  accountId,
  bot,
  opts,
  telegramTransport,
  runtime,
  mediaMaxBytes,
  telegramCfg,
  resolveTelegramGroupConfig,
  processMessage,
  logger,
  telegramDeps,
}: RegisterTelegramHandlerParams) {
  const { token } = opts;
  const mediaRuntimeOptions = resolveTelegramMediaRuntimeOptions({
    cfg,
    accountId,
    token,
    transport: telegramTransport,
  });
  const mediaAbortSignal =
    opts.mediaAbortSignal && opts.fetchAbortSignal
      ? AbortSignal.any([opts.mediaAbortSignal, opts.fetchAbortSignal])
      : (opts.mediaAbortSignal ?? opts.fetchAbortSignal);
  const mediaRuntimeWithAbort = {
    ...mediaRuntimeOptions,
    abortSignal: mediaAbortSignal,
  };
  const sessionRuntime = createTelegramMessageSessionRuntime({
    accountId,
    resolveTelegramGroupConfig,
    telegramDeps,
  });
  const { resolveTelegramSessionState, resolvePromptContextAmbientWatermark } = sessionRuntime;
  const {
    recordMessageForReplyChain,
    buildReplyChainForMessage,
    toReplyChainEntry,
    buildPromptContextForMessage,
  } = createTelegramMessageContextRuntime({
    cfg,
    accountId,
    opts,
    telegramCfg,
    telegramDeps,
  });
  const {
    normalizePromptContextMinTimestampMs,
    promptContextBoundaryOptions,
    latestPromptContextMinTimestampMs,
    latestPromptContextAmbientWatermark,
    mergeDispatchDedupeClaims,
    releaseDispatchDedupeClaims,
    commitDispatchDedupeClaims,
    buildFailedProcessingResult,
    settleSpooledReplayParticipants,
    beginSpooledReplaySettlementHolds,
    createSpooledReplayParticipantForBufferedWork,
    spooledReplayOptions,
    claimMessageDispatchDedupe,
    buildSyntheticTextMessage,
    buildSyntheticContext,
    formatTelegramAmbientTranscriptBody,
  } = createTelegramMessageLifecycleRuntime({ accountId, runtime });

  const resolveReplyMediaForChain = async (
    ctx: TelegramContext,
    chain: TelegramCachedMessageNode[],
    shouldHydrateMedia: (node: TelegramCachedMessageNode, index: number) => Promise<boolean>,
    durableMediaReplay: boolean,
  ): Promise<{ replyMedia: TelegramMediaRef[]; replyChain: TelegramReplyChainEntry[] }> => {
    const replyMedia: TelegramMediaRef[] = [];
    const replyChain: TelegramReplyChainEntry[] = [];
    for (const [index, node] of chain.entries()) {
      let mediaRef: TelegramMediaRef | undefined;
      const replyFileId = resolveInboundMediaFileId(node.sourceMessage);
      if (
        replyFileId &&
        hasInboundMedia(node.sourceMessage) &&
        (await shouldHydrateMedia(node, index))
      ) {
        try {
          const media = await resolveMedia({
            ctx: {
              message: node.sourceMessage,
              me: ctx.me,
              getFile: async (signal) => await bot.api.getFile(replyFileId, signal),
            },
            maxBytes: mediaMaxBytes,
            ...mediaRuntimeWithAbort,
          });
          mediaRef = media
            ? {
                path: media.path,
                kind: media.kind,
                ...(media.contentType ? { contentType: media.contentType } : {}),
                ...(media.stickerMetadata ? { stickerMetadata: media.stickerMetadata } : {}),
              }
            : undefined;
        } catch (err) {
          // Only durable ingress can replay a reply-media abort. Live polling must
          // preserve the current text instead of acknowledging it without dispatch.
          if (mediaRuntimeWithAbort.abortSignal?.aborted && durableMediaReplay) {
            recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: err });
            throw err;
          }
          logger.warn(
            { chatId: ctx.message.chat.id, error: String(err) },
            "reply media fetch failed",
          );
        }
      }
      if (mediaRef) {
        replyMedia.push(mediaRef);
      }
      replyChain.push(toReplyChainEntry(node, ctx, mediaRef));
    }
    return { replyMedia, replyChain };
  };

  const processMessageWithReplyChain = async (params: {
    ctx: TelegramContext;
    msg: Message;
    allMedia: TelegramMediaRef[];
    promptContextMessageSelection?: TelegramPromptContextMessageSelection;
    storeAllowFrom: string[];
    options?: TelegramMessageContextOptions;
    dispatchDedupeClaims?: TelegramMessageDispatchReplayClaim[];
    spooledReplayParticipants?: readonly TelegramSpooledReplayDeferredParticipant[];
    spooledReplayAbortSignal?: AbortSignal;
  }): Promise<TelegramMessageProcessingResult> => {
    let dispatchDedupeCommitted = false;
    let spooledReplayFinalResult: TelegramMessageProcessingResult | undefined;
    let spooledReplayFinalization: Promise<TelegramMessageProcessingResult> | undefined;
    // Callback-submit retries also set options.spooledReplay without durable ingress.
    // Media aborts retry only when the update frame or a buffered participant owns replay.
    const durableMediaReplay =
      isTelegramSpooledReplayUpdate(params.ctx.update) ||
      Boolean(params.spooledReplayParticipants?.length);
    const spooledReplay = params.options?.spooledReplay === true || durableMediaReplay;
    const explicitParticipants = params.spooledReplayParticipants ?? [];
    const frameParticipant =
      spooledReplay &&
      explicitParticipants.length === 0 &&
      params.options?.isolateSpooledReplaySettlement !== true
        ? (getTelegramSpooledReplayDeferredParticipant() ??
          createTelegramSpooledReplayDeferredParticipant(
            `message:${params.msg.chat.id}:${params.msg.message_id}`,
          ) ??
          undefined)
        : undefined;
    const ingressSpooledReplayParticipants = [
      ...explicitParticipants,
      ...(frameParticipant ? [frameParticipant] : []),
    ];
    const processingParticipant =
      explicitParticipants.length > 0
        ? createTelegramSpooledReplayParticipant(
            `message-processing:${params.msg.chat.id}:${params.msg.message_id}`,
          )
        : frameParticipant;
    if (processingParticipant && explicitParticipants.length > 0) {
      for (const participant of explicitParticipants) {
        void participant.task.then((result) => {
          processingParticipant.settle(result);
        });
      }
    }
    const spooledReplayParticipants = [
      ...new Set([
        ...ingressSpooledReplayParticipants,
        ...(processingParticipant ? [processingParticipant] : []),
      ]),
    ];
    const finalizeSpooledReplayResult = async (
      result: TelegramMessageProcessingResult,
    ): Promise<TelegramMessageProcessingResult> => {
      if (spooledReplayFinalResult) {
        return spooledReplayFinalResult;
      }
      if (spooledReplayFinalization) {
        return await spooledReplayFinalization;
      }
      const finalization = (async () => {
        const finalized = result;
        if (result.kind === "completed") {
          // Do not cache or settle a durable-adoption failure. Deferred queue
          // ownership retries this callback with the same spool participants.
          const releaseSettlementHolds = beginSpooledReplaySettlementHolds(
            ingressSpooledReplayParticipants,
          );
          try {
            await commitDispatchDedupeClaims(params.dispatchDedupeClaims ?? [], {
              requirePersistent: true,
            });
          } catch (error) {
            releaseSettlementHolds("replay-pending");
            throw error;
          }
          releaseSettlementHolds("discard-pending");
          dispatchDedupeCommitted = true;
        } else {
          releaseDispatchDedupeClaims(
            params.dispatchDedupeClaims ?? [],
            result.kind === "failed-retryable" ? result.error : undefined,
          );
        }
        spooledReplayFinalResult = finalized;
        settleSpooledReplayParticipants(spooledReplayParticipants, finalized);
        return finalized;
      })();
      spooledReplayFinalization = finalization;
      try {
        return await finalization;
      } finally {
        if (!spooledReplayFinalResult && spooledReplayFinalization === finalization) {
          spooledReplayFinalization = undefined;
        }
      }
    };
    try {
      // One assembled turn owns one config identity. Reloading below this point
      // can validate a model pin against a different allowlist than dispatch uses.
      const runtimeCfg = telegramDeps.getRuntimeConfig();
      const runtimeTelegramCfg = resolveTelegramAccount({ cfg: runtimeCfg, accountId }).config;
      const replyChainNodes = await buildReplyChainForMessage(params.msg);
      const isGroupConversation =
        params.msg.chat.type === "group" || params.msg.chat.type === "supergroup";
      const isForum =
        params.msg.chat.type === "supergroup" &&
        Boolean(params.msg.chat.is_forum || params.msg.is_topic_message);
      const scopedThreadId = resolveTelegramForumThreadId({
        isForum,
        messageThreadId: params.msg.message_thread_id,
      });
      const { groupConfig, topicConfig } = resolveTelegramScopedGroupConfig(
        runtimeTelegramCfg,
        params.msg.chat.id,
        scopedThreadId,
      );
      const scopedAllowFrom = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
      const configuredGroupAllowFrom =
        scopedAllowFrom ??
        opts.groupAllowFrom ??
        runtimeTelegramCfg.groupAllowFrom ??
        runtimeTelegramCfg.allowFrom ??
        opts.allowFrom;
      const contextVisibilityMode = resolveChannelContextVisibilityMode({
        cfg: runtimeCfg,
        channel: "telegram",
        accountId,
      });
      const shouldHydrateReplyMedia = async (
        node: TelegramCachedMessageNode,
        index: number,
      ): Promise<boolean> => {
        if (!isGroupConversation) {
          return true;
        }
        const expandedAllowFrom = await expandTelegramAllowFromWithAccessGroups({
          cfg: runtimeCfg,
          allowFrom: configuredGroupAllowFrom,
          accountId,
          senderId: node.senderId,
        });
        const effectiveAllow = normalizeAllowFrom(expandedAllowFrom);
        const senderAllowed = effectiveAllow.hasEntries
          ? isSenderAllowed({
              allow: effectiveAllow,
              senderId: node.senderId,
              senderUsername: node.senderUsername,
            })
          : true;
        return evaluateSupplementalContextVisibility({
          mode: contextVisibilityMode,
          kind: index === 0 ? "quote" : "thread",
          senderAllowed,
        }).include;
      };
      const { replyMedia, replyChain } = await resolveReplyMediaForChain(
        params.ctx,
        replyChainNodes,
        shouldHydrateReplyMedia,
        durableMediaReplay,
      );
      const promptContextMediaByMessageId = new Map<string, TelegramMediaRef>();
      const currentMessageId =
        typeof params.msg.message_id === "number" ? String(params.msg.message_id) : undefined;
      for (const [index, media] of params.allMedia.entries()) {
        const messageId = media.sourceMessageId ?? (index === 0 ? currentMessageId : undefined);
        const promptMediaPath = media.path ? resolveTelegramPromptMediaPath(media.path) : undefined;
        if (messageId && promptMediaPath) {
          promptContextMediaByMessageId.set(messageId, {
            ...media,
            path: promptMediaPath,
          });
        }
      }
      for (const entry of replyChain) {
        const promptMediaPath = entry.mediaPath
          ? resolveTelegramPromptMediaPath(entry.mediaPath)
          : undefined;
        // Stored kinds are typed non-unknown; MIME inference fills gaps and
        // collapses an "unknown" inference to document for this deliverable-only surface.
        const inferredKind = kindFromMime(entry.mediaType);
        const mediaKind =
          entry.mediaKind ??
          (inferredKind && inferredKind !== "unknown" ? inferredKind : "document");
        if (entry.messageId && entry.mediaPath && promptMediaPath) {
          promptContextMediaByMessageId.set(entry.messageId, {
            path: promptMediaPath,
            kind: mediaKind,
            ...(entry.mediaType ? { contentType: entry.mediaType } : {}),
          });
        }
      }
      const promptContext = await buildPromptContextForMessage(
        params.ctx,
        params.msg,
        replyChainNodes,
        runtimeCfg,
        runtimeTelegramCfg,
        params.options,
        promptContextMediaByMessageId,
        params.promptContextMessageSelection,
      );
      const result = await processMessage(
        params.ctx,
        params.allMedia,
        params.storeAllowFrom,
        {
          cfg: runtimeCfg,
          telegramCfg: runtimeTelegramCfg,
          onDispatchStart: async () => {
            await commitDispatchDedupeClaims(params.dispatchDedupeClaims ?? []);
            dispatchDedupeCommitted = true;
          },
          spooledReplayAbortSignal: params.spooledReplayAbortSignal,
          spooledReplayParticipant: processingParticipant,
          finalizeSpooledReplayResult: async (processingResult) =>
            await finalizeSpooledReplayResult(processingResult),
          completeSpooledReplayAfterIrrevocableAdoption: async () => {
            const completed = { kind: "completed" } satisfies TelegramMessageProcessingResult;
            return await finalizeSpooledReplayResult(completed);
          },
        },
        params.options,
        replyMedia,
        replyChain,
        promptContext,
      );
      if (spooledReplay) {
        return await finalizeSpooledReplayResult(result);
      }
      if (result.kind === "completed" && !dispatchDedupeCommitted) {
        await commitDispatchDedupeClaims(params.dispatchDedupeClaims ?? []);
      } else if (result.kind !== "completed" && !dispatchDedupeCommitted) {
        releaseDispatchDedupeClaims(params.dispatchDedupeClaims ?? []);
      }
      return result;
    } catch (err) {
      if (spooledReplay) {
        return await finalizeSpooledReplayResult(buildFailedProcessingResult(err));
      }
      if (!dispatchDedupeCommitted) {
        releaseDispatchDedupeClaims(params.dispatchDedupeClaims ?? [], err);
      }
      throw err;
    }
  };

  return {
    mediaRuntimeWithAbort,
    normalizePromptContextMinTimestampMs,
    promptContextBoundaryOptions,
    latestPromptContextMinTimestampMs,
    latestPromptContextAmbientWatermark,
    mergeDispatchDedupeClaims,
    releaseDispatchDedupeClaims,
    buildFailedProcessingResult,
    settleSpooledReplayParticipants,
    createSpooledReplayParticipantForBufferedWork,
    spooledReplayOptions,
    claimMessageDispatchDedupe,
    buildSyntheticTextMessage,
    buildSyntheticContext,
    formatTelegramAmbientTranscriptBody,
    resolveTelegramSessionState,
    resolvePromptContextAmbientWatermark,
    recordMessageForReplyChain,
    processMessageWithReplyChain,
  };
}

export type TelegramHandlerMessageRuntime = ReturnType<typeof createTelegramHandlerMessageRuntime>;
