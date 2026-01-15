// @ts-nocheck

import { resolveEffectiveMessagesConfig } from "../agents/identity.js";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listNativeCommandSpecsForConfig,
  parseCommandArgs,
  resolveCommandArgMenu,
} from "../auto-reply/commands-registry.js";
import type { CommandArgs } from "../auto-reply/commands-registry.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { danger, logVerbose } from "../globals.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { deliverReplies } from "./bot/delivery.js";
import { buildInlineKeyboard } from "./send.js";
import {
  buildSenderName,
  buildTelegramGroupFrom,
  buildTelegramGroupPeerId,
  resolveTelegramForumThreadId,
} from "./bot/helpers.js";
import { firstDefined, isSenderAllowed, normalizeAllowFrom } from "./bot-access.js";
import { readTelegramAllowFromStore } from "./pairing-store.js";

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
  nativeDisabledExplicit,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  opts,
}) => {
  const nativeCommands = nativeEnabled ? listNativeCommandSpecsForConfig(cfg) : [];
  if (nativeCommands.length > 0) {
    const api = bot.api as unknown as {
      setMyCommands?: (
        commands: Array<{ command: string; description: string }>,
      ) => Promise<unknown>;
    };
    if (typeof api.setMyCommands === "function") {
      api
        .setMyCommands(
          nativeCommands.map((command) => ({
            command: command.name,
            description: command.description,
          })),
        )
        .catch((err) => {
          runtime.error?.(danger(`telegram setMyCommands failed: ${String(err)}`));
        });
    } else {
      logVerbose("telegram: setMyCommands unavailable; skipping registration");
    }

    if (typeof (bot as unknown as { command?: unknown }).command !== "function") {
      logVerbose("telegram: bot.command unavailable; skipping native handlers");
    } else {
      for (const command of nativeCommands) {
        bot.command(command.name, async (ctx) => {
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
          const effectiveGroupAllow = normalizeAllowFrom([
            ...(groupAllowOverride ?? groupAllowFrom ?? []),
            ...storeAllowFrom,
          ]);
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
            const groupPolicy = telegramCfg.groupPolicy ?? "open";
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

          const allowFromList = Array.isArray(allowFrom)
            ? allowFrom.map((entry) => String(entry).trim()).filter(Boolean)
            : [];
          const senderId = msg.from?.id ? String(msg.from.id) : "";
          const senderUsername = msg.from?.username ?? "";
          const commandAuthorized =
            allowFromList.length === 0 ||
            allowFromList.includes("*") ||
            (senderId && allowFromList.includes(senderId)) ||
            (senderId && allowFromList.includes(`telegram:${senderId}`)) ||
            (senderUsername &&
              allowFromList.some(
                (entry) =>
                  entry.toLowerCase() === senderUsername.toLowerCase() ||
                  entry.toLowerCase() === `@${senderUsername.toLowerCase()}`,
              ));
          if (!commandAuthorized) {
            await bot.api.sendMessage(chatId, "You are not authorized to use this command.");
            return;
          }

          const commandDefinition = findCommandByNativeName(command.name);
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
          if (menu) {
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
          const skillFilter = firstDefined(topicConfig?.skills, groupConfig?.skills);
          const systemPromptParts = [
            groupConfig?.systemPrompt?.trim() || null,
            topicConfig?.systemPrompt?.trim() || null,
          ].filter((entry): entry is string => Boolean(entry));
          const groupSystemPrompt =
            systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
          const ctxPayload = {
            Body: prompt,
            CommandArgs: commandArgs,
            From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
            To: `slash:${senderId || chatId}`,
            ChatType: isGroup ? "group" : "direct",
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
          };

          const disableBlockStreaming =
            typeof telegramCfg.blockStreaming === "boolean"
              ? !telegramCfg.blockStreaming
              : undefined;

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
    const api = bot.api as unknown as {
      setMyCommands?: (commands: []) => Promise<unknown>;
    };
    if (typeof api.setMyCommands === "function") {
      api.setMyCommands([]).catch((err) => {
        runtime.error?.(danger(`telegram clear commands failed: ${String(err)}`));
      });
    } else {
      logVerbose("telegram: setMyCommands unavailable; skipping clear");
    }
  }
};
