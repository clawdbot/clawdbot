import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  type BuildChannelTurnContextParams,
  type BuiltChannelTurnContext,
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
  toLocationContext,
  type NormalizedLocation,
} from "openclaw/plugin-sdk/channel-inbound";
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";
import { normalizeCommandBody } from "openclaw/plugin-sdk/command-surface";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import { createChannelHistoryWindow, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { evaluateSupplementalContextVisibility } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { NormalizedAllowFrom } from "./bot-access.js";
import { isSenderAllowed, normalizeAllowFrom } from "./bot-access.js";
import type {
  TelegramMediaRef,
  TelegramMessageContextOptions,
  TelegramMessageContextSessionRuntimeOverrides,
  TelegramPromptContextEntry,
} from "./bot-message-context.types.js";
import {
  buildGroupLabel,
  buildSenderLabel,
  buildSenderName,
  buildTelegramGroupFrom,
  describeReplyTarget,
  normalizeForwardedContext,
  type TelegramReplyTarget,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { resolveTelegramGroupPromptSettings } from "./group-config-helpers.js";
import type { TelegramReplyChainEntry } from "./message-cache.js";

export type TelegramInboundContextPayload = BuiltChannelTurnContext & {
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
  "buildChannelTurnContext",
  "readSessionUpdatedAt",
  "recordInboundSession",
  "resolveInboundLastRouteSessionKey",
  "resolvePinnedMainDmOwnerFromAllowlist",
  "resolveStorePath",
] as const satisfies readonly (keyof TelegramMessageContextSessionRuntime)[];

function resolveAmbientGroupTurnKind(
  cfg: OpenClawConfig,
  agentId: string,
): BuildChannelTurnContextParams["message"]["inboundTurnKind"] {
  const agentGroupChat = resolveAgentConfig(cfg, agentId)?.groupChat;
  if (agentGroupChat && Object.hasOwn(agentGroupChat, "ambientTurns")) {
    return agentGroupChat.ambientTurns ?? "user_request";
  }
  return cfg.messages?.groupChat?.ambientTurns ?? "user_request";
}

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
  const labels = [
    `${index + 1}. ${entry.sender ?? "unknown sender"}`,
    entry.messageId ? `id:${entry.messageId}` : undefined,
    entry.replyToId ? `reply_to:${entry.replyToId}` : undefined,
    entry.timestamp ? new Date(entry.timestamp).toISOString() : undefined,
  ].filter(Boolean);
  const bodyLines = [
    entry.forwardedFrom
      ? `[Forwarded from ${entry.forwardedFrom}${
          entry.forwardedDate ? ` at ${new Date(entry.forwardedDate).toISOString()}` : ""
        }]`
      : undefined,
    entry.isQuote && entry.body ? `"${entry.body}"` : entry.body,
    entry.mediaType ? `<media:${entry.mediaType}>` : undefined,
    entry.mediaPath ? `[media_path:${entry.mediaPath}]` : undefined,
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
  stickerCacheHit: boolean;
  effectiveWasMentioned: boolean;
  hasControlCommand: boolean;
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
    stickerCacheHit,
    effectiveWasMentioned,
    hasControlCommand,
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
  const shouldIncludeGroupSupplementalContext = (params: {
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
          senderId: params.senderId,
          senderUsername: params.senderUsername,
        })
      : true;
    return evaluateSupplementalContextVisibility({
      mode: contextVisibilityMode,
      kind: params.kind,
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
  const visibleReplyTargetById = new Map<string, TelegramReplyChainEntry>(
    visibleReplyTargetEntry?.messageId
      ? [[visibleReplyTargetEntry.messageId, visibleReplyTargetEntry]]
      : [],
  );
  const rawReplyChain =
    replyChain.length > 0 ? replyChain : visibleReplyTargetEntry ? [visibleReplyTargetEntry] : [];
  const visibleReplyChain = rawReplyChain.flatMap((entry) => {
    const visibleEntry = {
      ...entry,
      ...(entry.messageId ? visibleReplyTargetById.get(entry.messageId) : undefined),
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
  const replySuffix =
    visibleReplyChain.length > 0
      ? `\n\n[Reply chain - nearest first]\n${visibleReplyChain
          .map(formatReplyChainEntry)
          .join("\n")}\n[/Reply chain]`
      : "";
  const forwardPrefix = visibleForwardOrigin
    ? `[Forwarded from ${visibleForwardOrigin.from}${
        visibleForwardOrigin.date
          ? ` at ${new Date(visibleForwardOrigin.date * 1000).toISOString()}`
          : ""
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
  const channelHistory = createChannelHistoryWindow({ historyMap: groupHistories });
  let combinedBody = body;
  if (isGroup && historyKey && historyLimit > 0) {
    combinedBody = channelHistory.buildPendingContext({
      historyKey,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "Telegram",
          from: groupLabel ?? `group:${chatId}`,
          timestamp: entry.timestamp,
          body: `${entry.body} [id:${entry.messageId ?? "unknown"} chat:${chatId}]`,
          chatType: "group",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });
  }

  const { skillFilter, groupSystemPrompt } = resolveTelegramGroupPromptSettings({
    groupConfig,
    topicConfig,
  });
  const commandBody = normalizeCommandBody(rawBody, {
    botUsername: normalizeOptionalLowercaseString(primaryCtx.me?.username),
  });
  const inboundHistory =
    isGroup && historyKey && historyLimit > 0
      ? channelHistory.buildInboundHistory({
          historyKey,
          limit: historyLimit,
        })
      : undefined;
  const currentMediaForContext = stickerCacheHit ? [] : allMedia;
  const contextMedia = [...currentMediaForContext, ...replyMedia];
  const replyHead = visibleReplyChain[0];
  const telegramFrom = isGroup
    ? buildTelegramGroupFrom(chatId, resolvedThreadId)
    : `telegram:${chatId}`;
  const telegramTo = `telegram:${chatId}`;
  const locationContext = locationData ? toLocationContext(locationData) : undefined;
  const commandSource = options?.commandSource;
  const ambientGroupTurnKind = resolveAmbientGroupTurnKind(cfg, route.agentId);
  const hasAbortRequest = isAbortRequestText(rawBody, {
    botUsername: normalizeOptionalLowercaseString(primaryCtx.me?.username),
  });
  const inboundTurnKind =
    ambientGroupTurnKind === "room_event" &&
    isGroup &&
    !effectiveWasMentioned &&
    !hasControlCommand &&
    !hasAbortRequest &&
    commandSource !== "native"
      ? "room_event"
      : "user_request";
  const ctxPayload = sessionRuntime.buildChannelTurnContext({
    channel: "telegram",
    accountId: route.accountId,
    provider: "telegram",
    surface: "telegram",
    messageId: options?.messageIdOverride ?? String(msg.message_id),
    timestamp: msg.date ? msg.date * 1000 : undefined,
    from: telegramFrom,
    sender: {
      ...(senderId ? { id: senderId } : {}),
      name: senderName,
      username: senderUsername || undefined,
    },
    conversation: {
      kind: isGroup ? "group" : "direct",
      id: String(chatId),
      label: conversationLabel,
      threadId: threadSpec.id != null ? String(threadSpec.id) : undefined,
      routePeer: {
        kind: isGroup ? "group" : "direct",
        id: String(chatId),
      },
    },
    route: {
      agentId: route.agentId,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      mainSessionKey: route.mainSessionKey,
    },
    reply: {
      to: telegramTo,
      originatingTo: telegramTo,
      replyToId: replyHead?.messageId ?? visibleReplyTarget?.id,
      messageThreadId: threadSpec.id,
    },
    message: {
      inboundTurnKind,
      body: combinedBody,
      rawBody,
      bodyForAgent: bodyText,
      commandBody,
      envelopeFrom: conversationLabel,
      inboundHistory,
    },
    access: {
      commands: {
        authorized: commandAuthorized,
        allowTextCommands: true,
        useAccessGroups: cfg.commands?.useAccessGroups !== false,
        authorizers: [],
      },
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
    media: contextMedia.map((media, index) => ({
      path: media.path,
      url: media.path,
      contentType: media.contentType,
      transcribed: audioTranscribedMediaIndex === index,
    })),
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
      untrustedContext: promptContext.length > 0 ? promptContext : undefined,
    },
    contextVisibility: contextVisibilityMode,
    extra: {
      BotUsername: primaryCtx.me?.username ?? undefined,
      GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
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
      StickerMediaIncluded: allMedia[0]?.stickerMetadata ? !stickerCacheHit : undefined,
      ...locationContext,
      IsForum: isForum,
      TopicName: isForum && topicName ? topicName : undefined,
    },
  } satisfies BuildChannelTurnContextParams);
  if (inboundTurnKind === "room_event" && historyKey) {
    channelHistory.record({
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
    const preview = (visibleReplyTarget.body ?? "").replace(/\s+/g, " ").slice(0, 120);
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
    const preview = body.slice(0, 200).replace(/\n/g, "\\n");
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
