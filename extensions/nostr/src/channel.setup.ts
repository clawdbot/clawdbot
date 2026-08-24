// Nostr plugin module implements channel.setup behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDelegatedSetupWizardProxy } from "openclaw/plugin-sdk/setup-runtime";
import { buildChannelConfigSchema, type ChannelPlugin } from "./channel-api.js";
import { NostrConfigSchema } from "./config-schema.js";
import { DEFAULT_RELAYS } from "./default-relays.js";
import { hasConfiguredNostrPrivateKey, resolveNostrPrivateKey } from "./private-key.js";
import {
  createNostrSetupAdapter,
  createNostrSetupContract,
  createNostrSetupStatus,
} from "./setup-adapter.js";
import type { ResolvedNostrAccount } from "./types.js";

const channel = "nostr" as const;

type NostrAccountConfig = ResolvedNostrAccount["config"];

function getNostrConfig(cfg: OpenClawConfig): NostrAccountConfig | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.nostr as
    | NostrAccountConfig
    | undefined;
}

function resolveDefaultSetupNostrAccountId(cfg: OpenClawConfig): string {
  return normalizeAccountId(getNostrConfig(cfg)?.defaultAccount);
}

function resolveSetupNostrAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedNostrAccount {
  const nostrCfg = getNostrConfig(params.cfg);
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSetupNostrAccountId(params.cfg),
  );
  const privateKey = resolveNostrPrivateKey(nostrCfg?.privateKey);
  const configured = hasConfiguredNostrPrivateKey(nostrCfg?.privateKey);
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

const nostrSetupWizard = createDelegatedSetupWizardProxy({
  channel,
  loadWizard: async () => (await import("./setup-surface.js")).nostrSetupWizard,
  status: createNostrSetupStatus(resolveSetupNostrAccount),
  resolveShouldPromptAccountIds: () => false,
  delegatePrepare: true,
  delegateFinalize: true,
});

export const nostrSetupPlugin: ChannelPlugin<ResolvedNostrAccount> = {
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
  setupContract: createNostrSetupContract(
    createNostrSetupAdapter({
      resolveAccountId: (cfg, accountId) =>
        accountId?.trim() || resolveDefaultSetupNostrAccountId(cfg),
      validatePrivateKey: (privateKey) => /^(?:nsec1|NSEC1)|^[0-9a-fA-F]{64}$/u.test(privateKey),
    }),
  ),
  setupWizard: nostrSetupWizard,
  config: {
    listAccountIds: (cfg) =>
      resolveSetupNostrAccount({ cfg }).configured ? [resolveDefaultSetupNostrAccountId(cfg)] : [],
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
