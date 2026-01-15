import type { GatewayBrowserClient } from "../gateway";
import type {
  ConfigSchemaResponse,
  ConfigSnapshot,
  ConfigUiHints,
} from "../types";
import {
  defaultDiscordActions,
  defaultSlackActions,
  type DiscordActionForm,
  type DiscordForm,
  type DiscordGuildChannelForm,
  type DiscordGuildForm,
  type IMessageForm,
  type SlackChannelForm,
  type SlackForm,
  type SignalForm,
  type TelegramForm,
} from "../ui-types";
import {
  cloneConfigObject,
  removePathValue,
  serializeConfigForm,
  setPathValue,
} from "./config/form-utils";

export type ConfigState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  applySessionKey: string;
  configLoading: boolean;
  configRaw: string;
  configValid: boolean | null;
  configIssues: unknown[];
  configSaving: boolean;
  configApplying: boolean;
  updateRunning: boolean;
  configSnapshot: ConfigSnapshot | null;
  configSchema: unknown | null;
  configSchemaVersion: string | null;
  configSchemaLoading: boolean;
  configUiHints: ConfigUiHints;
  configForm: Record<string, unknown> | null;
  configFormDirty: boolean;
  configFormMode: "form" | "raw";
  lastError: string | null;
  telegramForm: TelegramForm;
  discordForm: DiscordForm;
  slackForm: SlackForm;
  signalForm: SignalForm;
  imessageForm: IMessageForm;
  telegramConfigStatus: string | null;
  discordConfigStatus: string | null;
  slackConfigStatus: string | null;
  signalConfigStatus: string | null;
  imessageConfigStatus: string | null;
};

export async function loadConfig(state: ConfigState) {
  if (!state.client || !state.connected) return;
  state.configLoading = true;
  state.lastError = null;
  try {
    const res = (await state.client.request("config.get", {})) as ConfigSnapshot;
    applyConfigSnapshot(state, res);
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.configLoading = false;
  }
}

export async function loadConfigSchema(state: ConfigState) {
  if (!state.client || !state.connected) return;
  if (state.configSchemaLoading) return;
  state.configSchemaLoading = true;
  try {
    const res = (await state.client.request(
      "config.schema",
      {},
    )) as ConfigSchemaResponse;
    applyConfigSchema(state, res);
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.configSchemaLoading = false;
  }
}

export function applyConfigSchema(
  state: ConfigState,
  res: ConfigSchemaResponse,
) {
  state.configSchema = res.schema ?? null;
  state.configUiHints = res.uiHints ?? {};
  state.configSchemaVersion = res.version ?? null;
}

export function applyConfigSnapshot(state: ConfigState, snapshot: ConfigSnapshot) {
  state.configSnapshot = snapshot;
  const rawFromSnapshot =
    typeof snapshot.raw === "string"
      ? snapshot.raw
      : snapshot.config && typeof snapshot.config === "object"
        ? serializeConfigForm(snapshot.config as Record<string, unknown>)
        : state.configRaw;
  if (!state.configFormDirty || state.configFormMode === "raw") {
    state.configRaw = rawFromSnapshot;
  } else if (state.configForm) {
    state.configRaw = serializeConfigForm(state.configForm);
  } else {
    state.configRaw = rawFromSnapshot;
  }
  state.configValid = typeof snapshot.valid === "boolean" ? snapshot.valid : null;
  state.configIssues = Array.isArray(snapshot.issues) ? snapshot.issues : [];

  const config = snapshot.config ?? {};
  const channels = (config.channels ?? {}) as Record<string, unknown>;
  const telegram = (channels.telegram ?? config.telegram ?? {}) as Record<string, unknown>;
  const discord = (channels.discord ?? config.discord ?? {}) as Record<string, unknown>;
  const slack = (channels.slack ?? config.slack ?? {}) as Record<string, unknown>;
  const signal = (channels.signal ?? config.signal ?? {}) as Record<string, unknown>;
  const imessage = (channels.imessage ?? config.imessage ?? {}) as Record<string, unknown>;
  const toList = (value: unknown) =>
    Array.isArray(value)
      ? value
          .map((v) => String(v ?? "").trim())
          .filter((v) => v.length > 0)
          .join(", ")
      : "";
  const telegramGroups =
    telegram.groups && typeof telegram.groups === "object"
      ? (telegram.groups as Record<string, unknown>)
      : {};
  const telegramDefaultGroup =
    telegramGroups["*"] && typeof telegramGroups["*"] === "object"
      ? (telegramGroups["*"] as Record<string, unknown>)
      : {};
  const telegramHasWildcard = Boolean(telegramGroups["*"]);
  const allowFrom = Array.isArray(telegram.allowFrom)
    ? toList(telegram.allowFrom)
    : typeof telegram.allowFrom === "string"
      ? telegram.allowFrom
      : "";

  state.telegramForm = {
    token: typeof telegram.botToken === "string" ? telegram.botToken : "",
    requireMention:
      typeof telegramDefaultGroup.requireMention === "boolean"
        ? telegramDefaultGroup.requireMention
        : true,
    groupsWildcardEnabled: telegramHasWildcard,
    allowFrom,
    proxy: typeof telegram.proxy === "string" ? telegram.proxy : "",
    webhookUrl: typeof telegram.webhookUrl === "string" ? telegram.webhookUrl : "",
    webhookSecret:
      typeof telegram.webhookSecret === "string" ? telegram.webhookSecret : "",
    webhookPath: typeof telegram.webhookPath === "string" ? telegram.webhookPath : "",
  };

  const discordDm = (discord.dm ?? {}) as Record<string, unknown>;
  const slash = (discord.slashCommand ?? {}) as Record<string, unknown>;
  const discordActions = (discord.actions ?? {}) as Record<string, unknown>;
  const discordGuilds = discord.guilds;
  const readAction = (key: keyof DiscordActionForm) =>
    typeof discordActions[key] === "boolean"
      ? (discordActions[key] as boolean)
      : defaultDiscordActions[key];
  state.discordForm = {
    enabled: typeof discord.enabled === "boolean" ? discord.enabled : true,
    token: typeof discord.token === "string" ? discord.token : "",
    dmEnabled: typeof discordDm.enabled === "boolean" ? discordDm.enabled : true,
    allowFrom: toList(discordDm.allowFrom),
    groupEnabled:
      typeof discordDm.groupEnabled === "boolean" ? discordDm.groupEnabled : false,
    groupChannels: toList(discordDm.groupChannels),
    mediaMaxMb:
      typeof discord.mediaMaxMb === "number" ? String(discord.mediaMaxMb) : "",
    historyLimit:
      typeof discord.historyLimit === "number" ? String(discord.historyLimit) : "",
    textChunkLimit:
      typeof discord.textChunkLimit === "number"
        ? String(discord.textChunkLimit)
        : "",
    replyToMode:
      discord.replyToMode === "first" || discord.replyToMode === "all"
        ? discord.replyToMode
        : "off",
    guilds: Array.isArray(discordGuilds)
      ? []
      : typeof discordGuilds === "object" && discordGuilds
        ? Object.entries(discordGuilds as Record<string, unknown>).map(
            ([key, value]): DiscordGuildForm => {
              const entry =
                value && typeof value === "object"
                  ? (value as Record<string, unknown>)
                  : {};
              const channelsRaw =
                entry.channels && typeof entry.channels === "object"
                  ? (entry.channels as Record<string, unknown>)
                  : {};
              const channels = Object.entries(channelsRaw).map(
                ([channelKey, channelValue]): DiscordGuildChannelForm => {
                  const channel =
                    channelValue && typeof channelValue === "object"
                      ? (channelValue as Record<string, unknown>)
                      : {};
                  return {
                    key: channelKey,
                    allow:
                      typeof channel.allow === "boolean" ? channel.allow : true,
                    requireMention:
                      typeof channel.requireMention === "boolean"
                        ? channel.requireMention
                        : false,
                  };
                },
              );
              return {
                key,
                slug: typeof entry.slug === "string" ? entry.slug : "",
                requireMention:
                  typeof entry.requireMention === "boolean"
                    ? entry.requireMention
                    : false,
                reactionNotifications:
                  entry.reactionNotifications === "off" ||
                  entry.reactionNotifications === "all" ||
                  entry.reactionNotifications === "own" ||
                  entry.reactionNotifications === "allowlist"
                    ? entry.reactionNotifications
                    : "own",
                users: toList(entry.users),
                channels,
              };
            },
          )
        : [],
    actions: {
      reactions: readAction("reactions"),
      stickers: readAction("stickers"),
      polls: readAction("polls"),
      permissions: readAction("permissions"),
      messages: readAction("messages"),
      threads: readAction("threads"),
      pins: readAction("pins"),
      search: readAction("search"),
      memberInfo: readAction("memberInfo"),
      roleInfo: readAction("roleInfo"),
      channelInfo: readAction("channelInfo"),
      voiceStatus: readAction("voiceStatus"),
      events: readAction("events"),
      roles: readAction("roles"),
      moderation: readAction("moderation"),
    },
    slashEnabled: typeof slash.enabled === "boolean" ? slash.enabled : false,
    slashName: typeof slash.name === "string" ? slash.name : "",
    slashSessionPrefix:
      typeof slash.sessionPrefix === "string" ? slash.sessionPrefix : "",
    slashEphemeral:
      typeof slash.ephemeral === "boolean" ? slash.ephemeral : true,
  };

  const slackDm = (slack.dm ?? {}) as Record<string, unknown>;
  const slackChannels = slack.channels;
  const slackSlash = (slack.slashCommand ?? {}) as Record<string, unknown>;
  const slackActions =
    (slack.actions ?? {}) as Partial<Record<keyof typeof defaultSlackActions, unknown>>;
  state.slackForm = {
    enabled: typeof slack.enabled === "boolean" ? slack.enabled : true,
    botToken: typeof slack.botToken === "string" ? slack.botToken : "",
    appToken: typeof slack.appToken === "string" ? slack.appToken : "",
    dmEnabled: typeof slackDm.enabled === "boolean" ? slackDm.enabled : true,
    allowFrom: toList(slackDm.allowFrom),
    groupEnabled:
      typeof slackDm.groupEnabled === "boolean" ? slackDm.groupEnabled : false,
    groupChannels: toList(slackDm.groupChannels),
    mediaMaxMb:
      typeof slack.mediaMaxMb === "number" ? String(slack.mediaMaxMb) : "",
    textChunkLimit:
      typeof slack.textChunkLimit === "number"
        ? String(slack.textChunkLimit)
        : "",
    reactionNotifications:
      slack.reactionNotifications === "off" ||
      slack.reactionNotifications === "all" ||
      slack.reactionNotifications === "allowlist"
        ? slack.reactionNotifications
        : "own",
    reactionAllowlist: toList(slack.reactionAllowlist),
    slashEnabled:
      typeof slackSlash.enabled === "boolean" ? slackSlash.enabled : false,
    slashName: typeof slackSlash.name === "string" ? slackSlash.name : "",
    slashSessionPrefix:
      typeof slackSlash.sessionPrefix === "string"
        ? slackSlash.sessionPrefix
        : "",
    slashEphemeral:
      typeof slackSlash.ephemeral === "boolean" ? slackSlash.ephemeral : true,
    actions: {
      ...defaultSlackActions,
      reactions:
        typeof slackActions.reactions === "boolean"
          ? slackActions.reactions
          : defaultSlackActions.reactions,
      messages:
        typeof slackActions.messages === "boolean"
          ? slackActions.messages
          : defaultSlackActions.messages,
      pins:
        typeof slackActions.pins === "boolean"
          ? slackActions.pins
          : defaultSlackActions.pins,
      memberInfo:
        typeof slackActions.memberInfo === "boolean"
          ? slackActions.memberInfo
          : defaultSlackActions.memberInfo,
      emojiList:
        typeof slackActions.emojiList === "boolean"
          ? slackActions.emojiList
          : defaultSlackActions.emojiList,
    },
    channels: Array.isArray(slackChannels)
      ? []
      : typeof slackChannels === "object" && slackChannels
        ? Object.entries(slackChannels as Record<string, unknown>).map(
            ([key, value]): SlackChannelForm => {
              const entry =
                value && typeof value === "object"
                  ? (value as Record<string, unknown>)
                  : {};
              return {
                key,
                allow:
                  typeof entry.allow === "boolean" ? entry.allow : true,
                requireMention:
                  typeof entry.requireMention === "boolean"
                    ? entry.requireMention
                    : false,
              };
            },
          )
        : [],
  };

  state.signalForm = {
    enabled: typeof signal.enabled === "boolean" ? signal.enabled : true,
    account: typeof signal.account === "string" ? signal.account : "",
    httpUrl: typeof signal.httpUrl === "string" ? signal.httpUrl : "",
    httpHost: typeof signal.httpHost === "string" ? signal.httpHost : "",
    httpPort: typeof signal.httpPort === "number" ? String(signal.httpPort) : "",
    cliPath: typeof signal.cliPath === "string" ? signal.cliPath : "",
    autoStart: typeof signal.autoStart === "boolean" ? signal.autoStart : true,
    receiveMode:
      signal.receiveMode === "on-start" || signal.receiveMode === "manual"
        ? signal.receiveMode
        : "",
    ignoreAttachments:
      typeof signal.ignoreAttachments === "boolean" ? signal.ignoreAttachments : false,
    ignoreStories:
      typeof signal.ignoreStories === "boolean" ? signal.ignoreStories : false,
    sendReadReceipts:
      typeof signal.sendReadReceipts === "boolean" ? signal.sendReadReceipts : false,
    allowFrom: toList(signal.allowFrom),
    mediaMaxMb:
      typeof signal.mediaMaxMb === "number" ? String(signal.mediaMaxMb) : "",
  };

  state.imessageForm = {
    enabled: typeof imessage.enabled === "boolean" ? imessage.enabled : true,
    cliPath: typeof imessage.cliPath === "string" ? imessage.cliPath : "",
    dbPath: typeof imessage.dbPath === "string" ? imessage.dbPath : "",
    service:
      imessage.service === "imessage" ||
      imessage.service === "sms" ||
      imessage.service === "auto"
        ? imessage.service
        : "auto",
    region: typeof imessage.region === "string" ? imessage.region : "",
    allowFrom: toList(imessage.allowFrom),
    includeAttachments:
      typeof imessage.includeAttachments === "boolean"
        ? imessage.includeAttachments
        : false,
    mediaMaxMb:
      typeof imessage.mediaMaxMb === "number" ? String(imessage.mediaMaxMb) : "",
  };

  const configInvalid = snapshot.valid === false ? "Config invalid." : null;
  state.telegramConfigStatus = configInvalid;
  state.discordConfigStatus = configInvalid;
  state.slackConfigStatus = configInvalid;
  state.signalConfigStatus = configInvalid;
  state.imessageConfigStatus = configInvalid;

  if (!state.configFormDirty) {
    state.configForm = cloneConfigObject(snapshot.config ?? {});
  }
}

export async function saveConfig(state: ConfigState) {
  if (!state.client || !state.connected) return;
  state.configSaving = true;
  state.lastError = null;
  try {
    const raw =
      state.configFormMode === "form" && state.configForm
        ? serializeConfigForm(state.configForm)
        : state.configRaw;
    const baseHash = state.configSnapshot?.hash;
    if (!baseHash) {
      state.lastError = "Config hash missing; reload and retry.";
      return;
    }
    await state.client.request("config.set", { raw, baseHash });
    state.configFormDirty = false;
    await loadConfig(state);
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.configSaving = false;
  }
}

export async function applyConfig(state: ConfigState) {
  if (!state.client || !state.connected) return;
  state.configApplying = true;
  state.lastError = null;
  try {
    const raw =
      state.configFormMode === "form" && state.configForm
        ? serializeConfigForm(state.configForm)
        : state.configRaw;
    const baseHash = state.configSnapshot?.hash;
    if (!baseHash) {
      state.lastError = "Config hash missing; reload and retry.";
      return;
    }
    await state.client.request("config.apply", {
      raw,
      baseHash,
      sessionKey: state.applySessionKey,
    });
    state.configFormDirty = false;
    await loadConfig(state);
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.configApplying = false;
  }
}

export async function runUpdate(state: ConfigState) {
  if (!state.client || !state.connected) return;
  state.updateRunning = true;
  state.lastError = null;
  try {
    await state.client.request("update.run", {
      sessionKey: state.applySessionKey,
    });
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.updateRunning = false;
  }
}

export function updateConfigFormValue(
  state: ConfigState,
  path: Array<string | number>,
  value: unknown,
) {
  const base = cloneConfigObject(
    state.configForm ?? state.configSnapshot?.config ?? {},
  );
  setPathValue(base, path, value);
  state.configForm = base;
  state.configFormDirty = true;
  if (state.configFormMode === "form") {
    state.configRaw = serializeConfigForm(base);
  }
}

export function removeConfigFormValue(
  state: ConfigState,
  path: Array<string | number>,
) {
  const base = cloneConfigObject(
    state.configForm ?? state.configSnapshot?.config ?? {},
  );
  removePathValue(base, path);
  state.configForm = base;
  state.configFormDirty = true;
  if (state.configFormMode === "form") {
    state.configRaw = serializeConfigForm(base);
  }
}
