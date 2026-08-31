// Telegram plugin module implements native plugin command behavior.
import { randomUUID } from "node:crypto";
import type { Bot, Context } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginCommandNativeCandidate } from "openclaw/plugin-sdk/plugin-command-runtime";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import {
  formatSqliteSessionFileMarker,
  getSessionEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  prepareTelegramCommandDispatch,
  type TelegramCommandExecutorParams,
} from "./bot-native-command-dispatch.js";
import {
  buildTelegramRoutingTarget,
  buildTelegramGroupFrom,
  buildTelegramThreadParams,
  extractTelegramForumFlag,
  resolveTelegramForumFlag,
  resolveTelegramMessageThreadSpec,
} from "./bot/helpers.js";
import type { TelegramGetChat } from "./bot/types.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import { recordSentMessage } from "./sent-message-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

type TelegramNativeReplyPayload = import("openclaw/plugin-sdk/plugin-entry").PluginCommandResult;
type TelegramNativeReplyChannelData = {
  buttons?: TelegramInlineButtons;
  pin?: boolean;
  reaction?: { emoji?: unknown };
};

function resolveTelegramNativeReplyChannelData(
  result: TelegramNativeReplyPayload,
): TelegramNativeReplyChannelData | undefined {
  return result.channelData?.telegram as TelegramNativeReplyChannelData | undefined;
}

function normalizeTelegramNativeReplyPayload(
  result: TelegramNativeReplyPayload | null | undefined,
): TelegramNativeReplyPayload {
  return result && typeof result === "object" ? result : {};
}

function hasTelegramNativeReplyReaction(result: TelegramNativeReplyPayload): boolean {
  const reactionEmoji = resolveTelegramNativeReplyChannelData(result)?.reaction?.emoji;
  return typeof reactionEmoji === "string" && reactionEmoji.trim().length > 0;
}

function hasRenderableTelegramNativeReplyPayload(result: TelegramNativeReplyPayload): boolean {
  const { channelData: _channelData, ...portableContent } = result;
  if (hasOutboundReplyContent(portableContent, { trimText: true })) {
    return true;
  }
  const telegramData = resolveTelegramNativeReplyChannelData(result);
  return Boolean(
    buildInlineKeyboard(telegramData?.buttons) || hasTelegramNativeReplyReaction(result),
  );
}

function isEditableTelegramProgressResult(result: TelegramNativeReplyPayload): boolean {
  const telegramData = resolveTelegramNativeReplyChannelData(result);
  return Boolean(
    typeof result.text === "string" &&
    result.text.trim() &&
    !result.mediaUrl &&
    (!result.mediaUrls || result.mediaUrls.length === 0) &&
    !result.presentation &&
    !result.interactive &&
    !result.btw &&
    !hasTelegramNativeReplyReaction(result) &&
    telegramData?.pin !== true,
  );
}

async function cleanupTelegramProgressPlaceholder(params: {
  bot: Bot;
  chatId: number;
  progressMessageId?: number;
  runtime: TelegramCommandExecutorParams["runtime"];
}): Promise<void> {
  if (params.progressMessageId == null) {
    return;
  }
  try {
    await withTelegramApiErrorLogging({
      operation: "deleteMessage",
      runtime: params.runtime,
      fn: () => params.bot.api.deleteMessage(params.chatId, params.progressMessageId!),
    });
  } catch {
    // Best-effort cleanup before fallback or suppression exits.
  }
}

async function resolveTelegramPluginThreadParams(params: {
  msg: NonNullable<Context["message"]>;
  bot: Bot;
}) {
  const isGroup = params.msg.chat.type === "group" || params.msg.chat.type === "supergroup";
  const getChat =
    typeof params.bot.api.getChat === "function"
      ? (params.bot.api.getChat.bind(params.bot.api) as TelegramGetChat)
      : undefined;
  const isForum =
    params.msg.chat.is_direct_messages === true
      ? false
      : await resolveTelegramForumFlag({
          chatId: params.msg.chat.id,
          chatType: params.msg.chat.type,
          isGroup,
          isForum: extractTelegramForumFlag(params.msg.chat),
          isTopicMessage: params.msg.is_topic_message,
          getChat,
        });
  return buildTelegramThreadParams(resolveTelegramMessageThreadSpec(params.msg, isForum));
}

async function resolveTelegramCommandTranscriptContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): Promise<{ sessionId?: string; sessionFile?: string; authProfileId?: string }> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return {};
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const entry = getSessionEntry({ agentId: params.agentId, sessionKey, storePath });
    const sessionId = entry?.sessionId?.trim() || randomUUID();
    const sessionFile = formatSqliteSessionFileMarker({
      agentId: params.agentId,
      sessionId,
      storePath,
    });
    const authProfileId = normalizeOptionalString(entry?.authProfileOverride);
    return { sessionId, sessionFile, ...(authProfileId ? { authProfileId } : {}) };
  } catch {
    return {};
  }
}

export async function executeTelegramPluginCommand(
  params: TelegramCommandExecutorParams & {
    commandName: string;
    candidate: PluginCommandNativeCandidate;
  },
): Promise<void> {
  const commandBody = `/${params.commandName}${params.rawText ? ` ${params.rawText}` : ""}`;
  const pluginCommandDispatch = params.candidate.prepareDispatch(params.rawText);
  if (pluginCommandDispatch.kind === "non-plugin") {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime: params.runtime,
      fn: async () =>
        await params.bot.api.sendMessage(
          params.msg.chat.id,
          "Command not found.",
          (await resolveTelegramPluginThreadParams(params)) ?? {},
        ),
    });
    return;
  }
  const dispatch = await prepareTelegramCommandDispatch({
    ...params,
    requireAuth: params.candidate.requireAuth,
  });
  if (!dispatch) {
    return;
  }
  const targetSessionEntry = dispatch.nativeCommandRuntime.getSessionEntry({
    agentId: dispatch.route.agentId,
    sessionKey: dispatch.targetSessionKey,
  });
  const from = dispatch.isGroup
    ? buildTelegramGroupFrom(dispatch.chatId, dispatch.threadSpec)
    : `telegram:${dispatch.chatId}`;
  const to =
    dispatch.threadSpec.scope === "direct-messages"
      ? buildTelegramRoutingTarget(dispatch.chatId, dispatch.threadSpec)
      : `telegram:${dispatch.chatId}`;
  const { deliverReplies, emitTelegramMessageSentHooks } = await dispatch.loadDeliveryRuntime();
  let progressMessageId: number | undefined;
  if (params.candidate.progressMessage) {
    try {
      const sent = await withTelegramApiErrorLogging({
        operation: "sendMessage",
        runtime: dispatch.runtime,
        fn: () =>
          dispatch.bot.api.sendMessage(
            dispatch.chatId,
            params.candidate.progressMessage!,
            buildTelegramThreadParams(dispatch.threadSpec),
          ),
      });
      const maybeMessageId = (sent as { message_id?: unknown } | undefined)?.message_id;
      if (typeof maybeMessageId === "number") {
        progressMessageId = maybeMessageId;
      }
    } catch {
      // Fall back to the normal final reply path if the placeholder send fails.
    }
  }
  const transcriptContext = await resolveTelegramCommandTranscriptContext({
    cfg: dispatch.runtimeCfg,
    agentId: dispatch.route.agentId,
    sessionKey: dispatch.targetSessionKey,
  });
  const result = normalizeTelegramNativeReplyPayload(
    await pluginCommandDispatch.execute({
      senderId: dispatch.senderId,
      channel: "telegram",
      isAuthorizedSender: dispatch.commandAuthorized,
      senderIsOwner: dispatch.senderIsOwner,
      agentId: dispatch.route.agentId,
      sessionKey: dispatch.targetSessionKey,
      sessionId: transcriptContext.sessionId,
      sessionFile: transcriptContext.sessionFile,
      authProfileId: transcriptContext.authProfileId ?? targetSessionEntry?.authProfileOverride,
      commandBody,
      config: dispatch.runtimeCfg,
      from,
      to,
      accountId: dispatch.accountId,
      messageThreadId: dispatch.threadSpec.id,
    }),
  );
  const suppressReply =
    shouldSuppressLocalTelegramExecApprovalPrompt({
      cfg: dispatch.runtimeCfg,
      accountId: dispatch.route.accountId,
      payload: result,
    }) || result.suppressReply === true;
  if (suppressReply) {
    await cleanupTelegramProgressPlaceholder({
      bot: dispatch.bot,
      chatId: dispatch.chatId,
      progressMessageId,
      runtime: dispatch.runtime,
    });
    return;
  }
  const hasReaction = hasTelegramNativeReplyReaction(result);
  const deliverableResult: TelegramNativeReplyPayload = hasRenderableTelegramNativeReplyPayload(
    result,
  )
    ? hasReaction && !normalizeOptionalString(result.replyToId)
      ? { ...result, replyToId: String(dispatch.msg.message_id) }
      : result
    : { text: EMPTY_RESPONSE_FALLBACK };
  const progressResultText =
    typeof deliverableResult.text === "string" && deliverableResult.text.trim().length > 0
      ? deliverableResult.text
      : null;
  const telegramResultData = resolveTelegramNativeReplyChannelData(deliverableResult);
  if (
    progressMessageId != null &&
    dispatch.telegramDeps.editMessageTelegram &&
    progressResultText &&
    isEditableTelegramProgressResult(deliverableResult)
  ) {
    try {
      await dispatch.telegramDeps.editMessageTelegram(
        dispatch.chatId,
        progressMessageId,
        progressResultText,
        {
          cfg: dispatch.runtimeCfg,
          accountId: dispatch.route.accountId,
          textMode: "markdown",
          linkPreview: dispatch.runtimeTelegramCfg.linkPreview,
          buttons: telegramResultData?.buttons,
        },
      );
      recordSentMessage(dispatch.chatId, progressMessageId, dispatch.runtimeCfg, {
        accountId: dispatch.route.accountId,
        agentId: dispatch.opts.ownerAgentId,
      });
      emitTelegramMessageSentHooks({
        sessionKeyForInternalHooks: dispatch.targetSessionKey,
        chatId: String(dispatch.chatId),
        accountId: dispatch.route.accountId,
        content: progressResultText,
        success: true,
        messageId: progressMessageId,
        isGroup: dispatch.isGroup,
        groupId: dispatch.isGroup ? String(dispatch.chatId) : undefined,
      });
      return;
    } catch {
      // Fall through to cleanup + normal delivered reply if editing fails.
    }
  }
  await cleanupTelegramProgressPlaceholder({
    bot: dispatch.bot,
    chatId: dispatch.chatId,
    progressMessageId,
    runtime: dispatch.runtime,
  });
  await deliverReplies({
    replies: [deliverableResult],
    ...dispatch.buildDeliveryBaseOptions({
      sessionKeyForInternalHooks: dispatch.targetSessionKey,
      policySessionKey: dispatch.targetSessionKey,
    }),
    ...(hasReaction ? { replyToMode: "all" as const } : {}),
    silent:
      dispatch.runtimeTelegramCfg.silentErrorReplies === true && deliverableResult.isError === true,
  });
}
