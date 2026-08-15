import type { Message } from "grammy/types";
import {
  buildMentionRegexes,
  implicitMentionKindWhen,
  matchesMentionWithExplicit,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import type {
  OpenClawConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { danger, warn } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { firstDefined, type NormalizedAllowFrom } from "./bot-access.js";
import {
  hasInboundMedia,
  isDurablyRetryableInboundMediaError,
  isRecoverableMediaGroupError,
} from "./bot-handlers.media.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type {
  TelegramAmbientTranscriptWatermark,
  TelegramChannelIngressResolver,
} from "./bot-message-context.types.js";
import type { TelegramSpooledReplayDeferredParticipant } from "./bot-processing-outcome.js";
import { MEDIA_GROUP_TIMEOUT_MS, type MediaGroupEntry } from "./bot-updates.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import {
  buildTelegramGroupPeerId,
  buildTelegramThreadParams,
  getTelegramTextParts,
  hasBotMention,
  resolveTelegramMessageThreadSpec,
  resolveTelegramPrimaryMedia,
} from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { isTelegramForumServiceMessage } from "./forum-service-message.js";
import { resolveTelegramGroupIngestEnabled } from "./group-config-helpers.js";
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";
import type { TelegramMessageDispatchReplayClaim } from "./message-dispatch-dedupe.js";

type MediaAuthorization = {
  authorizationCfg: OpenClawConfig;
  chatId: number;
  isGroup: boolean;
  isForum: boolean;
  resolvedThreadId?: number;
  dmThreadId?: number;
  senderId: string;
  effectiveGroupAllow: NormalizedAllowFrom;
  effectiveDmAllow: NormalizedAllowFrom;
  groupConfig?: TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
};

type TelegramMediaGroupInput = MediaAuthorization & {
  ctx: TelegramContext;
  msg: Message;
  storeAllowFrom: string[];
  promptContextMinTimestampMs?: number;
  promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
  dispatchDedupeClaims: TelegramMessageDispatchReplayClaim[];
  channelIngressResolvers: readonly TelegramChannelIngressResolver[];
};

type BufferedMediaGroupEntry = MediaGroupEntry &
  Omit<TelegramMediaGroupInput, "ctx" | "msg"> & {
    spooledReplayParticipants: TelegramSpooledReplayDeferredParticipant[];
  };

type TelegramGroupMediaDisposition = "process" | "skip" | "silent-ingest";

interface TelegramInboundMedia {
  handleMediaGroup: (input: TelegramMediaGroupInput) => boolean;
  resolveUnaddressedGroupMediaDisposition: (
    authorization: MediaAuthorization & { ctx: TelegramContext; msg: Message },
  ) => Promise<TelegramGroupMediaDisposition>;
}

export function createTelegramInboundMedia({
  params,
  message,
}: {
  params: Pick<
    RegisterTelegramHandlerParams,
    | "accountId"
    | "bot"
    | "opts"
    | "runtime"
    | "mediaMaxBytes"
    | "logger"
    | "resolveGroupActivation"
    | "resolveGroupRequireMention"
  >;
  message: TelegramMessagePipeline;
}): TelegramInboundMedia {
  const {
    accountId,
    bot,
    opts,
    runtime,
    mediaMaxBytes,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
  } = params;
  const {
    resolveMediaRuntime,
    recordMessageResolvedMedia,
    promptContextBoundaryOptions,
    latestPromptContextMinTimestampMs,
    latestPromptContextAmbientWatermark,
    mergeDispatchDedupeClaims,
    releaseDispatchDedupeClaims,
    buildFailedProcessingResult,
    settleSpooledReplayParticipants,
    createSpooledReplayParticipantForBufferedWork,
    spooledReplayOptions,
    resolveTelegramSessionState,
    processMessageWithReplyChain,
  } = message;
  const timeoutMs =
    typeof opts.testTimings?.mediaGroupFlushMs === "number" &&
    Number.isFinite(opts.testTimings.mediaGroupFlushMs)
      ? Math.max(10, Math.floor(opts.testTimings.mediaGroupFlushMs))
      : MEDIA_GROUP_TIMEOUT_MS;
  const buffer = new Map<string, BufferedMediaGroupEntry>();
  const queue = new KeyedAsyncQueue();

  const resolveUnaddressedGroupMediaDisposition = async (
    authorization: MediaAuthorization & { ctx: TelegramContext; msg: Message },
  ): Promise<TelegramGroupMediaDisposition> => {
    const { ctx, msg, chatId, isGroup, isForum, resolvedThreadId, dmThreadId, senderId } =
      authorization;
    const textParts = getTelegramTextParts(msg);
    const documentMime = msg.document?.mime_type?.split(";")[0]?.trim().toLowerCase();
    const mayNeedDownload =
      !textParts.text.trim() &&
      Boolean(msg.audio ?? msg.voice ?? documentMime?.startsWith("audio/"));
    // Media-less messages have nothing to skip-download. They must reach the
    // canonical mention gate (bot-message-context.body), which records group
    // history, fires ingest hooks, and settles an explicit skipped result;
    // consuming them here tombstones the ingress row without any trace.
    if (!isGroup || !hasInboundMedia(msg) || mayNeedDownload) {
      return "process";
    }
    const sessionState = resolveTelegramSessionState({
      chatId,
      isGroup,
      isForum,
      resolvedThreadId,
      messageThreadId: resolvedThreadId ?? dmThreadId,
      senderId,
      runtimeCfg: authorization.authorizationCfg,
    });
    const activationOverride = resolveGroupActivation({
      chatId,
      messageThreadId: resolvedThreadId,
      sessionKey: sessionState.sessionKey,
      agentId: sessionState.agentId,
      cfg: authorization.authorizationCfg,
    });
    const requireMention = firstDefined(
      authorization.topicConfig?.requireMention,
      activationOverride,
      authorization.groupConfig?.requireMention,
      resolveGroupRequireMention(chatId, authorization.authorizationCfg),
    );
    const botUsername = ctx.me?.username?.trim().toLowerCase();
    const hasControlCommandInMessage = hasControlCommand(
      textParts.text,
      authorization.authorizationCfg,
      { botUsername },
    );
    if (!requireMention && !hasControlCommandInMessage) {
      return "process";
    }
    const commandGate = await resolveTelegramCommandIngressAuthorization({
      accountId,
      cfg: authorization.authorizationCfg,
      dmPolicy: "pairing",
      isGroup,
      chatId,
      resolvedThreadId,
      senderId,
      effectiveDmAllow: authorization.effectiveDmAllow,
      effectiveGroupAllow: authorization.effectiveGroupAllow,
      ownerAccess: { ownerList: [], senderIsOwner: false },
      eventKind: "message",
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
      modeWhenAccessGroupsOff: "allow",
      includeDmAllowForGroupCommands: false,
    });
    // Command authorization protects both singleton and album downloads;
    // requiring a mention must never determine whether unauthorized media is fetched.
    if (commandGate.shouldBlockControlCommand) {
      logger.info(
        { chatId, reason: "unauthorized-control-command" },
        "skipping group command media before download",
      );
      return "skip";
    }
    if (!requireMention) {
      return "process";
    }
    const mentionRegexes = buildMentionRegexes(
      authorization.authorizationCfg,
      sessionState.agentId,
      {
        provider: "telegram",
        conversationId: buildTelegramGroupPeerId(chatId, resolvedThreadId),
        providerPolicy:
          authorization.authorizationCfg.channels?.telegram?.accounts?.[accountId]?.mentionPatterns,
      },
    );
    const hasAnyMention = textParts.entities.some((entity) => entity.type === "mention");
    const explicitlyMentioned = botUsername ? hasBotMention(msg, botUsername) : false;
    const wasMentioned = matchesMentionWithExplicit({
      text: textParts.text,
      mentionRegexes,
      explicit: {
        hasAnyMention,
        isExplicitlyMentioned: explicitlyMentioned,
        canResolveExplicit: Boolean(botUsername),
      },
    });
    const replyToBotMessage = ctx.me?.id != null && msg.reply_to_message?.from?.id === ctx.me.id;
    const implicitMentionKinds = implicitMentionKindWhen(
      "reply_to_bot",
      replyToBotMessage && !isTelegramForumServiceMessage(msg.reply_to_message),
    );
    const decision = resolveInboundMentionDecision({
      facts: {
        canDetectMention: Boolean(botUsername) || mentionRegexes.length > 0,
        wasMentioned,
        hasAnyMention,
        implicitMentionKinds,
      },
      policy: {
        isGroup,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: hasControlCommandInMessage,
        commandAuthorized: commandGate.authorized,
      },
    });
    if (decision.shouldSkip) {
      if (
        resolveTelegramGroupIngestEnabled({
          cfg: authorization.authorizationCfg,
          chatId,
          accountId,
          topicConfig: authorization.topicConfig,
        })
      ) {
        return "silent-ingest";
      }
      logger.info({ chatId, reason: "no-mention" }, "skipping group media before download");
      return "skip";
    }
    return "process";
  };

  const processMediaGroup = async (entry: BufferedMediaGroupEntry) => {
    try {
      const finalIngressMessageId = entry.messages.at(-1)?.msg.message_id;
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
      let primary =
        entry.messages.find((item) => item.msg.caption || item.msg.text) ?? entry.messages[0];
      if (!primary) {
        releaseDispatchDedupeClaims(entry.dispatchDedupeClaims);
        settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
        return;
      }
      const captionParts = entry.messages
        .map(({ msg }) => getTelegramTextParts(msg))
        .filter(({ text }) => text.trim());
      if (captionParts.length > 1) {
        const botUsername = primary.ctx.me?.username;
        const commandCaptionIndex = captionParts.findIndex(({ text }) =>
          hasControlCommand(text, entry.authorizationCfg, {
            botUsername,
          }),
        );
        if (commandCaptionIndex > 0) {
          // Command detection is prefix-based in both ingress and canonical message processing.
          const [commandCaption] = captionParts.splice(commandCaptionIndex, 1);
          if (commandCaption) {
            captionParts.unshift(commandCaption);
          }
        }
        let caption = "";
        const captionEntities: NonNullable<Message["caption_entities"]> = [];
        for (const { text, entities } of captionParts) {
          if (caption) {
            caption += "\n";
          }
          const offset = caption.length;
          caption += text;
          for (const entity of entities) {
            captionEntities.push({ ...entity, offset: entity.offset + offset });
          }
        }
        const combinedMessage = {
          ...primary.msg,
          text: undefined,
          entities: undefined,
          caption,
          caption_entities: captionEntities.length ? captionEntities : undefined,
        } as Message;
        // Keep grammY context methods/getters while exposing the complete album to every owner.
        const combinedContext = Object.create(primary.ctx) as TelegramContext;
        Object.defineProperty(combinedContext, "message", {
          value: combinedMessage,
          enumerable: true,
        });
        primary = { ctx: combinedContext, msg: combinedMessage };
      }
      const mediaDisposition = await resolveUnaddressedGroupMediaDisposition({
        ...entry,
        ...primary,
      });
      if (mediaDisposition === "skip") {
        releaseDispatchDedupeClaims(entry.dispatchDedupeClaims);
        settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
        return;
      }
      const allMedia: TelegramMediaRef[] = [];
      const selection = new Map<string, "include" | "exclude">();
      const mediaRuntime = resolveMediaRuntime(
        ...entry.spooledReplayParticipants.map((participant) => participant.abortSignal),
      );
      let materializedCount = 0;
      let skippedCount = 0;
      for (const { ctx, msg } of entry.messages) {
        const sourceMessageId = String(msg.message_id);
        const nativeKind = resolveTelegramPrimaryMedia(msg)?.kind ?? "document";
        let media;
        try {
          media = await resolveMedia({ ctx, maxBytes: mediaMaxBytes, ...mediaRuntime });
        } catch (error) {
          if (
            entry.spooledReplayParticipants.length > 0 &&
            (mediaRuntime.abortSignal?.aborted || isDurablyRetryableInboundMediaError(error))
          ) {
            throw error;
          }
          if (!isRecoverableMediaGroupError(error)) {
            throw error;
          }
          // Classic polling cannot replay a failed album; retain its existing partial-delivery path.
          runtime.log?.(warn(`media group: skipping photo that failed to fetch: ${String(error)}`));
          allMedia.push({ kind: nativeKind, sourceMessageId });
          selection.set(sourceMessageId, "exclude");
          skippedCount++;
          continue;
        }
        if (media) {
          await recordMessageResolvedMedia({ msg, media, botUserId: ctx.me?.id });
          allMedia.push({
            path: media.path,
            contentType: media.contentType,
            kind: media.kind,
            stickerMetadata: media.stickerMetadata,
            sourceMessageId,
          });
          materializedCount++;
          selection.set(sourceMessageId, "include");
        } else {
          allMedia.push({ kind: nativeKind, sourceMessageId });
          selection.set(sourceMessageId, "exclude");
          skippedCount++;
        }
      }
      if (skippedCount > 0 && mediaDisposition !== "silent-ingest") {
        const verb = skippedCount === 1 ? "was" : "were";
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          runtime,
          fn: () =>
            bot.api.sendMessage(
              primary.msg.chat.id,
              `⚠️ Received ${materializedCount} of ${entry.messages.length} images — ${skippedCount} could not be fetched and ${verb} skipped.`,
              {
                ...buildTelegramThreadParams(
                  resolveTelegramMessageThreadSpec(primary.msg, entry.isForum),
                ),
                reply_parameters: {
                  message_id: primary.msg.message_id,
                  allow_sending_without_reply: true,
                },
              },
            ),
        }).catch(() => {});
      }
      const result = await processMessageWithReplyChain({
        ctx: primary.ctx,
        msg: primary.msg,
        allMedia,
        promptContextMessageSelection: selection,
        storeAllowFrom: entry.storeAllowFrom,
        options: {
          ...(finalIngressMessageId != null
            ? { messageIdOverride: String(finalIngressMessageId) }
            : {}),
          ...promptContextBoundaryOptions(
            entry.promptContextMinTimestampMs,
            entry.promptContextAmbientWatermark,
          ),
          ...spooledReplayOptions(entry.spooledReplayParticipants),
          channelIngressResolvers: entry.channelIngressResolvers,
        },
        dispatchDedupeClaims: entry.dispatchDedupeClaims,
        spooledReplayParticipants: entry.spooledReplayParticipants,
      });
      settleSpooledReplayParticipants(entry.spooledReplayParticipants, result);
    } catch (error) {
      releaseDispatchDedupeClaims(entry.dispatchDedupeClaims, error);
      settleSpooledReplayParticipants(
        entry.spooledReplayParticipants,
        buildFailedProcessingResult(error),
      );
      runtime.error?.(danger(`media group handler failed: ${String(error)}`));
    }
  };
  const queueEntry = (key: string, entry: BufferedMediaGroupEntry) =>
    void queue.enqueue(key, async () => {
      await processMediaGroup(entry).catch(() => undefined);
    });

  const handleMediaGroup = (input: TelegramMediaGroupInput): boolean => {
    const mediaGroupId = input.msg.media_group_id;
    if (!mediaGroupId) {
      return false;
    }
    const threadId = input.resolvedThreadId ?? input.dmThreadId;
    const key = `media:${input.chatId}:${threadId ?? "main"}:${mediaGroupId}`;
    const existing = buffer.get(key);
    const participant = createSpooledReplayParticipantForBufferedWork(
      `media-group:${key}:${input.msg.message_id}`,
    );
    if (existing) {
      if (participant) {
        existing.spooledReplayParticipants.push(participant);
      }
      clearTimeout(existing.timer);
      existing.messages.push({ msg: input.msg, ctx: input.ctx });
      existing.promptContextMinTimestampMs = latestPromptContextMinTimestampMs(
        existing.promptContextMinTimestampMs,
        input.promptContextMinTimestampMs,
      );
      existing.promptContextAmbientWatermark = latestPromptContextAmbientWatermark(
        existing.promptContextAmbientWatermark,
        input.promptContextAmbientWatermark,
      );
      existing.dispatchDedupeClaims = mergeDispatchDedupeClaims(
        existing.dispatchDedupeClaims,
        input.dispatchDedupeClaims,
      );
      // An album can span separately authorized updates; preserve each exact resolver once.
      existing.channelIngressResolvers = [
        ...existing.channelIngressResolvers,
        ...input.channelIngressResolvers,
      ];
      existing.timer = setTimeout(() => {
        buffer.delete(key);
        queueEntry(key, existing);
      }, timeoutMs);
      return true;
    }
    const entry: BufferedMediaGroupEntry = {
      ...input,
      messages: [{ msg: input.msg, ctx: input.ctx }],
      spooledReplayParticipants: participant ? [participant] : [],
      ...promptContextBoundaryOptions(
        input.promptContextMinTimestampMs,
        input.promptContextAmbientWatermark,
      ),
      timer: setTimeout(() => {
        buffer.delete(key);
        queueEntry(key, entry);
      }, timeoutMs),
    };
    buffer.set(key, entry);
    return true;
  };

  return { handleMediaGroup, resolveUnaddressedGroupMediaDisposition };
}
