import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import { createScopedChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import { inspectDiscordAccount } from "./account-inspect.js";
import {
  isDiscordAccountEnabledForRuntime,
  listDiscordAccountIds,
  mergeDiscordAccountConfig,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
  resolveDiscordAccountAllowFrom,
  resolveDiscordAccountDisabledReason,
  type ResolvedDiscordAccount,
} from "./accounts.js";
import {
  getChatChannelMeta,
  resolveConfiguredFromCredentialStatuses,
  type ChannelPlugin,
} from "./channel-api.js";
import { DiscordChannelConfigSchema } from "./config-schema.js";
import { normalizeCompatibilityConfig } from "./doctor-contract.js";
import { DISCORD_LEGACY_CONFIG_RULES } from "./doctor-shared.js";
import type { OpenClawConfig } from "./runtime-api.js";
import {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./secret-config-contract.js";
import {
  collectUnsupportedSecretRefConfigCandidates,
  unsupportedSecretRefSurfacePatterns,
} from "./security-contract.js";
import { discordSecurityAdapter } from "./security.js";
import { deriveLegacySessionChatType } from "./session-contract.js";

const DISCORD_CHANNEL = "discord" as const;

type DiscordDoctorModule = typeof import("./doctor.js");
type DiscordConfigAccessorAccount = {
  allowFrom: string[] | undefined;
  defaultTo: string | undefined;
};

let discordDoctorModulePromise: Promise<DiscordDoctorModule> | undefined;

async function loadDiscordDoctorModule(): Promise<DiscordDoctorModule> {
  discordDoctorModulePromise ??= import("./doctor.js");
  return await discordDoctorModulePromise;
}

const discordDoctor: ChannelDoctorAdapter = {
  dmAllowFromMode: "topOnly",
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

function resolveDiscordConfigAccessorAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): DiscordConfigAccessorAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultDiscordAccountId(params.cfg),
  );
  const config = mergeDiscordAccountConfig(params.cfg, accountId);
  return {
    allowFrom: resolveDiscordAccountAllowFrom({ cfg: params.cfg, accountId }),
    defaultTo: config.defaultTo,
  };
}

export const discordConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedDiscordAccount,
  DiscordConfigAccessorAccount
>({
  sectionKey: DISCORD_CHANNEL,
  listAccountIds: listDiscordAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveDiscordAccount),
  resolveAccessorAccount: resolveDiscordConfigAccessorAccount,
  inspectAccount: adaptScopedAccountAccessor(inspectDiscordAccount),
  defaultAccountId: resolveDefaultDiscordAccountId,
  clearBaseFields: ["token", "name"],
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account) => account.defaultTo,
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
  | "security"
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
      tts: {
        voice: {
          synthesisTarget: "voice-note",
        },
      },
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
      isEnabled: (account, cfg) => isDiscordAccountEnabledForRuntime(account, cfg),
      disabledReason: (account, cfg) => resolveDiscordAccountDisabledReason(account, cfg),
      isConfigured: (account) =>
        resolveConfiguredFromCredentialStatuses(account) ?? Boolean(account.token?.trim()),
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured:
            resolveConfiguredFromCredentialStatuses(account) ?? Boolean(account.token?.trim()),
          extra: {
            tokenSource: account.tokenSource,
            tokenStatus: account.tokenStatus,
          },
        }),
    },
    messaging: {
      deriveLegacySessionChatType,
    },
    security: discordSecurityAdapter,
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
    | "security"
    | "secrets"
  >;
}
