// Telegram plugin module implements bot message context.session behavior.
import {
  type BuildChannelInboundEventContextParams,
  type BuildChannelInboundEventContextAsyncParams,
  type BuiltChannelInboundEventContext,
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
  toLocationContext,
  type NormalizedLocation,
  type InboundEventKind,
} from "openclaw/plugin-sdk/channel-inbound";
import { normalizeCommandBody } from "openclaw/plugin-sdk/command-surface";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import { createChannelHistoryWindow, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { evaluateSupplementalContextVisibility } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { NormalizedAllowFrom } from "./bot-access.js";
import { isSenderAllowed, normalizeAllowFrom } from "./bot-access.js";
import type {
  TelegramMediaRef,
  TelegramMessageContextOptions,
  TelegramMessageContextSessionRuntimeOverrides,
  TelegramPromptContextEntry,
} from "./bot-message-context.types.js";
import { resolveTelegramPromptMediaPath } from "./prompt-media-path.js";

type TelegramMentionFacts = NonNullable<
  NonNullable<BuildChannelInboundEventContextParams["access"]>["mentions"]
>;
import {
  buildGroupLabel,
  buildSenderLabel,
  buildSenderName,
  buildTelegramGroupFrom,
  buildTelegramInboundOriginTarget,
  describeReplyTarget,
  normalizeForwardedContext,
  type TelegramReplyTarget,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { resolveTelegramGroupPromptSettings } from "./group-config-helpers.js";
import {
  isTelegramHistoryEntryAfterAmbientWatermark,
  isTelegramChatWindowPromptContext,
  mergeTelegramGroupHistoryPromptContext,
  recordTelegramGroupHistoryEntry,
  selectTelegramGroupHistoryAfterLastSelf,
} from "./group-history-window.js";
import type { TelegramReplyChainEntry } from "./message-cache.js";

type TelegramInboundContextPayload = BuiltChannelInboundEventContext & {
  From: string;
  To: string;
  ChatType: string;
  RawBody: string;
  ReplyToIsExternal?: boolean;
  ReplyToQuotePosition?: number;
  ReplyToQuoteEntities?: TelegramReplyTarget["quoteEntities"];
  ReplyToQuoteSourceText?: string;
  ReplyToQuoteSourceEntities?: TelegramReplyTarget["quoteSourceEntities"];
};

type TelegramMessageContextSessionRuntime =
  typeof import("./bot-message-context.session.runtime.js");

const sessionRuntimeMethods = [
  "buildChannelInboundEventContext",
  "readAmbientTranscriptWatermark",
  "readSessionUpdatedAt",
  "recordInboundSession",
  "resolveAmbientTranscriptWatermarkKey",
  "resolveInboundLastRouteSessionKey",
  "resolvePinnedMainDmOwnerFromAllowlist",
  "resolveStorePath",
] as const satisfies readonly (keyof TelegramMessageContextSessionRuntime)[];

function hasCompleteSessionRuntime(
  runtime: TelegramMessageContextSessionRuntimeOverrides | undefined,
): runtime is TelegramMessageContextSessionRuntime {
  return Boolean(
    runtime && sessionRuntimeMethods.every((method) => typeof runtime[method] === "function"),
  );
}

async function loadTelegramMessageContextSessionRuntime(
  runtime: TelegramMessageContextSessionRuntimeOverrides | undefined,
): Promise<TelegramMessageContextSessionRuntime> {
  if (hasCompleteSessionRuntime(runtime)) {
    return runtime;
  }
  return {
    ...(await import("./bot-message-context.session.runtime.js")),
    ...runtime,
  };
}

export async function resolveTelegramMessageContextStorePath(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionRuntime?: TelegramMessageContextSessionRuntimeOverrides;
}): Promise<string> {
  const sessionRuntime = await loadTelegramMessageContextSessionRuntime(params.sessionRuntime);
  return sessionRuntime.resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
}

function replyTargetToChainEntry(replyTarget: TelegramReplyTarget): TelegramReplyChainEntry {
  return {
    ...(replyTarget.id ? { messageId: replyTarget.id } : {}),
    sender: replyTarget.sender,
    ...(replyTarget.senderId ? { senderId: replyTarget.senderId } : {}),
    ...(replyTarget.senderUsername ? { senderUsername: replyTarget.senderUsername } : {}),
    ...(replyTarget.body ? { body: replyTarget.body } : {}),
    ...(replyTarget.kind === "quote" ? { isQuote: true } : {}),
    ...(replyTarget.forwardedFrom?.from ? { forwardedFrom: replyTarget.forwardedFrom.from } : {}),
    ...(replyTarget.forwardedFrom?.fromId
      ? { forwardedFromId: replyTarget.forwardedFrom.fromId }
      : {}),
    ...(replyTarget.forwardedFrom?.fromUsername
      ? { forwardedFromUsername: replyTarget.forwardedFrom.fromUsername }
      : {}),
    ...(replyTarget.forwardedFrom?.date
      ? { forwardedDate: replyTarget.forwardedFrom.date * 1000 }
      : {}),
  };
}

function stripReplyChainForwarded(entry: TelegramReplyChainEntry): TelegramReplyChainEntry {
  const {
    forwardedFrom: _forwardedFrom,
    forwardedFromId: _forwardedFromId,
    forwardedFromUsername: _forwardedFromUsername,
    forwardedDate: _forwardedDate,
    ...withoutForwarded
  } = entry;
  return withoutForwarded;
}

function formatReplyChainEntry(entry: TelegramReplyChainEntry, index: number): string {
  const forwardedAt = timestampMsToIsoString(entry.forwardedDate);
  const mediaPath = entry.mediaPath ? resolveTelegramPromptMediaPath(entry.mediaPath) : undefined;
  const labels = [
    `${index + 1}. ${entry.sender ?? "unknown sender"}`,
    entry.messageId ? `id:${entry.messageId}` : undefined,
    entry.replyToId ? `reply_to:${entry.replyToId}` : undefined,
    entry.timestamp ? timestampMsToIsoString(entry.timestamp) : undefined,
  ].filter(Boolean);
  const bodyLines = [
    entry.forwardedFrom
      ? `[Forwarded from ${entry.forwardedFrom}${forwardedAt ? ` at ${forwardedAt}` : ""}]`
      : undefined,
    entry.isQuote && entry.body ? `"${entry.body}"` : entry.body,
    entry.mediaType ? `<media:${entry.mediaType}>` : undefined,
    mediaPath ? `[media_path:${mediaPath}]` : undefined,
    entry.mediaRef ? `[media_ref:${entry.mediaRef}]` : undefined,
  ].filter(Boolean);
  return `[${labels.join(" ")}]\n${bodyLines.join("\n")}`;
}

export async function buildTelegramInboundContextPayload(params: {
  cfg: OpenClawConfig;
  primaryCtx: TelegramContext;
  msg: TelegramContext["message"];
  allMedia: TelegramMediaRef[];
  replyMedia: TelegramMediaRef[];
  replyChain: TelegramReplyChainEntry[];
  promptContext: TelegramPromptContextEntry[];
  isGroup: boolean;
  isForum: boolean;
  chatId: number | string;
  senderId: string;
  senderUsername: string;
  resolvedThreadId?: number;
  dmThreadId?: number;
  threadSpec: TelegramThreadSpec;
  route: ResolvedAgentRoute;
  rawBody: string;
  bodyText: string;
  historyKey?: string;
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  effectiveWasMentioned: boolean;
  inboundEventKind: InboundEventKind;
  groupRequireMention: boolean;
  mentionFacts: TelegramMentionFacts;
  hasControlCommand: boolean;
  stickerCacheHit?: boolean;
  audioTranscribedMediaIndex?: number;
  commandAuthorized: boolean;
  locationData?: NormalizedLocation;
  options?: TelegramMessageContextOptions;
  dmAllowFrom?: Array<string | number>;
  effectiveGroupAllow?: NormalizedAllowFrom;
  topicName?: string;
  sessionRuntime?: TelegramMessageContextSessionRuntimeOverrides;
}): Promise<{
  ctxPayload: TelegramInboundContextPayload;
  skillFilter: string[] | undefined;
  turn: {
    storePath: string;
    recordInboundSession: TelegramMessageContextSessionRuntime["recordInboundSession"];
    record: {
      updateLastRoute?: Parameters<
        TelegramMessageContextSessionRuntime["recordInboundSession"]
      >[0]["updateLastRoute"];
      onRecordError: (err: unknown) => void;
    };
  };
}> {
  const {
    cfg,
    primaryCtx,
    msg,
    allMedia,
    replyMedia,
    replyChain,
    promptContext,
    isGroup,
    isForum,
    chatId,
    senderId,
    senderUsername,
    resolvedThreadId,
    dmThreadId,
    threadSpec,
    route,
    rawBody,
    bodyText,
    historyKey,
    historyLimit,
    groupHistories,
    groupConfig,
    topicConfig,
    effectiveWasMentioned,
    inboundEventKind,
    groupRequireMention,
    mentionFacts,
    hasControlCommand,
    stickerCacheHit,
    audioTranscribedMediaIndex,
    commandAuthorized,
    locationData,
    options,
    dmAllowFrom,
    effectiveGroupAllow,
    topicName,
    sessionRuntime: sessionRuntimeOverride,
  } = params;
  const replyTarget = describeReplyTarget(msg);
  const forwardOrigin = normalizeForwardedContext(msg);
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg,
    channel: "telegram",
    accountId: route.accountId,
  });
  const shouldIncludeGroupSupplementalContext = (paramsLocal: {
    kind: "quote" | "forwarded";
    senderId?: string;
    senderUsername?: string;
  }): boolean => {
    if (!isGroup) {
      return true;
    }
    const senderAllowed = effectiveGroupAllow?.hasEntries
      ? isSenderAllowed({
          allow: effectiveGroupAllow,
          senderId: paramsLocal.senderId,
          senderUsername: paramsLocal.senderUsername,
        })
      : true;
    return evaluateSupplementalContextVisibility({
      mode: contextVisibilityMode,
      kind: paramsLocal.kind,
      senderAllowed,
    }).include;
  };
  const includeReplyTarget = replyTarget
    ? shouldIncludeGroupSupplementalContext({
        kind: "quote",
        senderId: replyTarget.senderId,
        senderUsername: replyTarget.senderUsername,
      })
    : false;
  const includeForwardOrigin = forwardOrigin
    ? shouldIncludeGroupSupplementalContext({
        kind: "forwarded",
        senderId: forwardOrigin.fromId,
        senderUsername: forwardOrigin.fromUsername,
      })
    : false;
  const visibleReplyForwardedFrom =
    includeReplyTarget && replyTarget?.forwardedFrom
      ? shouldIncludeGroupSupplementalContext({
          kind: "forwarded",
          senderId: replyTarget.forwardedFrom.fromId,
          senderUsername: replyTarget.forwardedFrom.fromUsername,
        })
        ? replyTarget.forwardedFrom
        : undefined
      : undefined;
  const visibleReplyTarget: TelegramReplyTarget | null =
    includeReplyTarget && replyTarget
      ? {
          ...replyTarget,
          forwardedFrom: visibleReplyForwardedFrom,
        }
      : null;
  const visibleReplyTargetEntry = visibleReplyTarget
    ? replyTargetToChainEntry(visibleReplyTarget)
    : undefined;
  const rawReplyChain =
    replyChain.length > 0 ? replyChain : visibleReplyTargetEntry ? [visibleReplyTargetEntry] : [];
  const visibleReplyChain = rawReplyChain.flatMap((entry) => {
    const selectedReplyEntry =
      entry.messageId === visibleReplyTargetEntry?.messageId ? visibleReplyTargetEntry : undefined;
    const visibleEntry = {
      ...entry,
      ...selectedReplyEntry,
      // Preserve authenticated identity while Telegram's selected quote body wins.
      sender: entry.sender,
      senderId: entry.senderId,
      senderUsername: entry.senderUsername,
    };
    if (
      !shouldIncludeGroupSupplementalContext({
        kind: "quote",
        senderId: visibleEntry.senderId,
        senderUsername: visibleEntry.senderUsername,
      })
    ) {
      return [];
    }
    const includeForwarded =
      visibleEntry.forwardedFrom &&
      shouldIncludeGroupSupplementalContext({
        kind: "forwarded",
        senderId: visibleEntry.forwardedFromId,
        senderUsername: visibleEntry.forwardedFromUsername,
      });
    return [includeForwarded ? visibleEntry : stripReplyChainForwarded(visibleEntry)];
  });
  const visibleForwardOrigin = includeForwardOrigin ? forwardOrigin : null;
  const visibleForwardOriginAt = timestampMsToIsoString(
    visibleForwardOrigin?.date ? visibleForwardOrigin.date * 1000 : undefined,
  );
  const replySuffix =
    visibleReplyChain.length > 0
      ? `\n\n[Reply chain - nearest first]\n${visibleReplyChain
          .map(formatReplyChainEntry)
          .join("\n")}\n[/Reply chain]`
      : "";
  const forwardPrefix = visibleForwardOrigin
    ? `[Forwarded from ${visibleForwardOrigin.from}${
        visibleForwardOriginAt ? ` at ${visibleForwardOriginAt}` : ""
      }]\n`
    : "";
  const groupLabel = isGroup ? buildGroupLabel(msg, chatId, resolvedThreadId) : undefined;
  const senderName = buildSenderName(msg);
  const conversationLabel = isGroup
    ? (groupLabel ?? `group:${chatId}`)
    : buildSenderLabel(msg, senderId || chatId);
  const sessionRuntime = await loadTelegramMessageContextSessionRuntime(sessionRuntimeOverride);
  const storePath = await resolveTelegramMessageContextStorePath({
    cfg,
    agentId: route.agentId,
    sessionRuntime: sessionRuntimeOverride,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = sessionRuntime.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const ambientTranscriptWatermarkKey =
    isGroup && historyKey
      ? sessionRuntime.resolveAmbientTranscriptWatermarkKey({
          channel: "telegram",
          accountId: route.accountId,
          conversationId: String(chatId),
          ...(resolvedThreadId !== undefined ? { threadId: resolvedThreadId } : {}),
        })
      : undefined;
  const ambientTranscriptWatermark = ambientTranscriptWatermarkKey
    ? sessionRuntime.readAmbientTranscriptWatermark({
        storePath,
        sessionKey: route.sessionKey,
        key: ambientTranscriptWatermarkKey,
      })
    : undefined;
  const shouldSuppressPersistedDmChatWindowContext =
    !isGroup &&
    previousTimestamp !== undefined &&
    dmThreadId == null &&
    visibleReplyChain.length === 0 &&
    !visibleReplyTarget;
  // Existing plain DMs already carry their history through the persistent
  // transcript. Keep chat windows for fresh DMs, topics, replies, and groups.
  const baseVisiblePromptContext = shouldSuppressPersistedDmChatWindowContext
    ? promptContext.filter((entry) => !isTelegramChatWindowPromptContext(entry))
    : promptContext;
  const body = formatInboundEnvelope({
    channel: "Telegram",
    from: conversationLabel,
    timestamp: msg.date ? msg.date * 1000 : undefined,
    body: `${forwardPrefix}${bodyText}${replySuffix}`,
    chatType: isGroup ? "group" : "direct",
    sender: {
      name: senderName,
      username: senderUsername || undefined,
      id: senderId || undefined,
    },
    previousTimestamp,
    envelope: envelopeOptions,
  });
  const hasGroupHistoryContext = isGroup;
  const commandBody = normalizeCommandBody(rawBody, {
    botUsername: normalizeOptionalLowercaseString(primaryCtx.me?.username),
  });
  const commandSource =
    options?.commandSource ??
    (commandAuthorized && hasControlCommand ? ("text" as const) : undefined);
  const conversationKind = isGroup ? "group" : "direct";
  let watermarkedGroupHistoryEntries: HistoryEntry[] | undefined;
  let groupHistoryPromptEntries: HistoryEntry[] = [];
  if (hasGroupHistoryContext && historyKey && historyLimit > 0) {
    const bufferedHistoryCount = groupHistories.get(historyKey)?.length ?? 0;
    const fullGroupHistoryEntries = (
      createChannelHistoryWindow({ historyMap: groupHistories }).buildInboundHistory({
        historyKey,
        limit: bufferedHistoryCount,
      }) ?? []
    )
      .filter((entry) =>
        isTelegramHistoryEntryAfterAmbientWatermark(entry, ambientTranscriptWatermark),
      )
      .slice(-historyLimit);
    watermarkedGroupHistoryEntries =
      selectTelegramGroupHistoryAfterLastSelf(fullGroupHistoryEntries).slice(-historyLimit);
    groupHistoryPromptEntries =
      inboundEventKind === "room_event" ? fullGroupHistoryEntries : watermarkedGroupHistoryEntries;
  }
  const visiblePromptContext = mergeTelegramGroupHistoryPromptContext({
    promptContext: baseVisiblePromptContext,
    entries: groupHistoryPromptEntries,
  });

  const { skillFilter, groupSystemPrompt } = resolveTelegramGroupPromptSettings({
    groupConfig,
    topicConfig,
  });
  const replyHead = visibleReplyChain[0];
  const toInboundMedia = (media: TelegramMediaRef, index?: number) => ({
    path: media.path,
    url: media.path,
    contentType: media.contentType,
    transcribed: index !== undefined && audioTranscribedMediaIndex === index,
  });
  const currentMediaFacts = allMedia.map(toInboundMedia);
  const replyMediaFacts =
    visibleReplyChain.length > 0
      ? visibleReplyChain.flatMap((entry) =>
          entry.mediaPath
            ? [{ path: entry.mediaPath, url: entry.mediaPath, contentType: entry.mediaType }]
            : [],
        )
      : visibleReplyTarget
        ? replyMedia.map((media) => toInboundMedia(media))
        : [];
  const telegramFrom = isGroup
    ? buildTelegramGroupFrom(chatId, resolvedThreadId)
    : `telegram:${chatId}`;
  const telegramTo = buildTelegramInboundOriginTarget(chatId, threadSpec);
  const locationContext = locationData ? toLocationContext(locationData) : undefined;
  const inboundHistory =
    hasGroupHistoryContext && historyKey && historyLimit > 0
      ? groupHistoryPromptEntries.length > 0
        ? groupHistoryPromptEntries
        : undefined
      : undefined;
  const ctxPayload = await sessionRuntime.buildChannelInboundEventContext({
    channel: "telegram",
    resolveSupplementalMedia: true,
    accountId: route.accountId,
    messageId: options?.messageIdOverride ?? String(msg.message_id),
    timestamp: msg.date ? msg.date * 1000 : undefined,
    from: telegramFrom,
    sender: {
      ...(senderId ? { id: senderId } : {}),
      name: senderName,
      username: senderUsername || undefined,
      isBot: msg.from?.is_bot,
    },
    conversation: {
      kind: conversationKind,
      id: String(chatId),
      label: conversationLabel,
      threadId: threadSpec.id != null ? String(threadSpec.id) : undefined,
    },
    route: {
      agentId: route.agentId,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      mainSessionKey: route.mainSessionKey,
    },
    reply: {
      to: telegramTo,
      replyToId: replyHead?.messageId ?? visibleReplyTarget?.id,
      messageThreadId: threadSpec.id,
    },
    message: {
      inboundEventKind,
      body,
      rawBody,
      bodyForAgent: bodyText,
      commandBody,
      inboundHistory,
      sourceModality: msg.voice ? "voice" : undefined,
    },
    access: {
      commands: {
        authorized: commandAuthorized,
      },
      mentions: mentionFacts,
    },
    command:
      commandSource === "native"
        ? {
            kind: "native",
            authorized: commandAuthorized,
            body: commandBody,
          }
        : commandSource === "text"
          ? {
              kind: "text-slash",
              authorized: commandAuthorized,
              body: commandBody,
            }
          : undefined,
    media: currentMediaFacts,
    supplemental: {
      quote:
        replyHead || visibleReplyTarget
          ? {
              id: replyHead?.messageId ?? visibleReplyTarget?.id,
              body: replyHead?.body ?? visibleReplyTarget?.body,
              sender: replyHead?.sender ?? visibleReplyTarget?.sender,
              senderAllowed: true,
              isQuote:
                replyHead?.isQuote ?? (visibleReplyTarget?.kind === "quote" ? true : undefined),
              media: replyMediaFacts,
            }
          : undefined,
      forwarded: visibleForwardOrigin
        ? {
            from: visibleForwardOrigin.from,
            fromType: visibleForwardOrigin.fromType,
            fromId: visibleForwardOrigin.fromId,
            date: visibleForwardOrigin.date ? visibleForwardOrigin.date * 1000 : undefined,
            senderAllowed: true,
          }
        : undefined,
      groupSystemPrompt: isGroup || (!isGroup && groupConfig) ? groupSystemPrompt : undefined,
      untrustedContext: visiblePromptContext.length > 0 ? visiblePromptContext : undefined,
    },
    contextVisibility: contextVisibilityMode,
    extra: {
      BotUsername: primaryCtx.me?.username ?? undefined,
      AmbientTranscriptWatermarkKey: ambientTranscriptWatermarkKey,
      AmbientTranscriptBody: options?.ambientTranscriptBody,
      AmbientTranscriptMessageId: ambientTranscriptWatermarkKey
        ? (options?.messageIdOverride ?? String(msg.message_id))
        : undefined,
      AmbientTranscriptTimestampMs: ambientTranscriptWatermarkKey
        ? msg.date
          ? msg.date * 1000
          : undefined
        : undefined,
      AmbientTranscriptPreviousMessageId: ambientTranscriptWatermark?.messageId,
      AmbientTranscriptPreviousTimestampMs: ambientTranscriptWatermark?.timestampMs,
      GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
      GroupRequireMention: isGroup ? groupRequireMention : undefined,
      ReplyChain: visibleReplyChain.length > 0 ? visibleReplyChain : undefined,
      ReplyToIsExternal: visibleReplyTarget?.source === "external_reply" ? true : undefined,
      ReplyToQuoteText: visibleReplyTarget?.quoteText,
      ReplyToQuotePosition: visibleReplyTarget?.quotePosition,
      ReplyToQuoteEntities: visibleReplyTarget?.quoteEntities,
      ReplyToQuoteSourceText: visibleReplyTarget?.quoteSourceText,
      ReplyToQuoteSourceEntities: visibleReplyTarget?.quoteSourceEntities,
      ReplyToForwardedFrom: visibleReplyTarget?.forwardedFrom?.from,
      ReplyToForwardedFromType: visibleReplyTarget?.forwardedFrom?.fromType,
      ReplyToForwardedFromId: visibleReplyTarget?.forwardedFrom?.fromId,
      ReplyToForwardedFromUsername: visibleReplyTarget?.forwardedFrom?.fromUsername,
      ReplyToForwardedFromTitle: visibleReplyTarget?.forwardedFrom?.fromTitle,
      ReplyToForwardedDate: visibleReplyTarget?.forwardedFrom?.date
        ? visibleReplyTarget.forwardedFrom.date * 1000
        : undefined,
      ForwardedFromUsername: visibleForwardOrigin?.fromUsername,
      ForwardedFromTitle: visibleForwardOrigin?.fromTitle,
      ForwardedFromSignature: visibleForwardOrigin?.fromSignature,
      ForwardedFromChatType: visibleForwardOrigin?.fromChatType,
      ForwardedFromMessageId: visibleForwardOrigin?.fromMessageId,
      WasMentioned: isGroup ? effectiveWasMentioned : undefined,
      Sticker: allMedia[0]?.stickerMetadata,
      StickerMediaIncluded: allMedia[0]?.stickerMetadata ? currentMediaFacts.length > 0 : undefined,
      SkipStickerMediaUnderstanding: stickerCacheHit ? true : undefined,
      ...locationContext,
      IsForum: isForum,
      TopicName: isForum && topicName ? topicName : undefined,
    },
  } satisfies BuildChannelInboundEventContextAsyncParams);
  if (isGroup && historyKey) {
    recordTelegramGroupHistoryEntry({
      historyMap: groupHistories,
      historyKey,
      limit: historyLimit,
      entry: {
        sender: buildSenderLabel(msg, senderId || chatId),
        body: rawBody,
        timestamp: msg.date ? msg.date * 1000 : undefined,
        messageId: typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
      },
    });
  }

  const pinnedMainDmOwner = !isGroup
    ? sessionRuntime.resolvePinnedMainDmOwnerFromAllowlist({
        dmScope: cfg.session?.dmScope,
        allowFrom: dmAllowFrom,
        normalizeEntry: (entry) => normalizeAllowFrom([entry]).entries[0],
      })
    : null;
  const updateLastRouteSessionKey = sessionRuntime.resolveInboundLastRouteSessionKey({
    route,
    sessionKey: route.sessionKey,
  });
  const shouldPersistGroupLastRouteThread = isGroup && route.matchedBy !== "binding.channel";
  const updateLastRouteThreadId = isGroup
    ? shouldPersistGroupLastRouteThread && resolvedThreadId != null
      ? String(resolvedThreadId)
      : undefined
    : dmThreadId != null
      ? String(dmThreadId)
      : undefined;

  const updateLastRoute =
    !isGroup || updateLastRouteThreadId != null
      ? {
          sessionKey: updateLastRouteSessionKey,
          channel: "telegram" as const,
          to:
            isGroup && updateLastRouteThreadId != null
              ? `telegram:${chatId}:topic:${updateLastRouteThreadId}`
              : `telegram:${chatId}`,
          accountId: route.accountId,
          threadId: updateLastRouteThreadId,
          mainDmOwnerPin:
            !isGroup &&
            updateLastRouteSessionKey === route.mainSessionKey &&
            pinnedMainDmOwner &&
            senderId
              ? {
                  ownerRecipient: pinnedMainDmOwner,
                  senderRecipient: senderId,
                  onSkip: (skipParams: { ownerRecipient: string; senderRecipient: string }) => {
                    logVerbose(
                      `telegram: skip main-session last route for ${skipParams.senderRecipient} (pinned owner ${skipParams.ownerRecipient})`,
                    );
                  },
                }
              : undefined,
        }
      : undefined;

  if (visibleReplyTarget && shouldLogVerbose()) {
    const preview = truncateUtf16Safe((visibleReplyTarget.body ?? "").replace(/\s+/g, " "), 120);
    logVerbose(
      `telegram reply-context: replyToId=${visibleReplyTarget.id} replyToSender=${visibleReplyTarget.sender} replyToBody="${preview}"`,
    );
  }

  if (visibleForwardOrigin && shouldLogVerbose()) {
    logVerbose(
      `telegram forward-context: forwardedFrom="${visibleForwardOrigin.from}" type=${visibleForwardOrigin.fromType}`,
    );
  }

  if (shouldLogVerbose()) {
    const preview = truncateUtf16Safe(body, 200).replace(/\n/g, "\\n");
    const mediaInfo = allMedia.length > 1 ? ` mediaCount=${allMedia.length}` : "";
    const topicInfo = resolvedThreadId != null ? ` topic=${resolvedThreadId}` : "";
    logVerbose(
      `telegram inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length}${mediaInfo}${topicInfo} preview="${preview}"`,
    );
  }

  return {
    ctxPayload,
    skillFilter,
    turn: {
      storePath,
      recordInboundSession: sessionRuntime.recordInboundSession,
      record: {
        updateLastRoute,
        onRecordError: (err) => {
          logVerbose(`telegram: failed updating session meta: ${String(err)}`);
        },
      },
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
