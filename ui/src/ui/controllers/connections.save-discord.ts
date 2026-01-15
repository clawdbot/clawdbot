import { parseList } from "../format";
import {
  defaultDiscordActions,
  type DiscordActionForm,
  type DiscordGuildChannelForm,
  type DiscordGuildForm,
} from "../ui-types";
import type { ConnectionsState } from "./connections.types";

export async function saveDiscordConfig(state: ConnectionsState) {
  if (!state.client || !state.connected) return;
  if (state.discordSaving) return;
  state.discordSaving = true;
  state.discordConfigStatus = null;
  try {
    const baseHash = state.configSnapshot?.hash;
    if (!baseHash) {
      state.discordConfigStatus = "Config hash missing; reload and retry.";
      return;
    }
    const discord: Record<string, unknown> = {};
    const form = state.discordForm;

    if (form.enabled) {
      discord.enabled = null;
    } else {
      discord.enabled = false;
    }

    if (!state.discordTokenLocked) {
      const token = form.token.trim();
      discord.token = token || null;
    }

    const allowFrom = parseList(form.allowFrom);
    const groupChannels = parseList(form.groupChannels);
    const dm: Record<string, unknown> = {
      enabled: form.dmEnabled ? null : false,
      allowFrom: allowFrom.length > 0 ? allowFrom : null,
      groupEnabled: form.groupEnabled ? true : null,
      groupChannels: groupChannels.length > 0 ? groupChannels : null,
    };
    discord.dm = dm;

    const mediaMaxMb = Number(form.mediaMaxMb);
    if (Number.isFinite(mediaMaxMb) && mediaMaxMb > 0) {
      discord.mediaMaxMb = mediaMaxMb;
    } else {
      discord.mediaMaxMb = null;
    }

    const historyLimitRaw = form.historyLimit.trim();
    if (historyLimitRaw.length === 0) {
      discord.historyLimit = null;
    } else {
      const historyLimit = Number(historyLimitRaw);
      if (Number.isFinite(historyLimit) && historyLimit >= 0) {
        discord.historyLimit = historyLimit;
      } else {
        discord.historyLimit = null;
      }
    }

    const chunkLimitRaw = form.textChunkLimit.trim();
    if (chunkLimitRaw.length === 0) {
      discord.textChunkLimit = null;
    } else {
      const chunkLimit = Number(chunkLimitRaw);
      if (Number.isFinite(chunkLimit) && chunkLimit > 0) {
        discord.textChunkLimit = chunkLimit;
      } else {
        discord.textChunkLimit = null;
      }
    }

    if (form.replyToMode === "off") {
      discord.replyToMode = null;
    } else {
      discord.replyToMode = form.replyToMode;
    }

    const guildsForm = Array.isArray(form.guilds) ? form.guilds : [];
    const guilds: Record<string, unknown> = {};
    guildsForm.forEach((guild: DiscordGuildForm) => {
      const key = String(guild.key ?? "").trim();
      if (!key) return;
      const entry: Record<string, unknown> = {};
      const slug = String(guild.slug ?? "").trim();
      if (slug) entry.slug = slug;
      if (guild.requireMention) entry.requireMention = true;
      if (
        guild.reactionNotifications === "off" ||
        guild.reactionNotifications === "all" ||
        guild.reactionNotifications === "own" ||
        guild.reactionNotifications === "allowlist"
      ) {
        entry.reactionNotifications = guild.reactionNotifications;
      }
      const users = parseList(guild.users);
      if (users.length > 0) entry.users = users;
      const channels: Record<string, unknown> = {};
      const channelForms = Array.isArray(guild.channels) ? guild.channels : [];
      channelForms.forEach((channel: DiscordGuildChannelForm) => {
        const channelKey = String(channel.key ?? "").trim();
        if (!channelKey) return;
        const channelEntry: Record<string, unknown> = {};
        if (channel.allow === false) channelEntry.allow = false;
        if (channel.requireMention) channelEntry.requireMention = true;
        channels[channelKey] = channelEntry;
      });
      if (Object.keys(channels).length > 0) entry.channels = channels;
      guilds[key] = entry;
    });
    if (Object.keys(guilds).length > 0) discord.guilds = guilds;
    else discord.guilds = null;

    const actions: Partial<DiscordActionForm> = {};
    const applyAction = (key: keyof DiscordActionForm) => {
      const value = form.actions[key];
      if (value !== defaultDiscordActions[key]) actions[key] = value;
    };
    applyAction("reactions");
    applyAction("stickers");
    applyAction("polls");
    applyAction("permissions");
    applyAction("messages");
    applyAction("threads");
    applyAction("pins");
    applyAction("search");
    applyAction("memberInfo");
    applyAction("roleInfo");
    applyAction("channelInfo");
    applyAction("voiceStatus");
    applyAction("events");
    applyAction("roles");
    applyAction("moderation");
    if (Object.keys(actions).length > 0) {
      discord.actions = actions;
    } else {
      discord.actions = null;
    }

    const slash = { ...(discord.slashCommand ?? {}) } as Record<string, unknown>;
    if (form.slashEnabled) {
      slash.enabled = true;
    } else {
      slash.enabled = null;
    }
    if (form.slashName.trim()) slash.name = form.slashName.trim();
    else slash.name = null;
    if (form.slashSessionPrefix.trim())
      slash.sessionPrefix = form.slashSessionPrefix.trim();
    else slash.sessionPrefix = null;
    if (form.slashEphemeral) {
      slash.ephemeral = null;
    } else {
      slash.ephemeral = false;
    }
    discord.slashCommand = Object.keys(slash).length > 0 ? slash : null;

    const raw = `${JSON.stringify(
      { channels: { discord } },
      null,
      2,
    ).trimEnd()}\n`;
    await state.client.request("config.patch", { raw, baseHash });
    state.discordConfigStatus = "Saved. Restart gateway if needed.";
  } catch (err) {
    state.discordConfigStatus = String(err);
  } finally {
    state.discordSaving = false;
  }
}
