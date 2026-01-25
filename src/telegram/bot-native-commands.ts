import type { Bot, Context } from "grammy";

import { resolveEffectiveMessagesConfig } from "../agents/identity.js";
import { resolveChunkMode } from "../auto-reply/chunk.js";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
  parseCommandArgs,
  resolveCommandArgMenu,
} from "../auto-reply/commands-registry.js";
import { listSkillCommandsForAgents } from "../auto-reply/skill-commands.js";
import type { CommandArgs } from "../auto-reply/commands-registry.js";
import { resolveTelegramCustomCommands } from "../config/telegram-custom-commands.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { danger, logVerbose } from "../globals.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../channels/command-gating.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type {
  ReplyToMode,
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { deliverReplies } from "./bot/delivery.js";
import { buildInlineKeyboard } from "./send.js";
import {
  buildSenderName,
  buildTelegramGroupFrom,
  buildTelegramGroupPeerId,
  resolveTelegramForumThreadId,
} from "./bot/helpers.js";
import { firstDefined, isSenderAllowed, normalizeAllowFromWithStore } from "./bot-access.js";
import { readTelegramAllowFromStore } from "./pairing-store.js";

type TelegramNativeCommandContext = Context & { match?: string };

type RegisterTelegramNativeCommandsParams = {
  bot: Bot;
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  accountId: string;
  telegramCfg: TelegramAccountConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  replyToMode: ReplyToMode;
  textLimit: number;
  useAccessGroups: boolean;
  nativeEnabled: boolean;
  nativeSkillsEnabled: boolean;
  nativeDisabledExplicit: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
  shouldSkipUpdate: (ctx: unknown) => boolean;
  opts: { token: string };
};

export const registerTelegramNativeCommands = ({
  bot,
  cfg,
  runtime,
  accountId,
  telegramCfg,
  allowFrom,
  groupAllowFrom,
  replyToMode,
  textLimit,
  useAccessGroups,
  nativeEnabled,
  nativeSkillsEnabled,
  nativeDisabledExplicit,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  opts,
}: RegisterTelegramNativeCommandsParams) => {
  const skillCommands =
    nativeEnabled && nativeSkillsEnabled ? listSkillCommandsForAgents({ cfg }) : [];
  const nativeCommands = nativeEnabled
    ? listNativeCommandSpecsForConfig(cfg, { skillCommands, provider: "telegram" })
    : [];
  const reservedCommands = new Set(
    listNativeCommandSpecs().map((command) => command.name.toLowerCase()),
  );
  for (const command of skillCommands) {
    reservedCommands.add(command.name.toLowerCase());
  }
  const customResolution = resolveTelegramCustomCommands({
    commands: telegramCfg.customCommands,
    reservedCommands,
  });
  for (const issue of customResolution.issues) {
    runtime.error?.(danger(issue.message));
  }
  const customCommands = customResolution.commands;
  const allCommands: Array<{ command: string; description: string }> = [
    ...nativeCommands.map((command) => ({
      command: command.name,
      description: command.description,
    })),
    ...customCommands,
  ];

  if (allCommands.length > 0) {
    bot.api.setMyCommands(allCommands).catch((err) => {
      runtime.error?.(danger(`telegram setMyCommands failed: ${String(err)}`));
    });

    if (typeof (bot as unknown as { command?: unknown }).command !== "function") {
      logVerbose("telegram: bot.command unavailable; skipping native handlers");
    } else {
      for (const command of nativeCommands) {
        bot.command(command.name, async (ctx: TelegramNativeCommandContext) => {
          const msg = ctx.message;
          if (!msg) return;
          if (shouldSkipUpdate(ctx)) return;
          const chatId = msg.chat.id;
          const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
          const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
          const isForum = (msg.chat as { is_forum?: boolean }).is_forum === true;
          const resolvedThreadId = resolveTelegramForumThreadId({
            isForum,
            messageThreadId,
          });
          const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
          const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId);
          const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
          const effectiveGroupAllow = normalizeAllowFromWithStore({
            allowFrom: groupAllowOverride ?? groupAllowFrom,
            storeAllowFrom,
          });
          const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";

          if (isGroup && groupConfig?.enabled === false) {
            await bot.api.sendMessage(chatId, "This group is disabled.");
            return;
          }
          if (isGroup && topicConfig?.enabled === false) {
            await bot.api.sendMessage(chatId, "This topic is disabled.");
            return;
          }
          if (isGroup && hasGroupAllowOverride) {
            const senderId = msg.from?.id;
            const senderUsername = msg.from?.username ?? "";
            if (
              senderId == null ||
              !isSenderAllowed({
                allow: effectiveGroupAllow,
                senderId: String(senderId),
                senderUsername,
              })
            ) {
              await bot.api.sendMessage(chatId, "You are not authorized to use this command.");
              return;
            }
          }

          if (isGroup && useAccessGroups) {
            const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
            const groupPolicy = telegramCfg.groupPolicy ?? defaultGroupPolicy ?? "open";
            if (groupPolicy === "disabled") {
              await bot.api.sendMessage(chatId, "Telegram group commands are disabled.");
              return;
            }
            if (groupPolicy === "allowlist") {
              const senderId = msg.from?.id;
              if (senderId == null) {
                await bot.api.sendMessage(chatId, "You are not authorized to use this command.");
                return;
              }
              const senderUsername = msg.from?.username ?? "";
              if (
                !isSenderAllowed({
                  allow: effectiveGroupAllow,
                  senderId: String(senderId),
                  senderUsername,
                })
              ) {
                await bot.api.sendMessage(chatId, "You are not authorized to use this command.");
                return;
              }
            }
            const groupAllowlist = resolveGroupPolicy(chatId);
            if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
              await bot.api.sendMessage(chatId, "This group is not allowed.");
              return;
            }
          }

          const senderId = msg.from?.id ? String(msg.from.id) : "";
          const senderUsername = msg.from?.username ?? "";
          const dmAllow = normalizeAllowFromWithStore({
            allowFrom: allowFrom,
            storeAllowFrom,
          });
          const senderAllowed = isSenderAllowed({
            allow: dmAllow,
            senderId,
            senderUsername,
          });
          const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
            useAccessGroups,
            authorizers: [{ configured: dmAllow.hasEntries, allowed: senderAllowed }],
            modeWhenAccessGroupsOff: "configured",
          });
          if (!commandAuthorized) {
            await bot.api.sendMessage(chatId, "You are not authorized to use this command.");
            return;
          }

          const commandDefinition = findCommandByNativeName(command.name, "telegram");
          const rawText = ctx.match?.trim() ?? "";
          const commandArgs = commandDefinition
            ? parseCommandArgs(commandDefinition, rawText)
            : rawText
              ? ({ raw: rawText } satisfies CommandArgs)
              : undefined;
          const prompt = commandDefinition
            ? buildCommandTextFromArgs(commandDefinition, commandArgs)
            : rawText
              ? `/${command.name} ${rawText}`
              : `/${command.name}`;
          const menu = commandDefinition
            ? resolveCommandArgMenu({
                command: commandDefinition,
                args: commandArgs,
                cfg,
              })
            : null;
          if (menu && commandDefinition) {
            const title =
              menu.title ??
              `Choose ${menu.arg.description || menu.arg.name} for /${commandDefinition.nativeName ?? commandDefinition.key}.`;
            const rows: Array<Array<{ text: string; callback_data: string }>> = [];
            for (let i = 0; i < menu.choices.length; i += 2) {
              const slice = menu.choices.slice(i, i + 2);
              rows.push(
                slice.map((choice) => {
                  const args: CommandArgs = {
                    values: { [menu.arg.name]: choice },
                  };
                  return {
                    text: choice,
                    callback_data: buildCommandTextFromArgs(commandDefinition, args),
                  };
                }),
              );
            }
            const replyMarkup = buildInlineKeyboard(rows);
            await bot.api.sendMessage(chatId, title, {
              ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
              ...(resolvedThreadId != null ? { message_thread_id: resolvedThreadId } : {}),
            });
            return;
          }
          const route = resolveAgentRoute({
            cfg,
            channel: "telegram",
            accountId,
            peer: {
              kind: isGroup ? "group" : "dm",
              id: isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : String(chatId),
            },
          });
          const tableMode = resolveMarkdownTableMode({
            cfg,
            channel: "telegram",
            accountId: route.accountId,
          });
          const skillFilter = firstDefined(topicConfig?.skills, groupConfig?.skills);
          const systemPromptParts = [
            groupConfig?.systemPrompt?.trim() || null,
            topicConfig?.systemPrompt?.trim() || null,
          ].filter((entry): entry is string => Boolean(entry));
          const groupSystemPrompt =
            systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
          const conversationLabel = isGroup
            ? msg.chat.title
              ? `${msg.chat.title} id:${chatId}`
              : `group:${chatId}`
            : (buildSenderName(msg) ?? String(senderId || chatId));
          const ctxPayload = finalizeInboundContext({
            Body: prompt,
            RawBody: prompt,
            CommandBody: prompt,
            CommandArgs: commandArgs,
            From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
            To: `slash:${senderId || chatId}`,
            ChatType: isGroup ? "group" : "direct",
            ConversationLabel: conversationLabel,
            GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
            GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
            SenderName: buildSenderName(msg),
            SenderId: senderId || undefined,
            SenderUsername: senderUsername || undefined,
            Surface: "telegram",
            MessageSid: String(msg.message_id),
            Timestamp: msg.date ? msg.date * 1000 : undefined,
            WasMentioned: true,
            CommandAuthorized: commandAuthorized,
            CommandSource: "native" as const,
            SessionKey: `telegram:slash:${senderId || chatId}`,
            CommandTargetSessionKey: route.sessionKey,
            MessageThreadId: resolvedThreadId,
            IsForum: isForum,
            // Originating context for sub-agent announce routing
            OriginatingChannel: "telegram" as const,
            OriginatingTo: `telegram:${chatId}`,
          });

          const disableBlockStreaming =
            typeof telegramCfg.blockStreaming === "boolean"
              ? !telegramCfg.blockStreaming
              : undefined;
          const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);

          await dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId).responsePrefix,
              deliver: async (payload) => {
                await deliverReplies({
                  replies: [payload],
                  chatId: String(chatId),
                  token: opts.token,
                  runtime,
                  bot,
                  replyToMode,
                  textLimit,
                  messageThreadId: resolvedThreadId,
                  tableMode,
                  chunkMode,
                });
              },
              onError: (err, info) => {
                runtime.error?.(danger(`telegram slash ${info.kind} reply failed: ${String(err)}`));
              },
            },
            replyOptions: {
              skillFilter,
              disableBlockStreaming,
            },
          });
        });
      }
    }
  } else if (nativeDisabledExplicit) {
    bot.api.setMyCommands([]).catch((err) => {
      runtime.error?.(danger(`telegram clear commands failed: ${String(err)}`));
    });
  }
};
