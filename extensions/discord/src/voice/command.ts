import {
  ChannelType as CarbonChannelType,
  Command,
  CommandWithSubcommands,
  type CommandInteraction,
  type CommandOptions,
} from "@buape/carbon";
import {
  ApplicationCommandOptionType,
  ChannelType as DiscordChannelType,
  type APIApplicationCommandChannelOption,
} from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatMention } from "../mentions.js";
import { normalizeDiscordSlug } from "../monitor/allow-list.js";
import { resolveDiscordChannelInfo } from "../monitor/message-utils.js";
import { resolveDiscordSenderIdentity } from "../monitor/sender-identity.js";
import { resolveDiscordThreadParentInfo } from "../monitor/threading.js";
import { authorizeDiscordVoiceIngress } from "./access.js";
import type { DiscordVoiceManager } from "./manager.js";

const VOICE_CHANNEL_TYPES: NonNullable<APIApplicationCommandChannelOption["channel_types"]> = [
  DiscordChannelType.GuildVoice,
  DiscordChannelType.GuildStageVoice,
];

type VoiceCommandContext = {
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  accountId: string;
  groupPolicy: "open" | "disabled" | "allowlist";
  useAccessGroups: boolean;
  getManager: () => DiscordVoiceManager | null;
  ephemeralDefault: boolean;
};

type VoiceCommandChannelOverride = {
  id: string;
  name?: string;
  parentId?: string;
};

type VoiceCommandRuntimeContext = {
  guildId: string;
  manager: DiscordVoiceManager;
};

async function authorizeVoiceCommand(
  interaction: CommandInteraction,
  params: VoiceCommandContext,
  options?: { channelOverride?: VoiceCommandChannelOverride },
): Promise<{ ok: boolean; message?: string; guildId?: string }> {
  const channelOverride = options?.channelOverride;
  const channel = channelOverride ? undefined : interaction.channel;
  if (!interaction.guild) {
    return { ok: false, message: "Voice commands are only available in guilds." };
  }
  const user = interaction.user;
  if (!user) {
    return { ok: false, message: "Unable to resolve command user." };
  }

  const channelId = channelOverride?.id ?? channel?.id ?? "";
  const rawChannelName =
    channelOverride?.name ?? (channel && "name" in channel ? (channel.name as string) : undefined);
  const rawParentId =
    channelOverride?.parentId ??
    ("parentId" in (channel ?? {})
      ? ((channel as { parentId?: string }).parentId ?? undefined)
      : undefined);
  const channelInfo = channelId
    ? await resolveDiscordChannelInfo(interaction.client, channelId)
    : null;
  const channelName = rawChannelName ?? channelInfo?.name;
  const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const isThreadChannel =
    channelInfo?.type === CarbonChannelType.PublicThread ||
    channelInfo?.type === CarbonChannelType.PrivateThread ||
    channelInfo?.type === CarbonChannelType.AnnouncementThread;
  let parentId: string | undefined;
  let parentName: string | undefined;
  let parentSlug: string | undefined;
  if (isThreadChannel && channelId) {
    const parentInfo = await resolveDiscordThreadParentInfo({
      client: interaction.client,
      threadChannel: {
        id: channelId,
        name: channelName,
        parentId: rawParentId ?? channelInfo?.parentId,
        parent: undefined,
      },
      channelInfo,
    });
    parentId = parentInfo.id;
    parentName = parentInfo.name;
    parentSlug = parentName ? normalizeDiscordSlug(parentName) : undefined;
  }

  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.map((roleId: string) => roleId)
    : [];
  const sender = resolveDiscordSenderIdentity({ author: user, member: interaction.rawData.member });
  const access = await authorizeDiscordVoiceIngress({
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    groupPolicy: params.groupPolicy,
    useAccessGroups: params.useAccessGroups,
    guild: interaction.guild,
    guildId: interaction.guild.id,
    channelId,
    channelName,
    channelSlug,
    parentId,
    parentName,
    parentSlug,
    scope: isThreadChannel ? "thread" : "channel",
    channelLabel: channelId ? formatMention({ channelId }) : "This channel",
    memberRoleIds,
    sender: {
      id: sender.id,
      name: sender.name,
      tag: sender.tag,
    },
  });
  if (!access.ok) {
    return { ok: false, message: access.message };
  }

  return { ok: true, guildId: interaction.guild.id };
}

async function resolveVoiceCommandRuntimeContext(
  interaction: CommandInteraction,
  params: Pick<VoiceCommandContext, "getManager">,
): Promise<VoiceCommandRuntimeContext | null> {
  const guildId = interaction.guild?.id;
  if (!guildId) {
    await interaction.reply({
      content: "Unable to resolve guild for this command.",
      ephemeral: true,
    });
    return null;
  }
  const manager = params.getManager();
  if (!manager) {
    await interaction.reply({
      content: "Voice manager is not available yet.",
      ephemeral: true,
    });
    return null;
  }
  return { guildId, manager };
}

async function ensureVoiceCommandAccess(params: {
  interaction: CommandInteraction;
  context: VoiceCommandContext;
  channelOverride?: VoiceCommandChannelOverride;
}): Promise<boolean> {
  const access = await authorizeVoiceCommand(params.interaction, params.context, {
    channelOverride: params.channelOverride,
  });
  if (access.ok) {
    return true;
  }
  await params.interaction.reply({
    content: access.message ?? "Not authorized.",
    ephemeral: true,
  });
  return false;
}

export function createDiscordVoiceCommand(params: VoiceCommandContext): CommandWithSubcommands {
  const resolveSessionChannelId = (manager: DiscordVoiceManager, guildId: string) =>
    manager.status().find((entry) => entry.guildId === guildId)?.channelId;

  class JoinCommand extends Command {
    name = "join";
    description = "Join a voice channel";
    defer = true;
    ephemeral = params.ephemeralDefault;
    options: CommandOptions = [
      {
        name: "channel",
        description: "Voice channel to join",
        type: ApplicationCommandOptionType.Channel,
        required: true,
        channel_types: VOICE_CHANNEL_TYPES,
      },
    ];

    async run(interaction: CommandInteraction) {
      const channel = await interaction.options.getChannel("channel", true);
      if (!channel || !("id" in channel)) {
        await interaction.reply({ content: "Voice channel not found.", ephemeral: true });
        return;
      }

      const access = await authorizeVoiceCommand(interaction, params, {
        channelOverride: {
          id: channel.id,
          name: "name" in channel ? (channel.name as string) : undefined,
          parentId:
            "parentId" in channel
              ? ((channel as { parentId?: string }).parentId ?? undefined)
              : undefined,
        },
      });
      if (!access.ok) {
        await interaction.reply({ content: access.message ?? "Not authorized.", ephemeral: true });
        return;
      }
      if (!isVoiceChannelType(channel.type)) {
        await interaction.reply({ content: "That is not a voice channel.", ephemeral: true });
        return;
      }
      const guildId = access.guildId ?? ("guildId" in channel ? channel.guildId : undefined);
      if (!guildId) {
        await interaction.reply({
          content: "Unable to resolve guild for this voice channel.",
          ephemeral: true,
        });
        return;
      }

      const manager = params.getManager();
      if (!manager) {
        await interaction.reply({
          content: "Voice manager is not available yet.",
          ephemeral: true,
        });
        return;
      }

      const result = await manager.join({ guildId, channelId: channel.id });
      await interaction.reply({ content: result.message, ephemeral: true });
    }
  }

  class LeaveCommand extends Command {
    name = "leave";
    description = "Leave the current voice channel";
    defer = true;
    ephemeral = params.ephemeralDefault;

    async run(interaction: CommandInteraction) {
      const runtimeContext = await resolveVoiceCommandRuntimeContext(interaction, params);
      if (!runtimeContext) {
        return;
      }
      const sessionChannelId = resolveSessionChannelId(
        runtimeContext.manager,
        runtimeContext.guildId,
      );
      const authorized = await ensureVoiceCommandAccess({
        interaction,
        context: params,
        channelOverride: sessionChannelId ? { id: sessionChannelId } : undefined,
      });
      if (!authorized) {
        return;
      }
      const result = await runtimeContext.manager.leave({ guildId: runtimeContext.guildId });
      await interaction.reply({ content: result.message, ephemeral: true });
    }
  }

  class StatusCommand extends Command {
    name = "status";
    description = "Show active voice sessions";
    defer = true;
    ephemeral = params.ephemeralDefault;

    async run(interaction: CommandInteraction) {
      const runtimeContext = await resolveVoiceCommandRuntimeContext(interaction, params);
      if (!runtimeContext) {
        return;
      }
      const sessions = runtimeContext.manager
        .status()
        .filter((entry) => entry.guildId === runtimeContext.guildId);
      const sessionChannelId = sessions[0]?.channelId;
      const authorized = await ensureVoiceCommandAccess({
        interaction,
        context: params,
        channelOverride: sessionChannelId ? { id: sessionChannelId } : undefined,
      });
      if (!authorized) {
        return;
      }
      if (sessions.length === 0) {
        await interaction.reply({ content: "No active voice sessions.", ephemeral: true });
        return;
      }
      const lines = sessions.map(
        (entry) => `• ${formatMention({ channelId: entry.channelId })} (guild ${entry.guildId})`,
      );
      await interaction.reply({ content: lines.join("\n"), ephemeral: true });
    }
  }

  return new (class extends CommandWithSubcommands {
    name = "vc";
    description = "Voice channel controls";
    subcommands = [new JoinCommand(), new LeaveCommand(), new StatusCommand()];
  })();
}

function isVoiceChannelType(type: CarbonChannelType) {
  return type === CarbonChannelType.GuildVoice || type === CarbonChannelType.GuildStageVoice;
}
