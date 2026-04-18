import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-core";
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  collectOpenGroupPolicyRouteAllowlistWarnings,
  createAllowlistProviderGroupPolicyWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { createChannelPluginBase, getChatChannelMeta } from "openclaw/plugin-sdk/core";
import {
  createDelegatedSetupWizardProxy,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup-runtime";
import {
  hasAnyWhatsAppAuth,
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  type ResolvedWhatsAppAccount,
} from "./accounts.js";
import { formatWhatsAppConfigAllowFromEntries } from "./config-accessors.js";
import { WhatsAppChannelConfigSchema } from "./config-schema.js";
import { whatsappDoctor } from "./doctor.js";
import { resolveLegacyGroupSessionKey } from "./group-session-contract.js";
import {
  collectUnsupportedSecretRefConfigCandidates,
  unsupportedSecretRefSurfacePatterns,
} from "./security-contract.js";
import { applyWhatsAppSecurityConfigFixes } from "./security-fix.js";
import { canonicalizeLegacySessionKey, isLegacyGroupSessionKey } from "./session-contract.js";

export const WHATSAPP_CHANNEL = "whatsapp" as const;

const WHATSAPP_GROUP_SCOPE_FIELDS = ["groupPolicy", "groupAllowFrom", "groups"] as const;

type WhatsAppGroupScopeField = (typeof WHATSAPP_GROUP_SCOPE_FIELDS)[number];

function resolveWhatsAppAccountKey(
  accounts: Record<string, unknown> | undefined,
  accountId: string,
): string | undefined {
  if (!accounts) {
    return undefined;
  }
  if (Object.hasOwn(accounts, accountId)) {
    return accountId;
  }
  const normalizedAccountId = accountId.trim().toLowerCase();
  return Object.keys(accounts).find((key) => key.trim().toLowerCase() === normalizedAccountId);
}

function resolveWhatsAppGroupScopeBasePath(params: {
  cfg: Parameters<typeof resolveWhatsAppAccount>[0]["cfg"];
  accountId?: string | null;
}): string {
  const accountId =
    typeof params.accountId === "string"
      ? params.accountId.trim() || DEFAULT_ACCOUNT_ID
      : DEFAULT_ACCOUNT_ID;
  const accounts = params.cfg.channels?.whatsapp?.accounts;
  const accountKey = resolveWhatsAppAccountKey(accounts, accountId);
  const defaultAccountKey = resolveWhatsAppAccountKey(accounts, DEFAULT_ACCOUNT_ID);
  const accountConfig = accountKey ? accounts?.[accountKey] : undefined;
  const defaultAccountConfig = defaultAccountKey ? accounts?.[defaultAccountKey] : undefined;
  const matchesAnyGroupScopeField = (config: Record<string, unknown> | undefined): boolean =>
    WHATSAPP_GROUP_SCOPE_FIELDS.some((field) => config?.[field] !== undefined);
  if (matchesAnyGroupScopeField(accountConfig)) {
    return `channels.whatsapp.accounts.${accountKey}`;
  }
  if (accountId !== DEFAULT_ACCOUNT_ID && matchesAnyGroupScopeField(defaultAccountConfig)) {
    return `channels.whatsapp.accounts.${defaultAccountKey}`;
  }
  return "channels.whatsapp";
}

function resolveWhatsAppConfigPath(params: {
  cfg: Parameters<typeof resolveWhatsAppAccount>[0]["cfg"];
  accountId?: string | null;
  field: WhatsAppGroupScopeField;
}): string {
  return `${resolveWhatsAppGroupScopeBasePath(params)}.${params.field}`;
}

export async function loadWhatsAppChannelRuntime() {
  return await import("./channel.runtime.js");
}

export const whatsappSetupWizardProxy = createWhatsAppSetupWizardProxy(
  async () => (await loadWhatsAppChannelRuntime()).whatsappSetupWizard,
);

const whatsappConfigAdapter = createScopedChannelConfigAdapter<ResolvedWhatsAppAccount>({
  sectionKey: WHATSAPP_CHANNEL,
  listAccountIds: listWhatsAppAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveWhatsAppAccount),
  defaultAccountId: resolveDefaultWhatsAppAccountId,
  clearBaseFields: [],
  allowTopLevel: false,
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => formatWhatsAppConfigAllowFromEntries(allowFrom),
  resolveDefaultTo: (account) => account.defaultTo,
});

const whatsappResolveDmPolicy = createScopedDmSecurityResolver<ResolvedWhatsAppAccount>({
  channelKey: WHATSAPP_CHANNEL,
  resolvePolicy: (account) => account.dmPolicy,
  resolveAllowFrom: (account) => account.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => normalizeE164(raw),
  inheritSharedDefaultsFromDefaultAccount: true,
});

export function createWhatsAppSetupWizardProxy(
  loadWizard: () => Promise<ChannelSetupWizard>,
): ChannelSetupWizard {
  return createDelegatedSetupWizardProxy({
    channel: WHATSAPP_CHANNEL,
    loadWizard,
    status: {
      configuredLabel: "linked",
      unconfiguredLabel: "not linked",
      configuredHint: "linked",
      unconfiguredHint: "not linked",
      configuredScore: 5,
      unconfiguredScore: 4,
    },
    resolveShouldPromptAccountIds: (params) => params.shouldPromptAccountIds,
    credentials: [],
    delegateFinalize: true,
    disable: (cfg) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        whatsapp: {
          ...cfg.channels?.whatsapp,
          enabled: false,
        },
      },
    }),
    onAccountRecorded: (accountId, options) => {
      options?.onAccountId?.(WHATSAPP_CHANNEL, accountId);
    },
  });
}

export function createWhatsAppPluginBase(params: {
  groups: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["groups"]>;
  setupWizard: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["setupWizard"]>;
  setup: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["setup"]>;
  isConfigured: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["config"]>["isConfigured"];
}) {
  const collectWhatsAppSecurityWarnings = createAllowlistProviderGroupPolicyWarningCollector<{
    account: ResolvedWhatsAppAccount;
    cfg: Parameters<typeof resolveWhatsAppAccount>[0]["cfg"];
    accountId?: string | null;
  }>({
    providerConfigPresent: (cfg) => cfg.channels?.whatsapp !== undefined,
    resolveGroupPolicy: ({ account }) => account.groupPolicy,
    collect: ({ account, accountId, cfg, groupPolicy }) =>
      collectOpenGroupPolicyRouteAllowlistWarnings({
        groupPolicy,
        routeAllowlistConfigured:
          Boolean(account.groups) && Object.keys(account.groups ?? {}).length > 0,
        restrictSenders: {
          surface: "WhatsApp groups",
          openScope: "any member in allowed groups",
          groupPolicyPath: resolveWhatsAppConfigPath({ cfg, accountId, field: "groupPolicy" }),
          groupAllowFromPath: resolveWhatsAppConfigPath({
            cfg,
            accountId,
            field: "groupAllowFrom",
          }),
        },
        noRouteAllowlist: {
          surface: "WhatsApp groups",
          routeAllowlistPath: resolveWhatsAppConfigPath({ cfg, accountId, field: "groups" }),
          routeScope: "group",
          groupPolicyPath: resolveWhatsAppConfigPath({ cfg, accountId, field: "groupPolicy" }),
          groupAllowFromPath: resolveWhatsAppConfigPath({
            cfg,
            accountId,
            field: "groupAllowFrom",
          }),
        },
      }),
  });
  const base = createChannelPluginBase({
    id: WHATSAPP_CHANNEL,
    meta: {
      ...getChatChannelMeta(WHATSAPP_CHANNEL),
      showConfigured: false,
      quickstartAllowFrom: true,
      forceAccountBinding: true,
      preferSessionLookupForAnnounceTarget: true,
    },
    setupWizard: params.setupWizard,
    capabilities: {
      chatTypes: ["direct", "group"],
      polls: true,
      reactions: true,
      media: true,
    },
    reload: { configPrefixes: ["web"], noopPrefixes: ["channels.whatsapp"] },
    gatewayMethods: ["web.login.start", "web.login.wait"],
    configSchema: WhatsAppChannelConfigSchema,
    config: {
      ...whatsappConfigAdapter,
      isEnabled: (account, cfg) => account.enabled && cfg.web?.enabled !== false,
      disabledReason: () => "disabled",
      isConfigured: params.isConfigured,
      hasPersistedAuthState: ({ cfg }) => hasAnyWhatsAppAuth(cfg),
      unconfiguredReason: () => "not linked",
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: Boolean(account.authDir),
          extra: {
            linked: Boolean(account.authDir),
            dmPolicy: account.dmPolicy,
            allowFrom: account.allowFrom,
          },
        }),
    },
    security: {
      applyConfigFixes: applyWhatsAppSecurityConfigFixes,
      resolveDmPolicy: whatsappResolveDmPolicy,
      collectWarnings: collectWhatsAppSecurityWarnings,
    },
    doctor: whatsappDoctor,
    setup: params.setup,
    groups: params.groups,
  });
  return {
    ...base,
    setupWizard: base.setupWizard!,
    capabilities: base.capabilities!,
    reload: base.reload!,
    gatewayMethods: base.gatewayMethods!,
    configSchema: base.configSchema!,
    config: base.config!,
    messaging: {
      defaultMarkdownTableMode: "bullets",
      resolveLegacyGroupSessionKey,
      isLegacyGroupSessionKey,
      canonicalizeLegacySessionKey: (params) =>
        canonicalizeLegacySessionKey({ key: params.key, agentId: params.agentId }),
    },
    secrets: {
      unsupportedSecretRefSurfacePatterns,
      collectUnsupportedSecretRefConfigCandidates,
    },
    security: base.security!,
    groups: base.groups!,
  } satisfies Pick<
    ChannelPlugin<ResolvedWhatsAppAccount>,
    | "id"
    | "meta"
    | "setupWizard"
    | "capabilities"
    | "reload"
    | "gatewayMethods"
    | "configSchema"
    | "config"
    | "messaging"
    | "secrets"
    | "security"
    | "doctor"
    | "setup"
    | "groups"
  >;
}
