// Discord helper module supports secret config contract behavior.
import {
  collectNestedChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  hasConfiguredSecretInputValue,
  isBaseFieldActiveForChannelSurface,
  isEnabledFlag,
  isRecord,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { collectNestedChannelTtsAssignments } from "openclaw/plugin-sdk/channel-secret-tts-runtime";

function createVoiceProviderSecretTarget(params: {
  capability: "realtime" | "tts";
  scope: "account" | "channel";
}): SecretTargetRegistryEntry {
  const prefix = params.scope === "account" ? "channels.discord.accounts.*" : "channels.discord";
  const path = `${prefix}.voice.${params.capability}.providers.*.apiKey`;
  return {
    id: path,
    targetType: path,
    configFile: "openclaw.json",
    pathPattern: path,
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: params.scope === "account" ? 7 : 5,
  };
}

export const secretTargetRegistryEntries: SecretTargetRegistryEntry[] = [
  {
    id: "channels.discord.accounts.*.pluralkit.token",
    targetType: "channels.discord.accounts.*.pluralkit.token",
    configFile: "openclaw.json",
    pathPattern: "channels.discord.accounts.*.pluralkit.token",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.discord.accounts.*.token",
    targetType: "channels.discord.accounts.*.token",
    configFile: "openclaw.json",
    pathPattern: "channels.discord.accounts.*.token",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  createVoiceProviderSecretTarget({ capability: "realtime", scope: "account" }),
  createVoiceProviderSecretTarget({ capability: "tts", scope: "account" }),
  {
    id: "channels.discord.pluralkit.token",
    targetType: "channels.discord.pluralkit.token",
    configFile: "openclaw.json",
    pathPattern: "channels.discord.pluralkit.token",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.discord.token",
    targetType: "channels.discord.token",
    configFile: "openclaw.json",
    pathPattern: "channels.discord.token",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  createVoiceProviderSecretTarget({ capability: "realtime", scope: "channel" }),
  createVoiceProviderSecretTarget({ capability: "tts", scope: "channel" }),
];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "discord");
  if (!resolved) {
    return;
  }
  const { channel: discord, surface } = resolved;
  const hasImplicitDefault =
    surface.hasExplicitAccounts &&
    !surface.accounts.some(({ accountId }) => accountId === "default") &&
    [discord.token, params.context.env.DISCORD_BOT_TOKEN].some((value) =>
      hasConfiguredSecretInputValue(value, params.defaults),
    );
  if (hasImplicitDefault) {
    // Account discovery treats either token source as an implicit default. Keep it in
    // secret collection so named accounts cannot orphan the default's inherited refs.
    surface.accounts.push({
      accountId: "default",
      account: {},
      enabled: surface.channelEnabled,
    });
  }
  collectSimpleChannelFieldAssignments({
    channelKey: "discord",
    field: "token",
    channel: discord,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level Discord token.",
    accountInactiveReason: "Discord account is disabled.",
  });
  collectNestedChannelFieldAssignments({
    channelKey: "discord",
    nestedKey: "pluralkit",
    field: "token",
    channel: discord,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActive:
      isBaseFieldActiveForChannelSurface(surface, "pluralkit") &&
      isRecord(discord.pluralkit) &&
      isEnabledFlag(discord.pluralkit),
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled && !Object.hasOwn(account, "pluralkit") && isEnabledFlag(discord.pluralkit),
    topInactiveReason:
      "no enabled Discord surface inherits this top-level PluralKit config or PluralKit is disabled.",
    accountActive: ({ account, enabled }) =>
      enabled && isRecord(account.pluralkit) && isEnabledFlag(account.pluralkit),
    accountInactiveReason: "Discord account is disabled or PluralKit is disabled for this account.",
  });
  for (const [providerBlockKey, ownerId] of [
    ["tts", "tts"],
    ["realtime", "realtime-voice"],
  ] as const) {
    collectNestedChannelTtsAssignments({
      channelKey: "discord",
      nestedKey: "voice",
      providerBlockKey,
      ownerId,
      channel: discord,
      surface,
      defaults: params.defaults,
      context: params.context,
      topLevelActive:
        isBaseFieldActiveForChannelSurface(surface, "voice") &&
        isRecord(discord.voice) &&
        isEnabledFlag(discord.voice),
      topInactiveReason:
        "no enabled Discord surface inherits this top-level voice config or voice is disabled.",
      accountActive: ({ account, enabled }) =>
        enabled && isRecord(account.voice) && isEnabledFlag(account.voice),
      accountInactiveReason: "Discord account is disabled or voice is disabled for this account.",
    });
  }
}
