import {
  ChannelType,
  Command,
  type CommandInteraction,
  type CommandOptions,
} from "@buape/carbon";
import { ApplicationCommandOptionType } from "discord-api-types/v10";

import {
  resolveEffectiveMessagesConfig,
  resolveHumanDelayConfig,
} from "../../agents/identity.js";
import { resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import { buildCommandText } from "../../auto-reply/commands-registry.js";
import { dispatchReplyWithDispatcher } from "../../auto-reply/reply/provider-dispatcher.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ClawdbotConfig, loadConfig } from "../../config/config.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { loadWebMedia } from "../../web/media.js";
import { chunkDiscordText } from "../chunk.js";
import {
  allowListMatches,
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordChannelConfig,
  resolveDiscordGuildEntry,
  resolveDiscordUserAllowed,
} from "./allow-list.js";
import { formatDiscordUserTag } from "./format.js";

type DiscordConfig = NonNullable<ClawdbotConfig["channels"]>["discord"];

export function createDiscordNativeCommand(params: {
  command: {
    name: string;
    description: string;
    acceptsArgs: boolean;
  };
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  ephemeralDefault: boolean;
}) {
  const {
    command,
    cfg,
    discordConfig,
    accountId,
    sessionPrefix,
    ephemeralDefault,
  } = params;
  return new (class extends Command {
    name = command.name;
    description = command.description;
    defer = true;
    ephemeral = ephemeralDefault;
    options = command.acceptsArgs
      ? ([
          {
            name: "input",
            description: "Command input",
            type: ApplicationCommandOptionType.String,
            required: false,
          },
        ] satisfies CommandOptions)
      : undefined;

    async run(interaction: CommandInteraction) {
      const useAccessGroups = cfg.commands?.useAccessGroups !== false;
      const user = interaction.user;
      if (!user) return;
      const channel = interaction.channel;
      const channelType = channel?.type;
      const isDirectMessage = channelType === ChannelType.DM;
      const isGroupDm = channelType === ChannelType.GroupDM;
      const channelName =
        channel && "name" in channel ? (channel.name as string) : undefined;
      const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
      const prompt = buildCommandText(
        this.name,
        command.acceptsArgs
          ? interaction.options.getString("input")
          : undefined,
      );
      const guildInfo = resolveDiscordGuildEntry({
        guild: interaction.guild ?? undefined,
        guildEntries: discordConfig?.guilds,
      });
      const channelConfig = interaction.guild
        ? resolveDiscordChannelConfig({
            guildInfo,
            channelId: channel?.id ?? "",
            channelName,
            channelSlug,
          })
        : null;
      if (channelConfig?.enabled === false) {
        await interaction.reply({
          content: "This channel is disabled.",
        });
        return;
      }
      if (interaction.guild && channelConfig?.allowed === false) {
        await interaction.reply({
          content: "This channel is not allowed.",
        });
        return;
      }
      if (useAccessGroups && interaction.guild) {
        const channelAllowlistConfigured =
          Boolean(guildInfo?.channels) &&
          Object.keys(guildInfo?.channels ?? {}).length > 0;
        const channelAllowed = channelConfig?.allowed !== false;
        const allowByPolicy = isDiscordGroupAllowedByPolicy({
          groupPolicy: discordConfig?.groupPolicy ?? "open",
          channelAllowlistConfigured,
          channelAllowed,
        });
        if (!allowByPolicy) {
          await interaction.reply({
            content: "This channel is not allowed.",
          });
          return;
        }
      }
      const dmEnabled = discordConfig?.dm?.enabled ?? true;
      const dmPolicy = discordConfig?.dm?.policy ?? "pairing";
      let commandAuthorized = true;
      if (isDirectMessage) {
        if (!dmEnabled || dmPolicy === "disabled") {
          await interaction.reply({ content: "Discord DMs are disabled." });
          return;
        }
        if (dmPolicy !== "open") {
          const storeAllowFrom = await readChannelAllowFromStore(
            "discord",
          ).catch(() => []);
          const effectiveAllowFrom = [
            ...(discordConfig?.dm?.allowFrom ?? []),
            ...storeAllowFrom,
          ];
          const allowList = normalizeDiscordAllowList(effectiveAllowFrom, [
            "discord:",
            "user:",
          ]);
          const permitted = allowList
            ? allowListMatches(allowList, {
                id: user.id,
                name: user.username,
                tag: formatDiscordUserTag(user),
              })
            : false;
          if (!permitted) {
            commandAuthorized = false;
            if (dmPolicy === "pairing") {
              const { code, created } = await upsertChannelPairingRequest({
                channel: "discord",
                id: user.id,
                meta: {
                  tag: formatDiscordUserTag(user),
                  name: user.username ?? undefined,
                },
              });
              if (created) {
                await interaction.reply({
                  content: buildPairingReply({
                    channel: "discord",
                    idLine: `Your Discord user id: ${user.id}`,
                    code,
                  }),
                  ephemeral: true,
                });
              }
            } else {
              await interaction.reply({
                content: "You are not authorized to use this command.",
                ephemeral: true,
              });
            }
            return;
          }
          commandAuthorized = true;
        }
      }
      if (!isDirectMessage) {
        const channelUsers = channelConfig?.users ?? guildInfo?.users;
        if (Array.isArray(channelUsers) && channelUsers.length > 0) {
          const userOk = resolveDiscordUserAllowed({
            allowList: channelUsers,
            userId: user.id,
            userName: user.username,
            userTag: formatDiscordUserTag(user),
          });
          if (!userOk) {
            await interaction.reply({
              content: "You are not authorized to use this command.",
            });
            return;
          }
        }
      }
      if (isGroupDm && discordConfig?.dm?.groupEnabled === false) {
        await interaction.reply({ content: "Discord group DMs are disabled." });
        return;
      }

      const isGuild = Boolean(interaction.guild);
      const channelId = channel?.id ?? "unknown";
      const interactionId = interaction.rawData.id;
      const route = resolveAgentRoute({
        cfg,
        channel: "discord",
        accountId,
        guildId: interaction.guild?.id ?? undefined,
        peer: {
          kind: isDirectMessage ? "dm" : isGroupDm ? "group" : "channel",
          id: isDirectMessage ? user.id : channelId,
        },
      });
      const ctxPayload = {
        Body: prompt,
        CommandBody: prompt,
        From: isDirectMessage ? `discord:${user.id}` : `group:${channelId}`,
        To: `slash:${user.id}`,
        SessionKey: `agent:${route.agentId}:${sessionPrefix}:${user.id}`,
        CommandTargetSessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: isDirectMessage ? "direct" : "group",
        GroupSubject: isGuild ? interaction.guild?.name : undefined,
        GroupSystemPrompt: isGuild
          ? (() => {
              const channelTopic =
                channel && "topic" in channel
                  ? (channel.topic ?? undefined)
                  : undefined;
              const channelDescription = channelTopic?.trim();
              const systemPromptParts = [
                channelDescription
                  ? `Channel topic: ${channelDescription}`
                  : null,
                channelConfig?.systemPrompt?.trim() || null,
              ].filter((entry): entry is string => Boolean(entry));
              return systemPromptParts.length > 0
                ? systemPromptParts.join("\n\n")
                : undefined;
            })()
          : undefined,
        SenderName: user.globalName ?? user.username,
        SenderId: user.id,
        SenderUsername: user.username,
        SenderTag: formatDiscordUserTag(user),
        Provider: "discord" as const,
        Surface: "discord" as const,
        WasMentioned: true,
        MessageSid: interactionId,
        Timestamp: Date.now(),
        CommandAuthorized: commandAuthorized,
        CommandSource: "native" as const,
      };

      let didReply = false;
      await dispatchReplyWithDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId)
            .responsePrefix,
          humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
          deliver: async (payload) => {
            await deliverDiscordInteractionReply({
              interaction,
              payload,
              textLimit: resolveTextChunkLimit(cfg, "discord", accountId, {
                fallbackLimit: 2000,
              }),
              maxLinesPerMessage: discordConfig?.maxLinesPerMessage,
              preferFollowUp: didReply,
            });
            didReply = true;
          },
          onError: (err, info) => {
            console.error(`discord slash ${info.kind} reply failed`, err);
          },
        },
        replyOptions: {
          skillFilter: channelConfig?.skills,
          disableBlockStreaming:
            typeof discordConfig?.blockStreaming === "boolean"
              ? !discordConfig.blockStreaming
              : undefined,
        },
      });
    }
  })();
}

async function deliverDiscordInteractionReply(params: {
  interaction: CommandInteraction;
  payload: ReplyPayload;
  textLimit: number;
  maxLinesPerMessage?: number;
  preferFollowUp: boolean;
}) {
  const {
    interaction,
    payload,
    textLimit,
    maxLinesPerMessage,
    preferFollowUp,
  } = params;
  const mediaList =
    payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
  const text = payload.text ?? "";

  let hasReplied = false;
  const sendMessage = async (
    content: string,
    files?: { name: string; data: Buffer }[],
  ) => {
    const payload =
      files && files.length > 0
        ? {
            content,
            files: files.map((file) => {
              if (file.data instanceof Blob) {
                return { name: file.name, data: file.data };
              }
              const arrayBuffer = Uint8Array.from(file.data).buffer;
              return { name: file.name, data: new Blob([arrayBuffer]) };
            }),
          }
        : { content };
    if (!preferFollowUp && !hasReplied) {
      await interaction.reply(payload);
      hasReplied = true;
      return;
    }
    await interaction.followUp(payload);
    hasReplied = true;
  };

  if (mediaList.length > 0) {
    const media = await Promise.all(
      mediaList.map(async (url) => {
        const loaded = await loadWebMedia(url);
        return {
          name: loaded.fileName ?? "upload",
          data: loaded.buffer,
        };
      }),
    );
    const chunks = chunkDiscordText(text, {
      maxChars: textLimit,
      maxLines: maxLinesPerMessage,
    });
    const caption = chunks[0] ?? "";
    await sendMessage(caption, media);
    for (const chunk of chunks.slice(1)) {
      if (!chunk.trim()) continue;
      await interaction.followUp({ content: chunk });
    }
    return;
  }

  if (!text.trim()) return;
  const chunks = chunkDiscordText(text, {
    maxChars: textLimit,
    maxLines: maxLinesPerMessage,
  });
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    await sendMessage(chunk);
  }
}
