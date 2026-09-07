import { ChannelType, PermissionFlagsBits } from "discord-api-types/v10";
import { reportChannelRoomJoin } from "openclaw/plugin-sdk/channel-join-intro-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { Guild, GuildCreateListener, type Client } from "../internal/discord.js";
import { readMessagesDiscord } from "../send.messages.js";
import { canViewDiscordGuildChannel, hasAnyChannelPermissionDiscord } from "../send.permissions.js";
import {
  normalizeDiscordDisplaySlug,
  normalizeDiscordSlug,
  resolveDiscordChannelConfig,
  resolveDiscordGuildEntry,
  type DiscordGuildEntryResolved,
} from "./allow-list.js";
import type { DiscordLivePolicyReader } from "./live-policy.js";
import { resolveDiscordPreflightChannelAccess } from "./message-handler.preflight-channel-access.js";

const DISCORD_GUILD_JOIN_INTRO_MAX_AGE_MS = 5 * 60 * 1_000;

export class DiscordGuildJoinIntroductionListener extends GuildCreateListener {
  constructor(
    private readonly params: {
      readPolicy?: DiscordLivePolicyReader;
      cfg: OpenClawConfig;
      accountId: string;
      botUserId?: string;
      groupPolicy: "open" | "allowlist" | "disabled";
      guildEntries?: Record<string, DiscordGuildEntryResolved>;
      logger?: Pick<ReturnType<typeof createSubsystemLogger>, "info">;
    },
  ) {
    super();
  }

  async handle(data: Parameters<GuildCreateListener["handle"]>[0], client: Client): Promise<void> {
    const policy = await this.params.readPolicy?.();
    const params = { ...this.params, ...policy };
    if (!("joined_at" in data) || data.unavailable || !params.botUserId) {
      return;
    }
    const joinAgeMs = Date.now() - Date.parse(data.joined_at);
    // Fresh joined_at excludes startup snapshots; the core durable claim suppresses reconnect replay.
    if (
      !Number.isFinite(joinAgeMs) ||
      joinAgeMs < 0 ||
      joinAgeMs > DISCORD_GUILD_JOIN_INTRO_MAX_AGE_MS
    ) {
      return;
    }

    const textChannels = data.channels.filter((channel) => channel.type === ChannelType.GuildText);
    const systemChannel = textChannels.find((channel) => channel.id === data.system_channel_id);
    const candidateChannels = systemChannel
      ? [systemChannel, ...textChannels.filter((channel) => channel !== systemChannel)]
      : textChannels;
    const discordOptions = {
      cfg: params.cfg,
      accountId: params.accountId,
      rest: client.rest,
    };
    const guildInfo = resolveDiscordGuildEntry({
      guild: new Guild(client, data),
      guildId: data.id,
      guildEntries: params.guildEntries,
    });
    const guildConfigured =
      !params.guildEntries || Object.keys(params.guildEntries).length === 0 || Boolean(guildInfo);
    let targetChannel: (typeof textChannels)[number] | undefined;
    let roomAllowed = false;
    for (const channel of candidateChannels) {
      if (
        (await canViewDiscordGuildChannel(data.id, channel.id, params.botUserId, discordOptions)) &&
        (await hasAnyChannelPermissionDiscord(
          data.id,
          channel.id,
          params.botUserId,
          [PermissionFlagsBits.SendMessages],
          discordOptions,
        ))
      ) {
        // Keep the first denied room for a recorded skip, but keep seeking an allowed destination.
        targetChannel ??= channel;
        const channelConfig = resolveDiscordChannelConfig({
          guildInfo,
          channelId: channel.id,
          channelName: channel.name,
          channelSlug: normalizeDiscordSlug(channel.name),
        });
        roomAllowed =
          guildConfigured &&
          resolveDiscordPreflightChannelAccess({
            isGuildMessage: true,
            isGroupDm: false,
            groupPolicy: params.groupPolicy,
            messageChannelId: channel.id,
            displayChannelName: channel.name,
            displayChannelSlug: normalizeDiscordDisplaySlug(channel.name),
            guildInfo,
            channelConfig,
            channelMatchMeta: `guild=${data.id} channel=${channel.id}`,
          }).allowed;
        if (roomAllowed) {
          targetChannel = channel;
          break;
        }
      }
    }
    if (policy?.isCurrent() === false) {
      params.logger?.info("Discord guild join introduction skipped: access policy changed", {
        guildId: data.id,
        accountId: params.accountId,
      });
      return;
    }
    if (!targetChannel) {
      params.logger?.info("Discord guild join introduction skipped: no writable text channel", {
        guildId: data.id,
        accountId: params.accountId,
      });
      return;
    }
    const selectedChannel = targetChannel;

    await reportChannelRoomJoin({
      cfg: params.cfg,
      channel: "discord",
      accountId: params.accountId,
      conversationId: data.id,
      deliverTo: `channel:${selectedChannel.id}`,
      route: resolveAgentRoute({
        cfg: params.cfg,
        channel: "discord",
        accountId: params.accountId,
        guildId: data.id,
        peer: { kind: "channel", id: selectedChannel.id },
      }),
      roomAllowed,
      resolveRoomContext: async ({ messageLimit }) => {
        const roomContext = {
          title: `#${selectedChannel.name}`,
          purpose: selectedChannel.topic ?? undefined,
        };
        try {
          const messages = await readMessagesDiscord(
            selectedChannel.id,
            { limit: messageLimit },
            discordOptions,
          );
          return {
            ...roomContext,
            recentMessages: messages
              .toReversed()
              .flatMap(({ author, content }) =>
                content.trim()
                  ? [{ sender: author.global_name ?? author.username, text: content }]
                  : [],
              ),
          };
        } catch {
          return roomContext;
        }
      },
    });
  }
}
