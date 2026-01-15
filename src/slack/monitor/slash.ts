import type { SlackActionMiddlewareArgs, SlackCommandMiddlewareArgs } from "@slack/bolt";
import type { ChatCommandDefinition, CommandArgs } from "../../auto-reply/commands-registry.js";
import { resolveEffectiveMessagesConfig } from "../../agents/identity.js";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listNativeCommandSpecsForConfig,
  parseCommandArgs,
  resolveCommandArgMenu,
} from "../../auto-reply/commands-registry.js";
import { dispatchReplyWithDispatcher } from "../../auto-reply/reply/provider-dispatcher.js";
import { resolveNativeCommandsEnabled } from "../../config/commands.js";
import { danger, logVerbose } from "../../globals.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";

import type { ResolvedSlackAccount } from "../accounts.js";

import {
  allowListMatches,
  normalizeAllowList,
  normalizeAllowListLower,
  resolveSlackUserAllowed,
} from "./allow-list.js";
import { resolveSlackChannelConfig, type SlackChannelConfigResolved } from "./channel-config.js";
import { buildSlackSlashCommandMatcher, resolveSlackSlashCommandConfig } from "./commands.js";
import type { SlackMonitorContext } from "./context.js";
import { isSlackRoomAllowedByPolicy } from "./policy.js";
import { deliverSlackSlashReplies } from "./replies.js";

type SlackBlock = { type: string; [key: string]: unknown };

const SLACK_COMMAND_ARG_ACTION_ID = "clawdbot_cmdarg";
const SLACK_COMMAND_ARG_VALUE_PREFIX = "cmdarg";

function chunkItems<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

function encodeSlackCommandArgValue(parts: {
  command: string;
  arg: string;
  value: string;
  userId: string;
}) {
  return [
    SLACK_COMMAND_ARG_VALUE_PREFIX,
    encodeURIComponent(parts.command),
    encodeURIComponent(parts.arg),
    encodeURIComponent(parts.value),
    encodeURIComponent(parts.userId),
  ].join("|");
}

function parseSlackCommandArgValue(raw?: string | null): {
  command: string;
  arg: string;
  value: string;
  userId: string;
} | null {
  if (!raw) return null;
  const parts = raw.split("|");
  if (parts.length !== 5 || parts[0] !== SLACK_COMMAND_ARG_VALUE_PREFIX) return null;
  const [, command, arg, value, userId] = parts;
  if (!command || !arg || !value || !userId) return null;
  const decode = (text: string) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return null;
    }
  };
  const decodedCommand = decode(command);
  const decodedArg = decode(arg);
  const decodedValue = decode(value);
  const decodedUserId = decode(userId);
  if (!decodedCommand || !decodedArg || !decodedValue || !decodedUserId) return null;
  return {
    command: decodedCommand,
    arg: decodedArg,
    value: decodedValue,
    userId: decodedUserId,
  };
}

function buildSlackCommandArgMenuBlocks(params: {
  title: string;
  command: string;
  arg: string;
  choices: string[];
  userId: string;
}) {
  const rows = chunkItems(params.choices, 5).map((choices) => ({
    type: "actions",
    elements: choices.map((choice) => ({
      type: "button",
      action_id: SLACK_COMMAND_ARG_ACTION_ID,
      text: { type: "plain_text", text: choice },
      value: encodeSlackCommandArgValue({
        command: params.command,
        arg: params.arg,
        value: choice,
        userId: params.userId,
      }),
    })),
  }));
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: params.title },
    },
    ...rows,
  ];
}

export function registerSlackMonitorSlashCommands(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
}) {
  const { ctx, account } = params;
  const cfg = ctx.cfg;
  const runtime = ctx.runtime;

  const supportsInteractiveArgMenus =
    typeof (ctx.app as { action?: unknown }).action === "function";

  const slashCommand = resolveSlackSlashCommandConfig(
    ctx.slashCommand ?? account.config.slashCommand,
  );

  const handleSlashCommand = async (p: {
    command: SlackCommandMiddlewareArgs["command"];
    ack: SlackCommandMiddlewareArgs["ack"];
    respond: SlackCommandMiddlewareArgs["respond"];
    prompt: string;
    commandArgs?: CommandArgs;
    commandDefinition?: ChatCommandDefinition;
  }) => {
    const { command, ack, respond, prompt, commandArgs, commandDefinition } = p;
    try {
      if (!prompt.trim()) {
        await ack({
          text: "Message required.",
          response_type: "ephemeral",
        });
        return;
      }
      await ack();

      if (ctx.botUserId && command.user_id === ctx.botUserId) return;

      const channelInfo = await ctx.resolveChannelName(command.channel_id);
      const channelType =
        channelInfo?.type ?? (command.channel_name === "directmessage" ? "im" : undefined);
      const isDirectMessage = channelType === "im";
      const isGroupDm = channelType === "mpim";
      const isRoom = channelType === "channel" || channelType === "group";

      if (
        !ctx.isChannelAllowed({
          channelId: command.channel_id,
          channelName: channelInfo?.name,
          channelType,
        })
      ) {
        await respond({
          text: "This channel is not allowed.",
          response_type: "ephemeral",
        });
        return;
      }

      const storeAllowFrom = await readChannelAllowFromStore("slack").catch(() => []);
      const effectiveAllowFrom = normalizeAllowList([...ctx.allowFrom, ...storeAllowFrom]);
      const effectiveAllowFromLower = normalizeAllowListLower(effectiveAllowFrom);

      let commandAuthorized = true;
      let channelConfig: SlackChannelConfigResolved | null = null;
      if (isDirectMessage) {
        if (!ctx.dmEnabled || ctx.dmPolicy === "disabled") {
          await respond({
            text: "Slack DMs are disabled.",
            response_type: "ephemeral",
          });
          return;
        }
        if (ctx.dmPolicy !== "open") {
          const sender = await ctx.resolveUserName(command.user_id);
          const senderName = sender?.name ?? undefined;
          const permitted = allowListMatches({
            allowList: effectiveAllowFromLower,
            id: command.user_id,
            name: senderName,
          });
          if (!permitted) {
            if (ctx.dmPolicy === "pairing") {
              const { code, created } = await upsertChannelPairingRequest({
                channel: "slack",
                id: command.user_id,
                meta: { name: senderName },
              });
              if (created) {
                await respond({
                  text: buildPairingReply({
                    channel: "slack",
                    idLine: `Your Slack user id: ${command.user_id}`,
                    code,
                  }),
                  response_type: "ephemeral",
                });
              }
            } else {
              await respond({
                text: "You are not authorized to use this command.",
                response_type: "ephemeral",
              });
            }
            return;
          }
          commandAuthorized = true;
        }
      }

      if (isRoom) {
        channelConfig = resolveSlackChannelConfig({
          channelId: command.channel_id,
          channelName: channelInfo?.name,
          channels: ctx.channelsConfig,
          defaultRequireMention: ctx.defaultRequireMention,
        });
        if (ctx.useAccessGroups) {
          const channelAllowlistConfigured =
            Boolean(ctx.channelsConfig) && Object.keys(ctx.channelsConfig ?? {}).length > 0;
          const channelAllowed = channelConfig?.allowed !== false;
          if (
            !isSlackRoomAllowedByPolicy({
              groupPolicy: ctx.groupPolicy,
              channelAllowlistConfigured,
              channelAllowed,
            }) ||
            !channelAllowed
          ) {
            await respond({
              text: "This channel is not allowed.",
              response_type: "ephemeral",
            });
            return;
          }
        }
        if (ctx.useAccessGroups && channelConfig?.allowed === false) {
          await respond({
            text: "This channel is not allowed.",
            response_type: "ephemeral",
          });
          return;
        }
      }

      const sender = await ctx.resolveUserName(command.user_id);
      const senderName = sender?.name ?? command.user_name ?? command.user_id;
      const channelUserAllowed = isRoom
        ? resolveSlackUserAllowed({
            allowList: channelConfig?.users,
            userId: command.user_id,
            userName: senderName,
          })
        : true;
      if (isRoom && !channelUserAllowed) {
        await respond({
          text: "You are not authorized to use this command here.",
          response_type: "ephemeral",
        });
        return;
      }

      if (commandDefinition && supportsInteractiveArgMenus) {
        const menu = resolveCommandArgMenu({
          command: commandDefinition,
          args: commandArgs,
          cfg,
        });
        if (menu) {
          const commandLabel = commandDefinition.nativeName ?? commandDefinition.key;
          const title =
            menu.title ?? `Choose ${menu.arg.description || menu.arg.name} for /${commandLabel}.`;
          const blocks = buildSlackCommandArgMenuBlocks({
            title,
            command: commandLabel,
            arg: menu.arg.name,
            choices: menu.choices,
            userId: command.user_id,
          });
          await respond({
            text: title,
            blocks,
            response_type: "ephemeral",
          });
          return;
        }
      }

      const channelName = channelInfo?.name;
      const roomLabel = channelName ? `#${channelName}` : `#${command.channel_id}`;
      const isRoomish = isRoom || isGroupDm;
      const route = resolveAgentRoute({
        cfg,
        channel: "slack",
        accountId: account.accountId,
        teamId: ctx.teamId || undefined,
        peer: {
          kind: isDirectMessage ? "dm" : isRoom ? "channel" : "group",
          id: isDirectMessage ? command.user_id : command.channel_id,
        },
      });

      const channelDescription = [channelInfo?.topic, channelInfo?.purpose]
        .map((entry) => entry?.trim())
        .filter((entry): entry is string => Boolean(entry))
        .filter((entry, index, list) => list.indexOf(entry) === index)
        .join("\n");
      const systemPromptParts = [
        channelDescription ? `Channel description: ${channelDescription}` : null,
        channelConfig?.systemPrompt?.trim() || null,
      ].filter((entry): entry is string => Boolean(entry));
      const groupSystemPrompt =
        systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;

      const ctxPayload = {
        Body: prompt,
        CommandArgs: commandArgs,
        From: isDirectMessage
          ? `slack:${command.user_id}`
          : isRoom
            ? `slack:channel:${command.channel_id}`
            : `slack:group:${command.channel_id}`,
        To: `slash:${command.user_id}`,
        ChatType: isDirectMessage ? "direct" : isRoom ? "room" : "group",
        GroupSubject: isRoomish ? roomLabel : undefined,
        GroupSystemPrompt: isRoomish ? groupSystemPrompt : undefined,
        SenderName: senderName,
        SenderId: command.user_id,
        Provider: "slack" as const,
        Surface: "slack" as const,
        WasMentioned: true,
        MessageSid: command.trigger_id,
        Timestamp: Date.now(),
        SessionKey: `agent:${route.agentId}:${slashCommand.sessionPrefix}:${command.user_id}`,
        CommandTargetSessionKey: route.sessionKey,
        AccountId: route.accountId,
        CommandSource: "native" as const,
        CommandAuthorized: commandAuthorized,
        OriginatingChannel: "slack" as const,
        OriginatingTo: `user:${command.user_id}`,
      };

      const { counts } = await dispatchReplyWithDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId).responsePrefix,
          deliver: async (payload) => {
            await deliverSlackSlashReplies({
              replies: [payload],
              respond,
              ephemeral: slashCommand.ephemeral,
              textLimit: ctx.textLimit,
            });
          },
          onError: (err, info) => {
            runtime.error?.(danger(`slack slash ${info.kind} reply failed: ${String(err)}`));
          },
        },
        replyOptions: { skillFilter: channelConfig?.skills },
      });
      if (counts.final + counts.tool + counts.block === 0) {
        await deliverSlackSlashReplies({
          replies: [],
          respond,
          ephemeral: slashCommand.ephemeral,
          textLimit: ctx.textLimit,
        });
      }
    } catch (err) {
      runtime.error?.(danger(`slack slash handler failed: ${String(err)}`));
      await respond({
        text: "Sorry, something went wrong handling that command.",
        response_type: "ephemeral",
      });
    }
  };

  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "slack",
    providerSetting: account.config.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const nativeCommands = nativeEnabled ? listNativeCommandSpecsForConfig(cfg) : [];
  if (nativeCommands.length > 0) {
    for (const command of nativeCommands) {
      ctx.app.command(
        `/${command.name}`,
        async ({ command: cmd, ack, respond }: SlackCommandMiddlewareArgs) => {
          const commandDefinition = findCommandByNativeName(command.name);
          const rawText = cmd.text?.trim() ?? "";
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
          await handleSlashCommand({
            command: cmd,
            ack,
            respond,
            prompt,
            commandArgs,
            commandDefinition: commandDefinition ?? undefined,
          });
        },
      );
    }
  } else if (slashCommand.enabled) {
    ctx.app.command(
      buildSlackSlashCommandMatcher(slashCommand.name),
      async ({ command, ack, respond }: SlackCommandMiddlewareArgs) => {
        await handleSlashCommand({
          command,
          ack,
          respond,
          prompt: command.text?.trim() ?? "",
        });
      },
    );
  } else {
    logVerbose("slack: slash commands disabled");
  }

  if (nativeCommands.length === 0 || !supportsInteractiveArgMenus) return;

  (
    ctx.app as unknown as { action: NonNullable<(typeof ctx.app & { action?: unknown })["action"]> }
  ).action(SLACK_COMMAND_ARG_ACTION_ID, async (args: SlackActionMiddlewareArgs) => {
    const { ack, body, respond } = args;
    const action = args.action as { value?: string };
    await ack();
    const respondFn =
      respond ??
      (async (payload: { text: string; blocks?: SlackBlock[]; response_type?: string }) => {
        if (!body.channel?.id || !body.user?.id) return;
        await ctx.app.client.chat.postEphemeral({
          token: ctx.botToken,
          channel: body.channel.id,
          user: body.user.id,
          text: payload.text,
          blocks: payload.blocks,
        });
      });
    const parsed = parseSlackCommandArgValue(action?.value);
    if (!parsed) {
      await respondFn({
        text: "Sorry, that button is no longer valid.",
        response_type: "ephemeral",
      });
      return;
    }
    if (body.user?.id && parsed.userId !== body.user.id) {
      await respondFn({
        text: "That menu is for another user.",
        response_type: "ephemeral",
      });
      return;
    }
    const commandDefinition = findCommandByNativeName(parsed.command);
    const commandArgs: CommandArgs = {
      values: { [parsed.arg]: parsed.value },
    };
    const prompt = commandDefinition
      ? buildCommandTextFromArgs(commandDefinition, commandArgs)
      : `/${parsed.command} ${parsed.value}`;
    const user = body.user;
    const userName =
      user && "name" in user && user.name
        ? user.name
        : user && "username" in user && user.username
          ? user.username
          : (user?.id ?? "");
    const triggerId = "trigger_id" in body ? body.trigger_id : undefined;
    const commandPayload = {
      user_id: user?.id ?? "",
      user_name: userName,
      channel_id: body.channel?.id ?? "",
      channel_name: body.channel?.name ?? body.channel?.id ?? "",
      trigger_id: triggerId ?? String(Date.now()),
    } as SlackCommandMiddlewareArgs["command"];
    await handleSlashCommand({
      command: commandPayload,
      ack: async () => {},
      respond: respondFn as SlackCommandMiddlewareArgs["respond"],
      prompt,
      commandArgs,
      commandDefinition: commandDefinition ?? undefined,
    });
  });
}
