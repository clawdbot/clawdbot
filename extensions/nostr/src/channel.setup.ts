// Nostr plugin module implements channel.setup behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createDelegatedSetupWizardProxy,
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  createSetupTranslator,
} from "openclaw/plugin-sdk/setup-runtime";
import { buildChannelConfigSchema, type ChannelPlugin } from "./channel-api.js";
import { NostrConfigSchema } from "./config-schema.js";
import { DEFAULT_RELAYS } from "./default-relays.js";
import { createNostrSetupAdapter } from "./setup-adapter.js";

const t = createSetupTranslator();

const channel = "nostr" as const;

type NostrAccountConfig = {
  enabled?: boolean;
  name?: string;
  defaultAccount?: string;
  privateKey?: unknown;
  relays?: string[];
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  profile?: unknown;
};

type ResolvedNostrSetupAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  privateKey: string;
  publicKey: string;
  relays: string[];
  profile?: unknown;
  config: NostrAccountConfig;
};

function getNostrConfig(cfg: OpenClawConfig): NostrAccountConfig | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.nostr as
    | NostrAccountConfig
    | undefined;
}

function listSetupNostrAccountIds(cfg: OpenClawConfig): string[] {
  const nostrCfg = getNostrConfig(cfg);
  const privateKey = typeof nostrCfg?.privateKey === "string" ? nostrCfg.privateKey.trim() : "";
  if (!privateKey) {
    return [];
  }
  return [resolveDefaultSetupNostrAccountId(cfg)];
}

function resolveDefaultSetupNostrAccountId(cfg: OpenClawConfig): string {
  const configured = getNostrConfig(cfg)?.defaultAccount;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : DEFAULT_ACCOUNT_ID;
}

function resolveSetupNostrAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedNostrSetupAccount {
  const nostrCfg = getNostrConfig(params.cfg);
  const accountId = params.accountId?.trim() || resolveDefaultSetupNostrAccountId(params.cfg);
  const privateKey = typeof nostrCfg?.privateKey === "string" ? nostrCfg.privateKey.trim() : "";
  const configured = Boolean(privateKey);
  return {
    accountId,
    name: typeof nostrCfg?.name === "string" ? nostrCfg.name : undefined,
    enabled: nostrCfg?.enabled !== false,
    configured,
    privateKey,
    publicKey: "",
    relays: nostrCfg?.relays ?? DEFAULT_RELAYS,
    profile: nostrCfg?.profile,
    config: {
      enabled: nostrCfg?.enabled,
      name: nostrCfg?.name,
      privateKey: nostrCfg?.privateKey,
      relays: nostrCfg?.relays,
      dmPolicy: nostrCfg?.dmPolicy,
      allowFrom: nostrCfg?.allowFrom,
      profile: nostrCfg?.profile,
    },
  };
}

function looksLikeNostrPrivateKey(privateKey: string): boolean {
  return privateKey.startsWith("nsec1") || /^[0-9a-fA-F]{64}$/.test(privateKey);
}

const nostrSetupAdapter = createNostrSetupAdapter({
  resolveAccountId: (cfg, accountId) => accountId?.trim() || resolveDefaultSetupNostrAccountId(cfg),
  validatePrivateKey: looksLikeNostrPrivateKey,
});

const nostrSetupWizard = createDelegatedSetupWizardProxy({
  channel,
  loadWizard: async () => (await import("./setup-surface.js")).nostrSetupWizard,
  status: {
    ...createStandardChannelSetupStatus({
      channelLabel: "Nostr",
      configuredLabel: t("wizard.channels.statusConfigured"),
      unconfiguredLabel: t("wizard.channels.statusNeedsPrivateKey"),
      configuredHint: t("wizard.channels.statusConfigured"),
      unconfiguredHint: t("wizard.channels.statusNeedsPrivateKey"),
      configuredScore: 1,
      unconfiguredScore: 0,
      includeStatusLine: true,
      resolveConfigured: ({ cfg, accountId }) =>
        resolveSetupNostrAccount({ cfg, accountId }).configured,
      resolveExtraStatusLines: ({ cfg }) => {
        const account = resolveSetupNostrAccount({ cfg });
        return [`Relays: ${account.relays.length || DEFAULT_RELAYS.length}`];
      },
    }),
  },
  resolveShouldPromptAccountIds: () => false,
  delegatePrepare: true,
  delegateFinalize: true,
});

export const nostrSetupPlugin: ChannelPlugin<ResolvedNostrSetupAccount> = {
  id: channel,
  meta: {
    id: channel,
    label: "Nostr",
    selectionLabel: "Nostr",
    docsPath: "/channels/nostr",
    docsLabel: "nostr",
    blurb: "Decentralized DMs via Nostr relays (NIP-04)",
    order: 100,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },
  reload: { configPrefixes: ["channels.nostr"] },
  configSchema: buildChannelConfigSchema(NostrConfigSchema),
  setup: nostrSetupAdapter,
  setupWizard: nostrSetupWizard,
  config: {
    listAccountIds: listSetupNostrAccountIds,
    resolveAccount: (cfg, accountId) => resolveSetupNostrAccount({ cfg, accountId }),
    defaultAccountId: resolveDefaultSetupNostrAccountId,
    isConfigured: (account) => account.configured,
    describeAccount: (account) =>
      describeAccountSnapshot({
        account,
        configured: account.configured,
        extra: {
          publicKey: account.publicKey,
        },
      }),
  },
};
