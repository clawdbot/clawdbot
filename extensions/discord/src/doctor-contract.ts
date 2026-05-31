import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  isSupportedRealtimeVoiceActivationName,
  normalizeRealtimeVoiceActivationNamePrefix,
} from "openclaw/plugin-sdk/realtime-voice";
import { asObjectRecord, normalizeLegacyChannelAliases } from "openclaw/plugin-sdk/runtime-doctor";
import { resolveDiscordPreviewStreamMode } from "./preview-streaming.js";

const LEGACY_TTS_PROVIDER_KEYS = ["openai", "elevenlabs", "microsoft", "edge"] as const;
type AgentBindingConfig = NonNullable<OpenClawConfig["bindings"]>[number];

function hasLegacyTtsProviderKeys(value: unknown): boolean {
  const tts = asObjectRecord(value);
  if (!tts) {
    return false;
  }
  return LEGACY_TTS_PROVIDER_KEYS.some((key) => Object.hasOwn(tts, key));
}

function hasLegacyDiscordAccountTtsProviderKeys(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((accountValue) => {
    const account = asObjectRecord(accountValue);
    const voice = asObjectRecord(account?.voice);
    return hasLegacyTtsProviderKeys(voice?.tts);
  });
}

function hasLegacyDiscordGuildChannelAllowAlias(value: unknown): boolean {
  const guilds = asObjectRecord(asObjectRecord(value)?.guilds);
  if (!guilds) {
    return false;
  }
  return Object.values(guilds).some((guildValue) => {
    const channels = asObjectRecord(asObjectRecord(guildValue)?.channels);
    if (!channels) {
      return false;
    }
    return Object.values(channels).some((channel) =>
      Object.hasOwn(asObjectRecord(channel) ?? {}, "allow"),
    );
  });
}

function hasLegacyDiscordGuildChannelAgentId(value: unknown): boolean {
  const guilds = asObjectRecord(asObjectRecord(value)?.guilds);
  if (!guilds) {
    return false;
  }
  return Object.values(guilds).some((guildValue) => {
    const channels = asObjectRecord(asObjectRecord(guildValue)?.channels);
    if (!channels) {
      return false;
    }
    return Object.values(channels).some((channel) =>
      Object.hasOwn(asObjectRecord(channel) ?? {}, "agentId"),
    );
  });
}

function hasLegacyDiscordAccountGuildChannelAllowAlias(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => hasLegacyDiscordGuildChannelAllowAlias(account));
}

function hasLegacyDiscordAccountGuildChannelAgentId(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => hasLegacyDiscordGuildChannelAgentId(account));
}

function hasUnsupportedRealtimeWakeNamesInVoice(value: unknown): boolean {
  const voice = asObjectRecord(value);
  const realtime = asObjectRecord(voice?.realtime);
  const wakeNames = realtime?.wakeNames;
  return Array.isArray(wakeNames)
    ? wakeNames.length === 0 ||
        wakeNames.some(
          (wakeName) =>
            typeof wakeName === "string" && !isSupportedRealtimeVoiceActivationName(wakeName),
        )
    : false;
}

function hasUnsupportedDiscordRealtimeWakeNames(value: unknown): boolean {
  const entry = asObjectRecord(value);
  if (!entry) {
    return false;
  }
  return hasUnsupportedRealtimeWakeNamesInVoice(entry.voice);
}

function hasUnsupportedDiscordAccountRealtimeWakeNames(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => hasUnsupportedDiscordRealtimeWakeNames(account));
}

function mergeMissing(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    const existing = target[key];
    if (existing === undefined) {
      target[key] = value;
      continue;
    }
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      mergeMissing(existing as Record<string, unknown>, value as Record<string, unknown>);
    }
  }
}

function getOrCreateTtsProviders(tts: Record<string, unknown>): Record<string, unknown> {
  const providers = asObjectRecord(tts.providers) ?? {};
  tts.providers = providers;
  return providers;
}

function mergeLegacyTtsProviderConfig(
  tts: Record<string, unknown>,
  legacyKey: string,
  providerId: string,
): boolean {
  const legacyValue = asObjectRecord(tts[legacyKey]);
  if (!legacyValue) {
    return false;
  }
  const providers = getOrCreateTtsProviders(tts);
  const existing = asObjectRecord(providers[providerId]) ?? {};
  const merged = structuredClone(existing);
  mergeMissing(merged, legacyValue);
  providers[providerId] = merged;
  delete tts[legacyKey];
  return true;
}

function migrateLegacyTtsConfig(
  tts: Record<string, unknown> | null,
  pathLabel: string,
  changes: string[],
): boolean {
  if (!tts) {
    return false;
  }
  let changed = false;
  if (mergeLegacyTtsProviderConfig(tts, "openai", "openai")) {
    changes.push(`Moved ${pathLabel}.openai → ${pathLabel}.providers.openai.`);
    changed = true;
  }
  if (mergeLegacyTtsProviderConfig(tts, "elevenlabs", "elevenlabs")) {
    changes.push(`Moved ${pathLabel}.elevenlabs → ${pathLabel}.providers.elevenlabs.`);
    changed = true;
  }
  if (mergeLegacyTtsProviderConfig(tts, "microsoft", "microsoft")) {
    changes.push(`Moved ${pathLabel}.microsoft → ${pathLabel}.providers.microsoft.`);
    changed = true;
  }
  if (mergeLegacyTtsProviderConfig(tts, "edge", "microsoft")) {
    changes.push(`Moved ${pathLabel}.edge → ${pathLabel}.providers.microsoft.`);
    changed = true;
  }
  return changed;
}

function normalizeUnsupportedRealtimeWakeNames(
  entry: Record<string, unknown>,
  pathPrefix: string,
  changes: string[],
): { entry: Record<string, unknown>; changed: boolean } {
  const voice = asObjectRecord(entry.voice);
  const realtime = asObjectRecord(voice?.realtime);
  const wakeNames = realtime?.wakeNames;
  if (!voice || !realtime || !Array.isArray(wakeNames)) {
    return { entry, changed: false };
  }

  if (wakeNames.length === 0) {
    const nextRealtime = { ...realtime };
    delete nextRealtime.wakeNames;
    changes.push(
      `Removed empty ${pathPrefix}.voice.realtime.wakeNames; unset wake names use the default agent/OpenClaw fallback.`,
    );
    return {
      entry: {
        ...entry,
        voice: {
          ...voice,
          realtime: nextRealtime,
        },
      },
      changed: true,
    };
  }

  let normalized = 0;
  let removed = 0;
  const nextWakeNames = wakeNames.flatMap((wakeName) => {
    if (typeof wakeName !== "string" || isSupportedRealtimeVoiceActivationName(wakeName)) {
      return [wakeName];
    }
    const nextWakeName = normalizeRealtimeVoiceActivationNamePrefix(wakeName);
    if (!nextWakeName) {
      removed += 1;
      return [];
    }
    normalized += 1;
    return [nextWakeName];
  });
  if (normalized === 0 && removed === 0) {
    return { entry, changed: false };
  }
  const dedupedWakeNames = Array.from(new Set(nextWakeNames));

  const nextRealtime = { ...realtime };
  if (dedupedWakeNames.length > 0) {
    nextRealtime.wakeNames = dedupedWakeNames;
  } else {
    delete nextRealtime.wakeNames;
  }
  if (normalized > 0) {
    changes.push(
      `Shortened ${normalized} unsupported ${pathPrefix}.voice.realtime.wakeNames entries to one or two words.`,
    );
  }
  if (removed > 0) {
    changes.push(
      `Removed ${removed} unsupported ${pathPrefix}.voice.realtime.wakeNames entries with no usable words.`,
    );
  }
  return {
    entry: {
      ...entry,
      voice: {
        ...voice,
        realtime: nextRealtime,
      },
    },
    changed: true,
  };
}

function normalizeDiscordGuildChannelAllowAliases(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const guilds = asObjectRecord(params.entry.guilds);
  if (!guilds) {
    return { entry: params.entry, changed: false };
  }

  let changed = false;
  const nextGuilds = { ...guilds };
  for (const [guildId, guildValue] of Object.entries(guilds)) {
    const guild = asObjectRecord(guildValue);
    const channels = asObjectRecord(guild?.channels);
    if (!guild || !channels) {
      continue;
    }
    let channelsChanged = false;
    const nextChannels = { ...channels };
    for (const [channelId, channelValue] of Object.entries(channels)) {
      const channel = asObjectRecord(channelValue);
      if (!channel || !Object.hasOwn(channel, "allow")) {
        continue;
      }
      const nextChannel = { ...channel };
      if (nextChannel.enabled === undefined) {
        nextChannel.enabled = channel.allow;
        params.changes.push(
          `Moved ${params.pathPrefix}.guilds.${guildId}.channels.${channelId}.allow → ${params.pathPrefix}.guilds.${guildId}.channels.${channelId}.enabled.`,
        );
      } else {
        params.changes.push(
          `Removed ${params.pathPrefix}.guilds.${guildId}.channels.${channelId}.allow (${params.pathPrefix}.guilds.${guildId}.channels.${channelId}.enabled already set).`,
        );
      }
      delete nextChannel.allow;
      nextChannels[channelId] = nextChannel;
      channelsChanged = true;
    }
    if (!channelsChanged) {
      continue;
    }
    nextGuilds[guildId] = { ...guild, channels: nextChannels };
    changed = true;
  }

  return changed
    ? { entry: { ...params.entry, guilds: nextGuilds }, changed: true }
    : { entry: params.entry, changed: false };
}

function isDiscordChannelAgentBinding(
  value: unknown,
  match: { accountId?: string; guildId: string; channelId: string },
): value is Record<string, unknown> {
  const binding = asObjectRecord(value);
  const bindingMatch = asObjectRecord(binding?.match);
  const peer = asObjectRecord(bindingMatch?.peer);
  if (!binding || !bindingMatch || !peer) {
    return false;
  }
  return (
    bindingMatch.channel === "discord" &&
    bindingMatch.guildId === match.guildId &&
    (match.accountId === undefined || bindingMatch.accountId === match.accountId) &&
    peer.kind === "channel" &&
    peer.id === match.channelId
  );
}

function normalizeDiscordGuildChannelAgentIds(params: {
  cfg: OpenClawConfig;
  entry: Record<string, unknown>;
  pathPrefix: string;
  accountId?: string;
  changes: string[];
  bindingsToAdd: AgentBindingConfig[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const guilds = asObjectRecord(params.entry.guilds);
  if (!guilds) {
    return { entry: params.entry, changed: false };
  }

  const existingBindings = Array.isArray(params.cfg.bindings) ? params.cfg.bindings : [];
  let changed = false;
  const nextGuilds = { ...guilds };
  for (const [guildId, guildValue] of Object.entries(guilds)) {
    const guild = asObjectRecord(guildValue);
    const channels = asObjectRecord(guild?.channels);
    if (!guild || !channels) {
      continue;
    }
    let channelsChanged = false;
    const nextChannels = { ...channels };
    for (const [channelId, channelValue] of Object.entries(channels)) {
      const channel = asObjectRecord(channelValue);
      if (!channel || !Object.hasOwn(channel, "agentId")) {
        continue;
      }
      const nextChannel = { ...channel };
      const rawAgentId = nextChannel.agentId;
      delete nextChannel.agentId;
      nextChannels[channelId] = nextChannel;
      channelsChanged = true;

      const path = `${params.pathPrefix}.guilds.${guildId}.channels.${channelId}.agentId`;
      const agentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
      if (!agentId) {
        params.changes.push(
          `Removed ${path}; configure top-level bindings[] for per-channel Discord agent routing.`,
        );
        continue;
      }

      const match = { accountId: params.accountId, guildId, channelId };
      const existingBinding = existingBindings.find((binding) =>
        isDiscordChannelAgentBinding(binding, match),
      );
      if (existingBinding) {
        params.changes.push(
          `Removed ${path}; a matching top-level bindings[] route already exists for Discord channel ${channelId}.`,
        );
        continue;
      }

      const bindingMatch: AgentBindingConfig["match"] = {
        channel: "discord",
        guildId,
        peer: { kind: "channel", id: channelId },
      };
      if (params.accountId) {
        bindingMatch.accountId = params.accountId;
      }
      params.bindingsToAdd.push({
        agentId,
        match: bindingMatch,
      });
      params.changes.push(
        `Moved ${path} → top-level bindings[] route for Discord channel ${channelId}.`,
      );
    }
    if (!channelsChanged) {
      continue;
    }
    nextGuilds[guildId] = { ...guild, channels: nextChannels };
    changed = true;
  }

  return changed
    ? { entry: { ...params.entry, guilds: nextGuilds }, changed: true }
    : { entry: params.entry, changed: false };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "discord", "voice", "tts"],
    message:
      'channels.discord.voice.tts.<provider> keys (openai/elevenlabs/microsoft/edge) are legacy; use channels.discord.voice.tts.providers.<provider>. Run "openclaw doctor --fix".',
    match: hasLegacyTtsProviderKeys,
  },
  {
    path: ["channels", "discord", "accounts"],
    message:
      'channels.discord.accounts.<id>.voice.tts.<provider> keys (openai/elevenlabs/microsoft/edge) are legacy; use channels.discord.accounts.<id>.voice.tts.providers.<provider>. Run "openclaw doctor --fix".',
    match: hasLegacyDiscordAccountTtsProviderKeys,
  },
  {
    path: ["channels", "discord"],
    message:
      'channels.discord.guilds.<id>.channels.<id>.allow is legacy; use channels.discord.guilds.<id>.channels.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: hasLegacyDiscordGuildChannelAllowAlias,
  },
  {
    path: ["channels", "discord", "accounts"],
    message:
      'channels.discord.accounts.<id>.guilds.<id>.channels.<id>.allow is legacy; use channels.discord.accounts.<id>.guilds.<id>.channels.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: hasLegacyDiscordAccountGuildChannelAllowAlias,
  },
  {
    path: ["channels", "discord"],
    message:
      'channels.discord.guilds.<id>.channels.<id>.agentId is legacy; use top-level bindings[] for per-channel Discord agent routing. Run "openclaw doctor --fix".',
    match: hasLegacyDiscordGuildChannelAgentId,
  },
  {
    path: ["channels", "discord", "accounts"],
    message:
      'channels.discord.accounts.<id>.guilds.<id>.channels.<id>.agentId is legacy; use top-level bindings[] with match.accountId for per-channel Discord agent routing. Run "openclaw doctor --fix".',
    match: hasLegacyDiscordAccountGuildChannelAgentId,
  },
  {
    path: ["channels", "discord"],
    message:
      'channels.discord.voice.realtime.wakeNames entries longer than two words are unsupported; use one- or two-word activation names. Run "openclaw doctor --fix".',
    match: hasUnsupportedDiscordRealtimeWakeNames,
  },
  {
    path: ["channels", "discord", "accounts"],
    message:
      'channels.discord.accounts.<id>.voice.realtime.wakeNames entries longer than two words are unsupported; use one- or two-word activation names. Run "openclaw doctor --fix".',
    match: hasUnsupportedDiscordAccountRealtimeWakeNames,
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const rawEntry = asObjectRecord((cfg.channels as Record<string, unknown> | undefined)?.discord);
  if (!rawEntry) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let updated = rawEntry;
  let changed = false;
  const bindingsToAdd: AgentBindingConfig[] = [];

  const aliases = normalizeLegacyChannelAliases({
    entry: rawEntry,
    pathPrefix: "channels.discord",
    changes,
    normalizeDm: true,
    normalizeAccountDm: true,
    resolveStreamingOptions: (entry) => ({
      resolvedMode: resolveDiscordPreviewStreamMode(entry),
      includePreviewChunk: true,
    }),
    normalizeAccountExtra: ({ account, pathPrefix }) => {
      const accountVoice = asObjectRecord(account.voice);
      if (
        !accountVoice ||
        !migrateLegacyTtsConfig(
          asObjectRecord(accountVoice.tts),
          `${pathPrefix}.voice.tts`,
          changes,
        )
      ) {
        return { entry: account, changed: false };
      }
      return {
        entry: {
          ...account,
          voice: accountVoice,
        },
        changed: true,
      };
    },
  });
  updated = aliases.entry;
  changed = aliases.changed;

  const guildAliases = normalizeDiscordGuildChannelAllowAliases({
    entry: updated,
    pathPrefix: "channels.discord",
    changes,
  });
  updated = guildAliases.entry;
  changed = changed || guildAliases.changed;

  const channelAgentIds = normalizeDiscordGuildChannelAgentIds({
    cfg,
    entry: updated,
    pathPrefix: "channels.discord",
    changes,
    bindingsToAdd,
  });
  updated = channelAgentIds.entry;
  changed = changed || channelAgentIds.changed;

  const accounts = asObjectRecord(updated.accounts);
  if (accounts) {
    let accountsChanged = false;
    const nextAccounts = { ...accounts };
    for (const [accountId, accountValue] of Object.entries(accounts)) {
      const account = asObjectRecord(accountValue);
      if (!account) {
        continue;
      }
      const normalized = normalizeDiscordGuildChannelAllowAliases({
        entry: account,
        pathPrefix: `channels.discord.accounts.${accountId}`,
        changes,
      });
      let nextAccount = normalized.entry;
      let accountChanged = normalized.changed;
      const normalizedAgentIds = normalizeDiscordGuildChannelAgentIds({
        cfg,
        entry: nextAccount,
        pathPrefix: `channels.discord.accounts.${accountId}`,
        accountId,
        changes,
        bindingsToAdd,
      });
      nextAccount = normalizedAgentIds.entry;
      accountChanged = accountChanged || normalizedAgentIds.changed;
      const normalizedWakeNames = normalizeUnsupportedRealtimeWakeNames(
        nextAccount,
        `channels.discord.accounts.${accountId}`,
        changes,
      );
      nextAccount = normalizedWakeNames.entry;
      accountChanged = accountChanged || normalizedWakeNames.changed;
      if (!accountChanged) {
        continue;
      }
      nextAccounts[accountId] = nextAccount;
      accountsChanged = true;
    }
    if (accountsChanged) {
      updated = { ...updated, accounts: nextAccounts };
      changed = true;
    }
  }

  const voice = asObjectRecord(updated.voice);
  if (
    voice &&
    migrateLegacyTtsConfig(asObjectRecord(voice.tts), "channels.discord.voice.tts", changes)
  ) {
    updated = { ...updated, voice };
    changed = true;
  }
  const normalizedWakeNames = normalizeUnsupportedRealtimeWakeNames(
    updated,
    "channels.discord",
    changes,
  );
  updated = normalizedWakeNames.entry;
  changed = changed || normalizedWakeNames.changed;

  if (!changed) {
    return { config: cfg, changes: [] };
  }
  return {
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        discord: updated,
      } as OpenClawConfig["channels"],
      bindings:
        bindingsToAdd.length > 0 ? [...(cfg.bindings ?? []), ...bindingsToAdd] : cfg.bindings,
    },
    changes,
  };
}
