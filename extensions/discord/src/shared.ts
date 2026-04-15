import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import { createScopedChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import { inspectDiscordAccount } from "./account-inspect.js";
import {
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "./accounts.js";
import { getChatChannelMeta, type ChannelPlugin } from "./channel-api.js";
import { DiscordChannelConfigSchema } from "./config-schema.js";
import { normalizeCompatibilityConfig } from "./doctor-contract.js";
import { DISCORD_LEGACY_CONFIG_RULES } from "./doctor-shared.js";
import {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./secret-config-contract.js";
import {
  collectUnsupportedSecretRefConfigCandidates,
  unsupportedSecretRefSurfacePatterns,
} from "./security-contract.js";
import { deriveLegacySessionChatType } from "./session-contract.js";

export const DISCORD_CHANNEL = "discord" as const;

type DiscordDoctorModule = typeof import("./doctor.js");

let discordDoctorModulePromise: Promise<DiscordDoctorModule> | undefined;

async function loadDiscordDoctorModule(): Promise<DiscordDoctorModule> {
  discordDoctorModulePromise ??= import("./doctor.js");
  return await discordDoctorModulePromise;
}

const discordDoctor: ChannelDoctorAdapter = {
  dmAllowFromMode: "topOrNested",
  groupModel: "route",
  groupAllowFromFallbackToAllowFrom: false,
  warnOnEmptyGroupSenderAllowlist: false,
  legacyConfigRules: DISCORD_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig,
  collectPreviewWarnings: async (params) =>
    (await loadDiscordDoctorModule()).discordDoctor.collectPreviewWarnings?.(params) ?? [],
  collectMutableAllowlistWarnings: async (params) =>
    (await loadDiscordDoctorModule()).discordDoctor.collectMutableAllowlistWarnings?.(params) ?? [],
  repairConfig: async (params) =>
    (await loadDiscordDoctorModule()).discordDoctor.repairConfig?.(params) ?? {
      config: params.cfg,
      changes: [],
    },
};

export const discordConfigAdapter = createScopedChannelConfigAdapter<ResolvedDiscordAccount>({
  sectionKey: DISCORD_CHANNEL,
  listAccountIds: listDiscordAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveDiscordAccount),
  inspectAccount: adaptScopedAccountAccessor(inspectDiscordAccount),
  defaultAccountId: resolveDefaultDiscordAccountId,
  clearBaseFields: ["token", "name"],
  resolveAllowFrom: (account: ResolvedDiscordAccount) => account.config.dm?.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account: ResolvedDiscordAccount) => account.config.defaultTo,
});

export function createDiscordPluginBase(params: {
  setup: NonNullable<ChannelPlugin<ResolvedDiscordAccount>["setup"]>;
  setupWizard?: ChannelPlugin<ResolvedDiscordAccount>["setupWizard"];
}): Pick<
  ChannelPlugin<ResolvedDiscordAccount>,
  | "id"
  | "meta"
  | "setupWizard"
  | "capabilities"
  | "commands"
  | "doctor"
  | "streaming"
  | "reload"
  | "configSchema"
  | "config"
  | "setup"
  | "messaging"
  | "secrets"
> {
  return {
    id: DISCORD_CHANNEL,
    ...(params.setupWizard ? { setupWizard: params.setupWizard } : {}),
    meta: { ...getChatChannelMeta(DISCORD_CHANNEL) },
    capabilities: {
      chatTypes: ["direct", "channel", "thread"],
      polls: true,
      reactions: true,
      threads: true,
      media: true,
      nativeCommands: true,
    },
    commands: {
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: true,
      resolveNativeCommandName: ({ commandKey, defaultName }) =>
        commandKey === "tts" ? "voice" : defaultName,
    },
    doctor: discordDoctor,
    streaming: {
      blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
    },
    reload: { configPrefixes: ["channels.discord"] },
    configSchema: DiscordChannelConfigSchema,
    config: {
      ...discordConfigAdapter,
      hasConfiguredState: ({ env }) =>
        typeof env?.DISCORD_BOT_TOKEN === "string" && env.DISCORD_BOT_TOKEN.trim().length > 0,
      isConfigured: (account) => Boolean(account.token?.trim()),
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: Boolean(account.token?.trim()),
          extra: {
            tokenSource: account.tokenSource,
          },
        }),
    },
    messaging: {
      deriveLegacySessionChatType,
    },
    secrets: {
      secretTargetRegistryEntries,
      unsupportedSecretRefSurfacePatterns,
      collectUnsupportedSecretRefConfigCandidates,
      collectRuntimeConfigAssignments,
    },
    setup: params.setup,
  } as Pick<
    ChannelPlugin<ResolvedDiscordAccount>,
    | "id"
    | "meta"
    | "setupWizard"
    | "capabilities"
    | "commands"
    | "doctor"
    | "streaming"
    | "reload"
    | "configSchema"
    | "config"
    | "setup"
    | "messaging"
    | "secrets"
  >;
}
