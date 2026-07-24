// Discord plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  isSupportedRealtimeVoiceActivationName,
  normalizeRealtimeVoiceActivationNamePrefix,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  asObjectRecord,
  defineChannelAliasMigration,
  hasLegacyAccountStreamingAliases,
  normalizeChannelAccounts,
  stripRetiredChannelKeys,
} from "openclaw/plugin-sdk/runtime-doctor";

const LEGACY_TTS_PROVIDER_KEYS = ["openai", "elevenlabs", "microsoft", "edge"] as const;
const RETIRED_TUNING_KEYS = new Set([
  "gatewayInfoTimeoutMs",
  "gatewayReadyTimeoutMs",
  "gatewayRuntimeReadyTimeoutMs",
  "eventQueue",
  "retry",
]);
type AgentBindingConfig = NonNullable<OpenClawConfig["bindings"]>[number];

const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "discord",
  streaming: {
    // Runtime mode resolution dropped legacy streamMode reads; the doctor
    // resolver keeps them so migration preserves configured intent.
    defaultMode: "off",
    // Discord previews default to progress only while `streaming` is absent;
    // any present object (even without mode) resolves off, so migration pins
    // progress when delivery-only aliases create the object with no root
    // streaming object to inherit from.
    absentObjectDefault: "progress",
    includePreviewChunk: true,
  },
  // Discord's account merge replaces the root streaming object wholesale
  // (`streaming` not in mergeDiscordAccountConfig nestedObjectKeys), so doctor
  // must seed materialized account objects with the inherited root settings.
  accountStreamingReplacesRoot: true,
  dm: { root: true, accounts: true },
  normalizeAccountExtra: ({ account, pathPrefix, changes }) => {
    const accountVoice = asObjectRecord(account.voice);
    if (
      !accountVoice ||
      !migrateLegacyTtsConfig(asObjectRecord(accountVoice.tts), `${pathPrefix}.voice.tts`, changes)
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

function hasLegacyTtsProviderKeys(value: unknown): boolean {
  const tts = asObjectRecord(value);
  if (!tts) {
    return false;
  }
  return LEGACY_TTS_PROVIDER_KEYS.some((key) => Object.hasOwn(tts, key));
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
    match: (value) =>
      hasLegacyAccountStreamingAliases(value, (accountValue) => {
        const account = asObjectRecord(accountValue);
        return hasLegacyTtsProviderKeys(asObjectRecord(account?.voice)?.tts);
      }),
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
    match: (value) =>
      hasLegacyAccountStreamingAliases(value, hasLegacyDiscordGuildChannelAllowAlias),
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
    match: (value) => hasLegacyAccountStreamingAliases(value, hasLegacyDiscordGuildChannelAgentId),
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
    match: (value) =>
      hasLegacyAccountStreamingAliases(value, hasUnsupportedDiscordRealtimeWakeNames),
  },
  ...streamingAliasMigration.legacyConfigRules,
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const changes: string[] = [];
  const bindingsToAdd: AgentBindingConfig[] = [];

  const aliases = streamingAliasMigration.normalizeChannelConfig({ cfg, changes });
  const tuningKnobs = stripRetiredChannelKeys({
    cfg: aliases.config,
    channelId: "discord",
    keys: RETIRED_TUNING_KEYS,
    scope: "root-and-accounts",
  });
  const rawEntry = asObjectRecord(
    (tuningKnobs.config.channels as Record<string, unknown> | undefined)?.discord,
  );
  if (!rawEntry) {
    return { config: cfg, changes: [] };
  }
  let updated = rawEntry;
  let changed = tuningKnobs.config !== cfg;
  if (tuningKnobs.changed) {
    changes.push("Removed retired Discord tuning knobs.");
  }

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

  const accounts = normalizeChannelAccounts({
    entry: updated,
    pathPrefix: "channels.discord",
    changes,
    normalizeAccount: ({ account, accountId, pathPrefix, changes: accountChanges }) => {
      const guilds = normalizeDiscordGuildChannelAllowAliases({
        entry: account,
        pathPrefix,
        changes: accountChanges,
      });
      const agentIds = normalizeDiscordGuildChannelAgentIds({
        cfg,
        entry: guilds.entry,
        pathPrefix,
        accountId,
        changes: accountChanges,
        bindingsToAdd,
      });
      const wakeNames = normalizeUnsupportedRealtimeWakeNames(
        agentIds.entry,
        pathPrefix,
        accountChanges,
      );
      return {
        entry: wakeNames.entry,
        changed: guilds.changed || agentIds.changed || wakeNames.changed,
      };
    },
  });
  updated = accounts.entry;
  changed = changed || accounts.changed;

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
      ...tuningKnobs.config,
      channels: {
        ...tuningKnobs.config.channels,
        discord: updated,
      } as OpenClawConfig["channels"],
      bindings:
        bindingsToAdd.length > 0 ? [...(cfg.bindings ?? []), ...bindingsToAdd] : cfg.bindings,
    },
    changes,
  };
}
