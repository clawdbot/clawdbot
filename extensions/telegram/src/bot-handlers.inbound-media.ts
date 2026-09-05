import type { Message } from "grammy/types";
import {
  buildMentionRegexes,
  implicitMentionKindWhen,
  matchesMentionWithExplicit,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { danger, warn } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { firstDefined } from "./bot-access.js";
import { createTelegramMediaGroupRegistry } from "./bot-handlers.inbound-media-registry.js";
import {
  finalizeTelegramMediaGroupAfterProcessing,
  pauseTelegramMediaGroupRetention,
  resumeTelegramMediaGroupAfterDeniedIgnore,
} from "./bot-handlers.inbound-media-retention.js";
import { createTelegramPartialAlbumWarning } from "./bot-handlers.inbound-media-warning.js";
import type {
  BufferedMediaGroupEntry,
  MediaAuthorization,
  PendingMediaGroupIgnore,
  TelegramMediaGroupInput,
} from "./bot-handlers.inbound-media.types.js";
import {
  hasInboundMedia,
  isDurablyRetryableInboundMediaError,
  isRecoverableMediaGroupError,
} from "./bot-handlers.media.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import { MEDIA_GROUP_TIMEOUT_MS } from "./bot-updates.js";
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
import { resolveTelegramIgnoreDisposition, TELEGRAM_IGNORE_HELP_TEXT } from "./ignore-command.js";
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";

type TelegramGroupMediaDisposition = "process" | "skip" | "silent-ingest";

interface TelegramInboundMedia {
  handleMediaGroup: (input: TelegramMediaGroupInput) => boolean;
  beginPendingMediaGroupIgnore: (msg: Message) => PendingMediaGroupIgnore | undefined;
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
    | "removeMessageFromGroupHistory"
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
    removeMessageFromGroupHistory,
    resolveGroupActivation,
    resolveGroupRequireMention,
  } = params;
  const {
    resolveMediaRuntime,
    recordMessageResolvedMedia,
    recordMessageForReplyChain,
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
  const pendingAuthorizationsByIdentity = new Map<string, number>();
  const queue = new KeyedAsyncQueue();
  const {
    finalizeEntry,
    hasCancelledIdentity,
    markCancelledIdentity,
    purgeEntry,
    readActiveEntries,
    registerEntry,
    settleSkipped,
    stopCancelledEntry,
  } = createTelegramMediaGroupRegistry({
    ...message,
    removeMessageFromGroupHistory,
    timeoutMs,
  });

  const waitForPendingAuthorizations = async (entry: BufferedMediaGroupEntry) => {
    while (!entry.cancelled && (pendingAuthorizationsByIdentity.get(entry.identityKey) ?? 0) > 0) {
      await new Promise<void>((resolve) => {
        entry.pendingResolutionWaiters.add(resolve);
      });
    }
  };

  const resolveUnaddressedGroupMediaDisposition = async (
    authorization: MediaAuthorization & { ctx: TelegramContext; msg: Message },
  ): Promise<TelegramGroupMediaDisposition> => {
    const { ctx, msg, chatId, isGroup, senderId, threadSpec } = authorization;
    const resolvedThreadId =
      threadSpec.scope === "forum" || threadSpec.scope === "direct-messages"
        ? threadSpec.id
        : undefined;
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
      threadSpec,
      senderId,
      runtimeCfg: authorization.authorizationCfg,
    });
    const activationOverride = resolveGroupActivation({
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
    const botUsername = (ctx.me?.username ?? opts.botInfo?.username)?.trim().toLowerCase();
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
        conversationId: buildTelegramGroupPeerId(chatId, threadSpec),
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
      if (await stopCancelledEntry(entry)) {
        return;
      }
      const finalIngressMessageId = entry.messages.at(-1)?.msg.message_id;
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
      const ignored = entry.ignoreEnabled
        ? entry.messages.find(
            ({ ctx, msg }) =>
              resolveTelegramIgnoreDisposition(msg, ctx.me?.username ?? opts.botInfo?.username) !==
              "keep",
          )
        : undefined;
      if (ignored) {
        // Once an album itself carries /ignore, keep the identity tombstoned for the full quiet
        // window before any help-message await can let a late sibling recreate the album.
        markCancelledIdentity(entry.identityKey);
        entry.dispatchAdmission = "cancelled";
        entry.cancelled = true;
        entry.dispatchAbortController.abort("skipped");
        settleSkipped(entry);
        if (
          resolveTelegramIgnoreDisposition(
            ignored.msg,
            ignored.ctx.me?.username ?? opts.botInfo?.username,
          ) === "help"
        ) {
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () =>
              bot.api.sendMessage(ignored.msg.chat.id, TELEGRAM_IGNORE_HELP_TEXT, {
                ...buildTelegramThreadParams(entry.threadSpec),
                reply_parameters: {
                  message_id: ignored.msg.message_id,
                  allow_sending_without_reply: true,
                },
              }),
          }).catch(() => {});
        }
        return;
      }
      for (const { ctx, msg } of entry.messages) {
        await recordMessageForReplyChain(
          msg,
          resolveTelegramMessageThreadSpec(msg, entry.isForum),
          ctx.me?.id,
          ctx.me?.username ?? opts.botInfo?.username,
        );
        if (await stopCancelledEntry(entry)) {
          return;
        }
      }
      let primary =
        entry.messages.find((item) => item.msg.caption || item.msg.text) ?? entry.messages[0];
      if (!primary) {
        settleSkipped(entry);
        return;
      }
      const captionParts = entry.messages
        .map(({ msg }) => getTelegramTextParts(msg))
        .filter(({ text }) => text.trim());
      if (captionParts.length > 1) {
        const botUsername = primary.ctx.me?.username ?? opts.botInfo?.username;
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
      if (await stopCancelledEntry(entry)) {
        return;
      }
      if (mediaDisposition === "skip") {
        settleSkipped(entry);
        return;
      }
      const allMedia: TelegramMediaRef[] = [];
      const selection = new Map<string, "include" | "exclude">();
      const mediaRuntime = resolveMediaRuntime(
        entry.dispatchAbortController.signal,
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
          if (await stopCancelledEntry(entry)) {
            return;
          }
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
        }
        if (media) {
          await recordMessageResolvedMedia({ msg, media, botUserId: ctx.me?.id });
          if (await stopCancelledEntry(entry)) {
            return;
          }
          allMedia.push({
            path: media.path,
            contentType: media.contentType,
            ...(media.fileName ? { fileName: media.fileName } : {}),
            kind: media.kind,
            stickerMetadata: media.stickerMetadata,
            sourceMessageId,
          });
          materializedCount++;
          selection.set(sourceMessageId, "include");
        } else {
          allMedia.push({
            kind: nativeKind,
            sourceMessageId,
            unavailable: { reason: "download-failed" },
          });
          selection.set(sourceMessageId, "exclude");
          skippedCount++;
        }
      }
      await waitForPendingAuthorizations(entry);
      if (await stopCancelledEntry(entry)) {
        return;
      }
      const sendPartialAlbumWarning =
        skippedCount > 0 && mediaDisposition !== "silent-ingest"
          ? createTelegramPartialAlbumWarning({
              runtime,
              send: () =>
                bot.api.sendMessage(
                  primary.msg.chat.id,
                  `⚠️ Received ${materializedCount} of ${entry.messages.length} images — ${skippedCount} could not be fetched and ${skippedCount === 1 ? "was" : "were"} skipped.`,
                  {
                    ...buildTelegramThreadParams(entry.threadSpec),
                    reply_parameters: {
                      message_id: primary.msg.message_id,
                      allow_sending_without_reply: true,
                    },
                  },
                ),
            })
          : undefined;
      const result = await processMessageWithReplyChain({
        ctx: primary.ctx,
        msg: primary.msg,
        allMedia,
        promptContextMessageSelection: selection,
        storeAllowFrom: entry.storeAllowFrom,
        options: {
          threadSpec: entry.threadSpec,
          ...(finalIngressMessageId != null
            ? { messageIdOverride: String(finalIngressMessageId) }
            : {}),
          ...promptContextBoundaryOptions(
            entry.promptContextMinTimestampMs,
            entry.promptContextAmbientWatermark,
          ),
          ...spooledReplayOptions(entry.spooledReplayParticipants),
          bufferedMessages: entry.messages.map(({ msg }) => msg),
          channelIngressResolvers: entry.channelIngressResolvers,
        },
        dispatchDedupeClaims: entry.dispatchDedupeClaims,
        spooledReplayParticipants: entry.spooledReplayParticipants,
        shouldSkipBeforeDispatch: async () => {
          await waitForPendingAuthorizations(entry);
          return await stopCancelledEntry(entry);
        },
        dispatchAdmission: {
          abortSignal: entry.dispatchAbortController.signal,
          tryAdmit: () => {
            if (entry.dispatchAdmission === "pending") {
              entry.dispatchAdmission = "admitted";
            }
            return entry.dispatchAdmission === "admitted";
          },
          ...(sendPartialAlbumWarning ? { onAdmitted: sendPartialAlbumWarning } : {}),
        },
      });
      settleSpooledReplayParticipants(entry.spooledReplayParticipants, result);
    } catch (error) {
      if (entry.cancelled) {
        settleSkipped(entry);
        await purgeEntry(entry);
        return;
      }
      releaseDispatchDedupeClaims(entry.dispatchDedupeClaims, error);
      settleSpooledReplayParticipants(
        entry.spooledReplayParticipants,
        buildFailedProcessingResult(error),
      );
      runtime.error?.(danger(`media group handler failed: ${String(error)}`));
    }
  };
  const queueEntry = (entry: BufferedMediaGroupEntry) => {
    const processing = queue.enqueue(entry.key, async () => {
      entry.phase = "in-flight";
      try {
        await processMediaGroup(entry).catch(() => undefined);
      } finally {
        if (entry.dispatchAdmission === "admitted" && !entry.cancelled) {
          entry.retentionDueAt = Date.now() + timeoutMs;
          if ((pendingAuthorizationsByIdentity.get(entry.identityKey) ?? 0) === 0) {
            entry.timer = setTimeout(() => finalizeEntry(entry), timeoutMs);
          }
        } else {
          finalizeEntry(entry);
        }
        delete entry.processing;
      }
    });
    entry.processing = processing;
  };

  const requestFlush = (entry: BufferedMediaGroupEntry) => {
    entry.timer = undefined;
    if (entry.cancelled || entry.phase !== "buffered") {
      return;
    }
    if ((pendingAuthorizationsByIdentity.get(entry.identityKey) ?? 0) > 0) {
      entry.flushRequested = true;
      return;
    }
    entry.phase = "queued";
    queueEntry(entry);
  };

  const scheduleFlush = (entry: BufferedMediaGroupEntry) => {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.flushDueAt = Date.now() + timeoutMs;
    entry.timer = setTimeout(() => requestFlush(entry), timeoutMs);
  };

  const cancelEntry = async (entry: BufferedMediaGroupEntry): Promise<boolean> => {
    if (entry.dispatchAdmission === "admitted") {
      // Dispatch already owns the turn, but an authorized edit must still purge every album
      // member from live and persisted reply context while the quiet-window owner is retained.
      await purgeEntry(entry);
      // Processing may still install its retention timer; finalize only after that owner settles.
      finalizeTelegramMediaGroupAfterProcessing(entry, finalizeEntry);
      return false;
    }
    if (entry.dispatchAdmission === "cancelled") {
      return true;
    }
    entry.dispatchAdmission = "cancelled";
    entry.cancelled = true;
    entry.dispatchAbortController.abort("skipped");
    for (const resolve of entry.pendingResolutionWaiters) {
      resolve();
    }
    entry.pendingResolutionWaiters.clear();
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    settleSkipped(entry);
    await purgeEntry(entry);
    if (entry.phase === "buffered") {
      finalizeEntry(entry);
    } else if (entry.phase === "in-flight") {
      await entry.processing?.catch(() => undefined);
    }
    return true;
  };

  const beginPendingMediaGroupIgnore = (msg: Message): PendingMediaGroupIgnore | undefined => {
    const mediaGroupId = msg.media_group_id;
    if (!mediaGroupId) {
      return undefined;
    }
    const identityKey = `${msg.chat.id}:${mediaGroupId}`;
    pendingAuthorizationsByIdentity.set(
      identityKey,
      (pendingAuthorizationsByIdentity.get(identityKey) ?? 0) + 1,
    );
    // Pre-flush and admitted-owner retention both yield to the authorization owner.
    pauseTelegramMediaGroupRetention(readActiveEntries(identityKey));
    let settled = false;
    let settledResult = false;
    return {
      settle: async (authorized) => {
        if (settled) {
          return settledResult;
        }
        settled = true;
        const pendingCount = Math.max(
          0,
          (pendingAuthorizationsByIdentity.get(identityKey) ?? 1) - 1,
        );
        if (pendingCount === 0) {
          pendingAuthorizationsByIdentity.delete(identityKey);
        } else {
          pendingAuthorizationsByIdentity.set(identityKey, pendingCount);
        }
        const currentEntries = readActiveEntries(identityKey);
        if (pendingCount === 0) {
          for (const currentEntry of currentEntries) {
            for (const resolve of currentEntry.pendingResolutionWaiters) {
              resolve();
            }
            currentEntry.pendingResolutionWaiters.clear();
          }
        }
        if (authorized) {
          markCancelledIdentity(identityKey);
          const results = await Promise.all(currentEntries.map(cancelEntry));
          settledResult = results.some(Boolean);
          return settledResult;
        }
        if (pendingCount === 0) {
          resumeTelegramMediaGroupAfterDeniedIgnore({
            entries: currentEntries,
            finalizeEntry,
            requestFlush,
          });
        }
        return false;
      },
    };
  };

  const handleMediaGroup = (input: TelegramMediaGroupInput): boolean => {
    const mediaGroupId = input.msg.media_group_id;
    if (!mediaGroupId) {
      return false;
    }
    const key = `media:${input.chatId}:${input.threadSpec.scope}:${input.threadSpec.id ?? "main"}:${mediaGroupId}`;
    const identityKey = `${input.chatId}:${mediaGroupId}`;
    const participant = createSpooledReplayParticipantForBufferedWork(
      `media-group:${key}:${input.msg.message_id}`,
    );
    if (hasCancelledIdentity(identityKey)) {
      markCancelledIdentity(identityKey);
      releaseDispatchDedupeClaims(input.dispatchDedupeClaims);
      participant?.settle({ kind: "skipped" });
      return true;
    }
    const existing = readActiveEntries(identityKey).find(
      (entry) =>
        entry.phase === "buffered" &&
        !entry.cancelled &&
        !entry.settled &&
        entry.dispatchAdmission === "pending",
    );
    // A queued/in-flight owner has already snapshotted its turn and claim set. A late member must
    // become a new queued owner instead of being appended to work that can no longer adopt it.
    if (existing && existing.phase === "buffered" && !existing.cancelled && !existing.settled) {
      if (participant) {
        existing.spooledReplayParticipants.push(participant);
      }
      if (existing.timer) {
        clearTimeout(existing.timer);
      }
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
      scheduleFlush(existing);
      return true;
    }
    const entry: BufferedMediaGroupEntry = {
      ...input,
      key,
      identityKey,
      messages: [{ msg: input.msg, ctx: input.ctx }],
      flushDueAt: Date.now() + timeoutMs,
      phase: "buffered",
      flushRequested: false,
      cancelled: false,
      settled: false,
      dispatchAdmission: "pending",
      dispatchAbortController: new AbortController(),
      pendingResolutionWaiters: new Set(),
      spooledReplayParticipants: participant ? [participant] : [],
      ...promptContextBoundaryOptions(
        input.promptContextMinTimestampMs,
        input.promptContextAmbientWatermark,
      ),
    };
    if ((pendingAuthorizationsByIdentity.get(identityKey) ?? 0) === 0) {
      scheduleFlush(entry);
    }
    registerEntry(entry);
    return true;
  };

  return {
    handleMediaGroup,
    beginPendingMediaGroupIgnore,
    resolveUnaddressedGroupMediaDisposition,
  };
}
