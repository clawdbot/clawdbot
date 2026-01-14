import type { GatewayBrowserClient } from "../gateway";
import { parseList } from "../format";
import type { ChannelsStatusSnapshot, ConfigSnapshot } from "../types";
import {
  defaultDiscordActions,
  defaultSlackActions,
  type DiscordActionForm,
  type DiscordForm,
  type DiscordGuildChannelForm,
  type DiscordGuildForm,
  type IMessageForm,
  type SlackActionForm,
  type SlackForm,
  type SignalForm,
  type TelegramForm,
} from "../ui-types";

export type ConnectionsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  channelsLoading: boolean;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  channelsError: string | null;
  channelsLastSuccess: number | null;
  whatsappLoginMessage: string | null;
  whatsappLoginQrDataUrl: string | null;
  whatsappLoginConnected: boolean | null;
  whatsappBusy: boolean;
  telegramForm: TelegramForm;
  telegramSaving: boolean;
  telegramTokenLocked: boolean;
  telegramConfigStatus: string | null;
  discordForm: DiscordForm;
  discordSaving: boolean;
  discordTokenLocked: boolean;
  discordConfigStatus: string | null;
  slackForm: SlackForm;
  slackSaving: boolean;
  slackTokenLocked: boolean;
  slackAppTokenLocked: boolean;
  slackConfigStatus: string | null;
  signalForm: SignalForm;
  signalSaving: boolean;
  signalConfigStatus: string | null;
  imessageForm: IMessageForm;
  imessageSaving: boolean;
  imessageConfigStatus: string | null;
  configSnapshot: ConfigSnapshot | null;
};

export async function loadChannels(state: ConnectionsState, probe: boolean) {
  if (!state.client || !state.connected) return;
  if (state.channelsLoading) return;
  state.channelsLoading = true;
  state.channelsError = null;
  try {
    const res = (await state.client.request("channels.status", {
      probe,
      timeoutMs: 8000,
    })) as ChannelsStatusSnapshot;
    state.channelsSnapshot = res;
    state.channelsLastSuccess = Date.now();
    const channels = res.channels as Record<string, unknown>;
    const telegram = channels.telegram as { tokenSource?: string | null };
    const discord = channels.discord as { tokenSource?: string | null } | null;
    const slack = channels.slack as
      | { botTokenSource?: string | null; appTokenSource?: string | null }
      | null;
    state.telegramTokenLocked = telegram?.tokenSource === "env";
    state.discordTokenLocked = discord?.tokenSource === "env";
    state.slackTokenLocked = slack?.botTokenSource === "env";
    state.slackAppTokenLocked = slack?.appTokenSource === "env";
  } catch (err) {
    state.channelsError = String(err);
  } finally {
    state.channelsLoading = false;
  }
}

export async function startWhatsAppLogin(state: ConnectionsState, force: boolean) {
  if (!state.client || !state.connected || state.whatsappBusy) return;
  state.whatsappBusy = true;
  try {
    const res = (await state.client.request("web.login.start", {
      force,
      timeoutMs: 30000,
    })) as { message?: string; qrDataUrl?: string };
    state.whatsappLoginMessage = res.message ?? null;
    state.whatsappLoginQrDataUrl = res.qrDataUrl ?? null;
    state.whatsappLoginConnected = null;
  } catch (err) {
    state.whatsappLoginMessage = String(err);
    state.whatsappLoginQrDataUrl = null;
    state.whatsappLoginConnected = null;
  } finally {
    state.whatsappBusy = false;
  }
}

export async function waitWhatsAppLogin(state: ConnectionsState) {
  if (!state.client || !state.connected || state.whatsappBusy) return;
  state.whatsappBusy = true;
  try {
    const res = (await state.client.request("web.login.wait", {
      timeoutMs: 120000,
    })) as { connected?: boolean; message?: string };
    state.whatsappLoginMessage = res.message ?? null;
    state.whatsappLoginConnected = res.connected ?? null;
    if (res.connected) state.whatsappLoginQrDataUrl = null;
  } catch (err) {
    state.whatsappLoginMessage = String(err);
    state.whatsappLoginConnected = null;
  } finally {
    state.whatsappBusy = false;
  }
}

export async function logoutWhatsApp(state: ConnectionsState) {
  if (!state.client || !state.connected || state.whatsappBusy) return;
  state.whatsappBusy = true;
  try {
    await state.client.request("channels.logout", { channel: "whatsapp" });
    state.whatsappLoginMessage = "Logged out.";
    state.whatsappLoginQrDataUrl = null;
    state.whatsappLoginConnected = null;
  } catch (err) {
    state.whatsappLoginMessage = String(err);
  } finally {
    state.whatsappBusy = false;
  }
}

export function updateTelegramForm(
  state: ConnectionsState,
  patch: Partial<TelegramForm>,
) {
  state.telegramForm = { ...state.telegramForm, ...patch };
}

export function updateDiscordForm(
  state: ConnectionsState,
  patch: Partial<DiscordForm>,
) {
  if (patch.actions) {
    state.discordForm = {
      ...state.discordForm,
      ...patch,
      actions: { ...state.discordForm.actions, ...patch.actions },
    };
    return;
  }
  state.discordForm = { ...state.discordForm, ...patch };
}

export function updateSlackForm(
  state: ConnectionsState,
  patch: Partial<SlackForm>,
) {
  if (patch.actions) {
    state.slackForm = {
      ...state.slackForm,
      ...patch,
      actions: { ...state.slackForm.actions, ...patch.actions },
    };
    return;
  }
  state.slackForm = { ...state.slackForm, ...patch };
}

export function updateSignalForm(
  state: ConnectionsState,
  patch: Partial<SignalForm>,
) {
  state.signalForm = { ...state.signalForm, ...patch };
}

export function updateIMessageForm(
  state: ConnectionsState,
  patch: Partial<IMessageForm>,
) {
  state.imessageForm = { ...state.imessageForm, ...patch };
}

export async function saveTelegramConfig(state: ConnectionsState) {
  if (!state.client || !state.connected) return;
  if (state.telegramSaving) return;
  state.telegramSaving = true;
  state.telegramConfigStatus = null;
  try {
    if (state.telegramForm.groupsWildcardEnabled) {
      const confirmed = window.confirm(
        'Telegram groups wildcard "*" allows all groups. Continue?',
      );
      if (!confirmed) {
        state.telegramConfigStatus = "Save cancelled.";
        return;
      }
    }
    const base = state.configSnapshot?.config ?? {};
    const config = { ...base } as Record<string, unknown>;
    const telegram = { ...(config.telegram ?? {}) } as Record<string, unknown>;
    if (!state.telegramTokenLocked) {
      const token = state.telegramForm.token.trim();
      if (token) telegram.botToken = token;
      else delete telegram.botToken;
    }
    const groups =
      telegram.groups && typeof telegram.groups === "object"
        ? ({ ...(telegram.groups as Record<string, unknown>) } as Record<
            string,
            unknown
          >)
        : {};
    if (state.telegramForm.groupsWildcardEnabled) {
      const defaultGroup =
        groups["*"] && typeof groups["*"] === "object"
          ? ({ ...(groups["*"] as Record<string, unknown>) } as Record<
              string,
              unknown
            >)
          : {};
      defaultGroup.requireMention = state.telegramForm.requireMention;
      groups["*"] = defaultGroup;
      telegram.groups = groups;
    } else if (groups["*"]) {
      delete groups["*"];
      if (Object.keys(groups).length > 0) telegram.groups = groups;
      else delete telegram.groups;
    }
    delete telegram.requireMention;
    const allowFrom = parseList(state.telegramForm.allowFrom);
    if (allowFrom.length > 0) telegram.allowFrom = allowFrom;
    else delete telegram.allowFrom;
    const proxy = state.telegramForm.proxy.trim();
    if (proxy) telegram.proxy = proxy;
    else delete telegram.proxy;
    const webhookUrl = state.telegramForm.webhookUrl.trim();
    if (webhookUrl) telegram.webhookUrl = webhookUrl;
    else delete telegram.webhookUrl;
    const webhookSecret = state.telegramForm.webhookSecret.trim();
    if (webhookSecret) telegram.webhookSecret = webhookSecret;
    else delete telegram.webhookSecret;
    const webhookPath = state.telegramForm.webhookPath.trim();
    if (webhookPath) telegram.webhookPath = webhookPath;
    else delete telegram.webhookPath;

    config.telegram = telegram;
    const raw = `${JSON.stringify(config, null, 2).trimEnd()}\n`;
    await state.client.request("config.set", { raw });
    state.telegramConfigStatus = "Saved. Restart gateway if needed.";
  } catch (err) {
    state.telegramConfigStatus = String(err);
  } finally {
    state.telegramSaving = false;
  }
}

export async function saveDiscordConfig(state: ConnectionsState) {
  if (!state.client || !state.connected) return;
  if (state.discordSaving) return;
  state.discordSaving = true;
  state.discordConfigStatus = null;
  try {
    const base = state.configSnapshot?.config ?? {};
    const config = { ...base } as Record<string, unknown>;
    const discord = { ...(config.discord ?? {}) } as Record<string, unknown>;
    const form = state.discordForm;

    if (form.enabled) {
      delete discord.enabled;
    } else {
      discord.enabled = false;
    }

    if (!state.discordTokenLocked) {
      const token = form.token.trim();
      if (token) discord.token = token;
      else delete discord.token;
    }

    const allowFrom = parseList(form.allowFrom);
    const groupChannels = parseList(form.groupChannels);
    const dm = { ...(discord.dm ?? {}) } as Record<string, unknown>;
    if (form.dmEnabled) delete dm.enabled;
    else dm.enabled = false;
    if (allowFrom.length > 0) dm.allowFrom = allowFrom;
    else delete dm.allowFrom;
    if (form.groupEnabled) dm.groupEnabled = true;
    else delete dm.groupEnabled;
    if (groupChannels.length > 0) dm.groupChannels = groupChannels;
    else delete dm.groupChannels;
    if (Object.keys(dm).length > 0) discord.dm = dm;
    else delete discord.dm;

    const mediaMaxMb = Number(form.mediaMaxMb);
    if (Number.isFinite(mediaMaxMb) && mediaMaxMb > 0) {
      discord.mediaMaxMb = mediaMaxMb;
    } else {
      delete discord.mediaMaxMb;
    }

    const historyLimitRaw = form.historyLimit.trim();
    if (historyLimitRaw.length === 0) {
      delete discord.historyLimit;
    } else {
      const historyLimit = Number(historyLimitRaw);
      if (Number.isFinite(historyLimit) && historyLimit >= 0) {
        discord.historyLimit = historyLimit;
      } else {
        delete discord.historyLimit;
      }
    }

    const chunkLimitRaw = form.textChunkLimit.trim();
    if (chunkLimitRaw.length === 0) {
      delete discord.textChunkLimit;
    } else {
      const chunkLimit = Number(chunkLimitRaw);
      if (Number.isFinite(chunkLimit) && chunkLimit > 0) {
        discord.textChunkLimit = chunkLimit;
      } else {
        delete discord.textChunkLimit;
      }
    }

    if (form.replyToMode === "off") {
      delete discord.replyToMode;
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
    else delete discord.guilds;

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
      delete discord.actions;
    }

    const slash = { ...(discord.slashCommand ?? {}) } as Record<string, unknown>;
    if (form.slashEnabled) {
      slash.enabled = true;
    } else {
      delete slash.enabled;
    }
    if (form.slashName.trim()) slash.name = form.slashName.trim();
    else delete slash.name;
    if (form.slashSessionPrefix.trim())
      slash.sessionPrefix = form.slashSessionPrefix.trim();
    else delete slash.sessionPrefix;
    if (form.slashEphemeral) {
      delete slash.ephemeral;
    } else {
      slash.ephemeral = false;
    }
    if (Object.keys(slash).length > 0) discord.slashCommand = slash;
    else delete discord.slashCommand;

    if (Object.keys(discord).length > 0) {
      config.discord = discord;
    } else {
      delete config.discord;
    }

    const raw = `${JSON.stringify(config, null, 2).trimEnd()}\n`;
    await state.client.request("config.set", { raw });
    state.discordConfigStatus = "Saved. Restart gateway if needed.";
  } catch (err) {
    state.discordConfigStatus = String(err);
  } finally {
    state.discordSaving = false;
  }
}

export async function saveSlackConfig(state: ConnectionsState) {
  if (!state.client || !state.connected) return;
  if (state.slackSaving) return;
  state.slackSaving = true;
  state.slackConfigStatus = null;
  try {
    const base = state.configSnapshot?.config ?? {};
    const config = { ...base } as Record<string, unknown>;
    const slack = { ...(config.slack ?? {}) } as Record<string, unknown>;
    const form = state.slackForm;

    if (form.enabled) {
      delete slack.enabled;
    } else {
      slack.enabled = false;
    }

    if (!state.slackTokenLocked) {
      const token = form.botToken.trim();
      if (token) slack.botToken = token;
      else delete slack.botToken;
    }
    if (!state.slackAppTokenLocked) {
      const token = form.appToken.trim();
      if (token) slack.appToken = token;
      else delete slack.appToken;
    }

    const dm = { ...(slack.dm ?? {}) } as Record<string, unknown>;
    dm.enabled = form.dmEnabled;
    const allowFrom = parseList(form.allowFrom);
    if (allowFrom.length > 0) dm.allowFrom = allowFrom;
    else delete dm.allowFrom;
    if (form.groupEnabled) {
      dm.groupEnabled = true;
    } else {
      delete dm.groupEnabled;
    }
    const groupChannels = parseList(form.groupChannels);
    if (groupChannels.length > 0) dm.groupChannels = groupChannels;
    else delete dm.groupChannels;
    if (Object.keys(dm).length > 0) slack.dm = dm;
    else delete slack.dm;

    const mediaMaxMb = Number.parseFloat(form.mediaMaxMb);
    if (Number.isFinite(mediaMaxMb) && mediaMaxMb > 0) {
      slack.mediaMaxMb = mediaMaxMb;
    } else {
      delete slack.mediaMaxMb;
    }

    const textChunkLimit = Number.parseInt(form.textChunkLimit, 10);
    if (Number.isFinite(textChunkLimit) && textChunkLimit > 0) {
      slack.textChunkLimit = textChunkLimit;
    } else {
      delete slack.textChunkLimit;
    }

    if (form.reactionNotifications === "own") {
      delete slack.reactionNotifications;
    } else {
      slack.reactionNotifications = form.reactionNotifications;
    }
    const reactionAllowlist = parseList(form.reactionAllowlist);
    if (reactionAllowlist.length > 0) {
      slack.reactionAllowlist = reactionAllowlist;
    } else {
      delete slack.reactionAllowlist;
    }

    const slash = { ...(slack.slashCommand ?? {}) } as Record<string, unknown>;
    if (form.slashEnabled) {
      slash.enabled = true;
    } else {
      delete slash.enabled;
    }
    if (form.slashName.trim()) slash.name = form.slashName.trim();
    else delete slash.name;
    if (form.slashSessionPrefix.trim())
      slash.sessionPrefix = form.slashSessionPrefix.trim();
    else delete slash.sessionPrefix;
    if (form.slashEphemeral) {
      delete slash.ephemeral;
    } else {
      slash.ephemeral = false;
    }
    if (Object.keys(slash).length > 0) slack.slashCommand = slash;
    else delete slack.slashCommand;

    const actions: Partial<SlackActionForm> = {};
    const applyAction = (key: keyof SlackActionForm) => {
      const value = form.actions[key];
      if (value !== defaultSlackActions[key]) actions[key] = value;
    };
    applyAction("reactions");
    applyAction("messages");
    applyAction("pins");
    applyAction("memberInfo");
    applyAction("emojiList");
    if (Object.keys(actions).length > 0) {
      slack.actions = actions;
    } else {
      delete slack.actions;
    }

    const channels = form.channels
      .map((entry): [string, Record<string, unknown>] | null => {
        const key = entry.key.trim();
        if (!key) return null;
        const record: Record<string, unknown> = {
          allow: entry.allow,
          requireMention: entry.requireMention,
        };
        return [key, record];
      })
      .filter((value): value is [string, Record<string, unknown>] => Boolean(value));
    if (channels.length > 0) {
      slack.channels = Object.fromEntries(channels);
    } else {
      delete slack.channels;
    }

    if (Object.keys(slack).length > 0) {
      config.slack = slack;
    } else {
      delete config.slack;
    }

    const raw = `${JSON.stringify(config, null, 2).trimEnd()}\n`;
    await state.client.request("config.set", { raw });
    state.slackConfigStatus = "Saved. Restart gateway if needed.";
  } catch (err) {
    state.slackConfigStatus = String(err);
  } finally {
    state.slackSaving = false;
  }
}

export async function saveSignalConfig(state: ConnectionsState) {
  if (!state.client || !state.connected) return;
  if (state.signalSaving) return;
  state.signalSaving = true;
  state.signalConfigStatus = null;
  try {
    const base = state.configSnapshot?.config ?? {};
    const config = { ...base } as Record<string, unknown>;
    const signal = { ...(config.signal ?? {}) } as Record<string, unknown>;
    const form = state.signalForm;

    if (form.enabled) {
      delete signal.enabled;
    } else {
      signal.enabled = false;
    }

    const account = form.account.trim();
    if (account) signal.account = account;
    else delete signal.account;

    const httpUrl = form.httpUrl.trim();
    if (httpUrl) signal.httpUrl = httpUrl;
    else delete signal.httpUrl;

    const httpHost = form.httpHost.trim();
    if (httpHost) signal.httpHost = httpHost;
    else delete signal.httpHost;

    const httpPort = Number(form.httpPort);
    if (Number.isFinite(httpPort) && httpPort > 0) {
      signal.httpPort = httpPort;
    } else {
      delete signal.httpPort;
    }

    const cliPath = form.cliPath.trim();
    if (cliPath) signal.cliPath = cliPath;
    else delete signal.cliPath;

    if (form.autoStart) {
      delete signal.autoStart;
    } else {
      signal.autoStart = false;
    }

    if (form.receiveMode === "on-start" || form.receiveMode === "manual") {
      signal.receiveMode = form.receiveMode;
    } else {
      delete signal.receiveMode;
    }

    if (form.ignoreAttachments) signal.ignoreAttachments = true;
    else delete signal.ignoreAttachments;
    if (form.ignoreStories) signal.ignoreStories = true;
    else delete signal.ignoreStories;
    if (form.sendReadReceipts) signal.sendReadReceipts = true;
    else delete signal.sendReadReceipts;

    const allowFrom = parseList(form.allowFrom);
    if (allowFrom.length > 0) signal.allowFrom = allowFrom;
    else delete signal.allowFrom;

    const mediaMaxMb = Number(form.mediaMaxMb);
    if (Number.isFinite(mediaMaxMb) && mediaMaxMb > 0) {
      signal.mediaMaxMb = mediaMaxMb;
    } else {
      delete signal.mediaMaxMb;
    }

    if (Object.keys(signal).length > 0) {
      config.signal = signal;
    } else {
      delete config.signal;
    }

    const raw = `${JSON.stringify(config, null, 2).trimEnd()}\n`;
    await state.client.request("config.set", { raw });
    state.signalConfigStatus = "Saved. Restart gateway if needed.";
  } catch (err) {
    state.signalConfigStatus = String(err);
  } finally {
    state.signalSaving = false;
  }
}

export async function saveIMessageConfig(state: ConnectionsState) {
  if (!state.client || !state.connected) return;
  if (state.imessageSaving) return;
  state.imessageSaving = true;
  state.imessageConfigStatus = null;
  try {
    const base = state.configSnapshot?.config ?? {};
    const config = { ...base } as Record<string, unknown>;
    const imessage = { ...(config.imessage ?? {}) } as Record<string, unknown>;
    const form = state.imessageForm;

    if (form.enabled) {
      delete imessage.enabled;
    } else {
      imessage.enabled = false;
    }

    const cliPath = form.cliPath.trim();
    if (cliPath) imessage.cliPath = cliPath;
    else delete imessage.cliPath;

    const dbPath = form.dbPath.trim();
    if (dbPath) imessage.dbPath = dbPath;
    else delete imessage.dbPath;

    if (form.service === "auto") {
      delete imessage.service;
    } else {
      imessage.service = form.service;
    }

    const region = form.region.trim();
    if (region) imessage.region = region;
    else delete imessage.region;

    const allowFrom = parseList(form.allowFrom);
    if (allowFrom.length > 0) imessage.allowFrom = allowFrom;
    else delete imessage.allowFrom;

    if (form.includeAttachments) imessage.includeAttachments = true;
    else delete imessage.includeAttachments;

    const mediaMaxMb = Number(form.mediaMaxMb);
    if (Number.isFinite(mediaMaxMb) && mediaMaxMb > 0) {
      imessage.mediaMaxMb = mediaMaxMb;
    } else {
      delete imessage.mediaMaxMb;
    }

    if (Object.keys(imessage).length > 0) {
      config.imessage = imessage;
    } else {
      delete config.imessage;
    }

    const raw = `${JSON.stringify(config, null, 2).trimEnd()}\n`;
    await state.client.request("config.set", { raw });
    state.imessageConfigStatus = "Saved. Restart gateway if needed.";
  } catch (err) {
    state.imessageConfigStatus = String(err);
  } finally {
    state.imessageSaving = false;
  }
}
