import { resolveNormalizedAccountEntry } from "openclaw/plugin-sdk/account-core";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChannelPluginBase, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { inspectTelegramAccount } from "./account-inspect.js";
import {
  listTelegramAccountIds,
  mergeTelegramAccountConfig,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
  type ResolvedTelegramAccount,
} from "./accounts.js";
import {
  buildTelegramCommandsListChannelData,
  buildTelegramModelBrowseChannelData,
  buildTelegramModelsAddProviderChannelData,
  buildTelegramModelsListChannelData,
  buildTelegramModelsMenuChannelData,
  buildTelegramModelsProviderChannelData,
} from "./command-ui.js";
import { TelegramChannelConfigSchema } from "./config-schema.js";
import { telegramDoctor } from "./doctor.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { telegramSecurityAdapter } from "./security.js";
import { namedAccountPromotionKeys, singleAccountKeysToMove } from "./setup-contract.js";

const TELEGRAM_CHANNEL = "telegram" as const;

type TelegramConfigAccessorAccount = {
  config: TelegramAccountConfig;
};

export function findTelegramTokenOwnerAccountId(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): string | null {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const tokenOwners = new Map<string, string>();
  for (const id of listTelegramAccountIds(params.cfg)) {
    const account = inspectTelegramAccount({ cfg: params.cfg, accountId: id });
    const token = (account.token ?? "").trim();
    if (!token) {
      continue;
    }
    const ownerAccountId = tokenOwners.get(token);
    if (!ownerAccountId) {
      tokenOwners.set(token, account.accountId);
      continue;
    }
    if (account.accountId === normalizedAccountId) {
      return ownerAccountId;
    }
  }
  return null;
}

export function formatDuplicateTelegramTokenReason(params: {
  accountId: string;
  ownerAccountId: string;
}): string {
  return (
    `Duplicate Telegram bot token: account "${params.accountId}" shares a token with ` +
    `account "${params.ownerAccountId}". Keep one owner account per bot token.`
  );
}

/**
 * Returns true when the runtime token resolver (`resolveTelegramToken`) would
 * block channel-level fallthrough for the given accountId.  This mirrors the
 * guard in `token.ts` so that status-check functions (`isConfigured`,
 * `unconfiguredReason`, `describeAccount`) stay consistent with the gateway
 * runtime behaviour.
 *
 * The guard fires when:
 *   1. The accountId is not the default account, AND
 *   2. The config has an explicit `accounts` section with entries, AND
 *   3. The accountId is not found in that `accounts` section.
 *
 * See: https://github.com/openclaw/openclaw/issues/53876
 */
function isBlockedByMultiBotGuard(cfg: OpenClawConfig, accountId: string): boolean {
  if (normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID) {
    return false;
  }
  const accounts = cfg.channels?.telegram?.accounts;
  const hasConfiguredAccounts =
    !!accounts &&
    typeof accounts === "object" &&
    !Array.isArray(accounts) &&
    Object.keys(accounts).length > 0;
  if (!hasConfiguredAccounts) {
    return false;
  }
  // Use resolveNormalizedAccountEntry (same as resolveTelegramToken in token.ts)
  // instead of resolveAccountEntry to handle keys that require full normalization
  // (e.g. "Carey Notifications" → "carey-notifications").
  return !resolveNormalizedAccountEntry(accounts, accountId, normalizeAccountId);
}

function resolveTelegramConfigAccessorAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): TelegramConfigAccessorAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultTelegramAccountId(params.cfg),
  );
  return { config: mergeTelegramAccountConfig(params.cfg, accountId) };
}

export const telegramConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedTelegramAccount,
  TelegramConfigAccessorAccount
>({
  sectionKey: TELEGRAM_CHANNEL,
  listAccountIds: listTelegramAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveTelegramAccount),
  resolveAccessorAccount: resolveTelegramConfigAccessorAccount,
  inspectAccount: adaptScopedAccountAccessor(inspectTelegramAccount),
  defaultAccountId: resolveDefaultTelegramAccountId,
  clearBaseFields: ["botToken", "tokenFile", "name"],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(telegram|tg):/i }),
  resolveDefaultTo: (account) => account.config.defaultTo,
});

export function createTelegramPluginBase(params: {
  setupWizard: NonNullable<ChannelPlugin<ResolvedTelegramAccount>["setupWizard"]>;
  setup: NonNullable<ChannelPlugin<ResolvedTelegramAccount>["setup"]>;
}): Pick<
  ChannelPlugin<ResolvedTelegramAccount>,
  | "id"
  | "meta"
  | "setupWizard"
  | "capabilities"
  | "commands"
  | "doctor"
  | "security"
  | "reload"
  | "configSchema"
  | "config"
  | "setup"
  | "secrets"
> {
  const base = createChannelPluginBase({
    id: TELEGRAM_CHANNEL,
    meta: {
      ...getChatChannelMeta(TELEGRAM_CHANNEL),
      quickstartAllowFrom: true,
    },
    setupWizard: params.setupWizard,
    capabilities: {
      chatTypes: ["direct", "group", "channel", "thread"],
      reactions: true,
      threads: true,
      media: true,
      tts: {
        voice: {
          synthesisTarget: "voice-note",
        },
      },
      polls: true,
      nativeCommands: true,
      blockStreaming: true,
    },
    commands: {
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: true,
      buildCommandsListChannelData: buildTelegramCommandsListChannelData,
      buildModelsMenuChannelData: buildTelegramModelsMenuChannelData,
      buildModelsProviderChannelData: buildTelegramModelsProviderChannelData,
      buildModelsAddProviderChannelData: buildTelegramModelsAddProviderChannelData,
      buildModelsListChannelData: buildTelegramModelsListChannelData,
      buildModelBrowseChannelData: buildTelegramModelBrowseChannelData,
    },
    doctor: telegramDoctor,
    security: telegramSecurityAdapter,
    reload: { configPrefixes: ["channels.telegram"] },
    configSchema: TelegramChannelConfigSchema,
    config: {
      ...telegramConfigAdapter,
      hasConfiguredState: ({ env }) =>
        typeof env?.TELEGRAM_BOT_TOKEN === "string" && env.TELEGRAM_BOT_TOKEN.trim().length > 0,
      isConfigured: (account, cfg) => {
        // Use inspectTelegramAccount for a complete token resolution that includes
        // channel-level fallback paths not available in resolveTelegramAccount.
        // This ensures binding-created accountIds that inherit the channel-level
        // token are correctly detected as configured.
        // See: https://github.com/openclaw/openclaw/issues/53876
        if (isBlockedByMultiBotGuard(cfg, account.accountId)) {
          return false;
        }
        const inspected = inspectTelegramAccount({ cfg, accountId: account.accountId });
        // Gate on actually available token, not just "configured" — the latter
        // includes "configured_unavailable" (unreadable tokenFile, unresolved
        // SecretRef) which would pass here but fail at runtime.
        if (!inspected.token?.trim()) {
          return false;
        }
        return !findTelegramTokenOwnerAccountId({ cfg, accountId: account.accountId });
      },
      unconfiguredReason: (account, cfg) => {
        if (isBlockedByMultiBotGuard(cfg, account.accountId)) {
          return `not configured: unknown accountId "${account.accountId}" in multi-bot setup`;
        }
        const inspected = inspectTelegramAccount({ cfg, accountId: account.accountId });
        if (!inspected.token?.trim()) {
          if (inspected.tokenStatus === "configured_unavailable") {
            return `not configured: token ${inspected.tokenSource} is configured but unavailable`;
          }
          return "not configured";
        }
        const ownerAccountId = findTelegramTokenOwnerAccountId({
          cfg,
          accountId: account.accountId,
        });
        if (!ownerAccountId) {
          return "not configured";
        }
        return formatDuplicateTelegramTokenReason({
          accountId: account.accountId,
          ownerAccountId,
        });
      },
      describeAccount: (account, cfg) => {
        if (isBlockedByMultiBotGuard(cfg, account.accountId)) {
          return {
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: false,
            tokenSource: "none" as const,
          };
        }
        const inspected = inspectTelegramAccount({ cfg, accountId: account.accountId });
        return {
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured:
            !!inspected.token?.trim() &&
            !findTelegramTokenOwnerAccountId({ cfg, accountId: account.accountId }),
          tokenSource: inspected.tokenSource,
        };
      },
    },
    setup: {
      ...params.setup,
      namedAccountPromotionKeys,
      singleAccountKeysToMove,
    },
  });
  return {
    ...base,
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
  } as Pick<
    ChannelPlugin<ResolvedTelegramAccount>,
    | "id"
    | "meta"
    | "setupWizard"
    | "capabilities"
    | "commands"
    | "doctor"
    | "security"
    | "reload"
    | "configSchema"
    | "config"
    | "setup"
    | "secrets"
  >;
}
