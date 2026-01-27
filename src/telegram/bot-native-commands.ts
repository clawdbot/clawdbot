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
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  normalizeTelegramCommandName,
  TELEGRAM_COMMAND_NAME_PATTERN,
} from "../config/telegram-custom-commands.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../channels/command-gating.js";
import {
  executePluginCommand,
  getPluginCommandSpecs,
  matchPluginCommand,
} from "../plugins/commands.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type {
  ReplyToMode,
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import type { MoltbotConfig } from "../config/config.js";
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

type TelegramCommandAuthResult = {
  chatId: number;
  isGroup: boolean;
  isForum: boolean;
  resolvedThreadId?: number;
  senderId: string;
  senderUsername: string;
  groupConfig?: TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
  commandAuthorized: boolean;
};

type RegisterTelegramNativeCommandsParams = {
  bot: Bot;
  cfg: MoltbotConfig;
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

async function resolveTelegramCommandAuth(params: {
  msg: NonNullable<TelegramNativeCommandContext["message"]>;
  bot: Bot;
  cfg: MoltbotConfig;
  telegramCfg: TelegramAccountConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  useAccessGroups: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
  requireAuth: boolean;
}): Promise<TelegramCommandAuthResult | null> {
  const {
    msg,
    bot,
    cfg,
    telegramCfg,
    allowFrom,
    groupAllowFrom,
    useAccessGroups,
    resolveGroupPolicy,
    resolveTelegramGroupConfig,
    requireAuth,
  } = params;
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
  const senderIdRaw = msg.from?.id;
  const senderId = senderIdRaw ? String(senderIdRaw) : "";
  const senderUsername = msg.from?.username ?? "";

  if (isGroup && groupConfig?.enabled === false) {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () => bot.api.sendMessage(chatId, "This group is disabled."),
    });
    return null;
  }
  if (isGroup && topicConfig?.enabled === false) {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () => bot.api.sendMessage(chatId, "This topic is disabled."),
    });
    return null;
  }
  if (requireAuth && isGroup && hasGroupAllowOverride) {
    if (
      senderIdRaw == null ||
      !isSenderAllowed({
        allow: effectiveGroupAllow,
        senderId: String(senderIdRaw),
        senderUsername,
      })
    ) {
      await withTelegramApiErrorLogging({
        operation: "sendMessage",
        fn: () => bot.api.sendMessage(chatId, "You are not authorized to use this command."),
      });
      return null;
    }
  }

  if (isGroup && useAccessGroups) {
    const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
    const groupPolicy = telegramCfg.groupPolicy ?? defaultGroupPolicy ?? "open";
    if (groupPolicy === "disabled") {
      await withTelegramApiErrorLogging({
        operation: "sendMessage",
        fn: () => bot.api.sendMessage(chatId, "Telegram group commands are disabled."),
      });
      return null;
    }
    if (groupPolicy === "allowlist" && requireAuth) {
      if (
        senderIdRaw == null ||
        !isSenderAllowed({
          allow: effectiveGroupAllow,
          senderId: String(senderIdRaw),
          senderUsername,
        })
      ) {
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          fn: () => bot.api.sendMessage(chatId, "You are not authorized to use this command."),
        });
        return null;
      }
    }
    const groupAllowlist = resolveGroupPolicy(chatId);
    if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
      await withTelegramApiErrorLogging({
        operation: "sendMessage",
        fn: () => bot.api.sendMessage(chatId, "This group is not allowed."),
      });
      return null;
    }
  }

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
  if (requireAuth && !commandAuthorized) {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () => bot.api.sendMessage(chatId, "You are not authorized to use this command."),
    });
    return null;
  }

  return {
    chatId,
    isGroup,
    isForum,
    resolvedThreadId,
    senderId,
    senderUsername,
    groupConfig,
    topicConfig,
    commandAuthorized,
  };
}

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
  const pluginCommandSpecs = getPluginCommandSpecs();
  const pluginCommands: Array<{ command: string; description: string }> = [];
  const existingCommands = new Set(
    [
      ...nativeCommands.map((command) => command.name),
      ...customCommands.map((command) => command.command),
    ].map((command) => command.toLowerCase()),
  );
  const pluginCommandNames = new Set<string>();
  for (const spec of pluginCommandSpecs) {
    const normalized = normalizeTelegramCommandName(spec.name);
    if (!normalized || !TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
      runtime.error?.(
        danger(
          `Plugin command "/${spec.name}" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).`,
        ),
      );
      continue;
    }
    const description = spec.description.trim();
    if (!description) {
      runtime.error?.(danger(`Plugin command "/${normalized}" is missing a description.`));
      continue;
    }
    if (existingCommands.has(normalized)) {
      runtime.error?.(
        danger(`Plugin command "/${normalized}" conflicts with an existing Telegram command.`),
      );
      continue;
    }
    if (pluginCommandNames.has(normalized)) {
      runtime.error?.(danger(`Plugin command "/${normalized}" is duplicated.`));
      continue;
    }
    pluginCommandNames.add(normalized);
    existingCommands.add(normalized);
    pluginCommands.push({ command: normalized, description });
  }
  const allCommands: Array<{ command: string; description: string }> = [
    ...nativeCommands.map((command) => ({
      command: command.name,
      description: command.description,
    })),
    ...pluginCommands,
    ...customCommands,
  ];

  if (allCommands.length > 0) {
    void withTelegramApiErrorLogging({
      operation: "setMyCommands",
      runtime,
      fn: () => bot.api.setMyCommands(allCommands),
    }).catch(() => {});

    if (typeof (bot as unknown as { command?: unknown }).command !== "function") {
      logVerbose("telegram: bot.command unavailable; skipping native handlers");
    } else {
      for (const command of nativeCommands) {
        bot.command(command.name, async (ctx: TelegramNativeCommandContext) => {
          const msg = ctx.message;
          if (!msg) return;
          if (shouldSkipUpdate(ctx)) return;
          const auth = await resolveTelegramCommandAuth({
            msg,
            bot,
            cfg,
            telegramCfg,
            allowFrom,
            groupAllowFrom,
            useAccessGroups,
            resolveGroupPolicy,
            resolveTelegramGroupConfig,
            requireAuth: true,
          });
          if (!auth) return;
          const {
            chatId,
            isGroup,
            isForum,
            resolvedThreadId,
            senderId,
            senderUsername,
            groupConfig,
            topicConfig,
            commandAuthorized,
          } = auth;

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
                    values: { [menu.arg.name]: choice.value },
                  };
                  return {
                    text: choice.label,
                    callback_data: buildCommandTextFromArgs(commandDefinition, args),
                  };
                }),
              );
            }
            const replyMarkup = buildInlineKeyboard(rows);
            await withTelegramApiErrorLogging({
              operation: "sendMessage",
              runtime,
              fn: () =>
                bot.api.sendMessage(chatId, title, {
                  ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
                  ...(resolvedThreadId != null ? { message_thread_id: resolvedThreadId } : {}),
                }),
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
          const baseSessionKey = route.sessionKey;
          const dmThreadId = !isGroup ? resolvedThreadId : undefined;
          const threadKeys =
            dmThreadId != null
              ? resolveThreadSessionKeys({ baseSessionKey, threadId: String(dmThreadId) })
              : null;
          const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
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
            CommandTargetSessionKey: sessionKey,
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
                  linkPreview: telegramCfg.linkPreview,
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

      for (const pluginCommand of pluginCommands) {
        bot.command(pluginCommand.command, async (ctx: TelegramNativeCommandContext) => {
          const msg = ctx.message;
          if (!msg) return;
          if (shouldSkipUpdate(ctx)) return;
          const chatId = msg.chat.id;
          const rawText = ctx.match?.trim() ?? "";
          const commandBody = `/${pluginCommand.command}${rawText ? ` ${rawText}` : ""}`;
          const match = matchPluginCommand(commandBody);
          if (!match) {
            await withTelegramApiErrorLogging({
              operation: "sendMessage",
              runtime,
              fn: () => bot.api.sendMessage(chatId, "Command not found."),
            });
            return;
          }
          const auth = await resolveTelegramCommandAuth({
            msg,
            bot,
            cfg,
            telegramCfg,
            allowFrom,
            groupAllowFrom,
            useAccessGroups,
            resolveGroupPolicy,
            resolveTelegramGroupConfig,
            requireAuth: match.command.requireAuth !== false,
          });
          if (!auth) return;
          const { resolvedThreadId, senderId, commandAuthorized } = auth;

          const result = await executePluginCommand({
            command: match.command,
            args: match.args,
            senderId,
            channel: "telegram",
            isAuthorizedSender: commandAuthorized,
            commandBody,
            config: cfg,
          });
          const tableMode = resolveMarkdownTableMode({
            cfg,
            channel: "telegram",
            accountId,
          });
          const chunkMode = resolveChunkMode(cfg, "telegram", accountId);

          await deliverReplies({
            replies: [result],
            chatId: String(chatId),
            token: opts.token,
            runtime,
            bot,
            replyToMode,
            textLimit,
            messageThreadId: resolvedThreadId,
            tableMode,
            chunkMode,
            linkPreview: telegramCfg.linkPreview,
          });
        });
      }
    }
  } else if (nativeDisabledExplicit) {
    void withTelegramApiErrorLogging({
      operation: "setMyCommands",
      runtime,
      fn: () => bot.api.setMyCommands([]),
    }).catch(() => {});
  }
};
