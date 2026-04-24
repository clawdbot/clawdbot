import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { patchTopLevelChannelConfigSection } from "openclaw/plugin-sdk/setup";
import {
  createDelegatedSetupWizardProxy,
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  type ChannelSetupAdapter,
} from "openclaw/plugin-sdk/setup-runtime";
import { buildChannelConfigSchema, type ChannelPlugin } from "./channel-api.js";
import { NostrConfigSchema } from "./config-schema.js";
import { DEFAULT_RELAYS } from "./default-relays.js";

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

function buildNostrSetupPatch(accountId: string, patch: Record<string, unknown>) {
  return {
    ...(accountId !== DEFAULT_ACCOUNT_ID ? { defaultAccount: accountId } : {}),
    ...patch,
  };
}

function parseRelayUrls(raw: string): { relays: string[]; error?: string } {
  const entries = raw
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const relays: string[] = [];
  for (const entry of entries) {
    try {
      const parsed = new URL(entry);
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        return { relays: [], error: `Relay must use ws:// or wss:// (${entry})` };
      }
    } catch {
      return { relays: [], error: `Invalid relay URL: ${entry}` };
    }
    relays.push(entry);
  }
  return { relays: [...new Set(relays)] };
}

function looksLikeNostrPrivateKey(privateKey: string): boolean {
  return privateKey.startsWith("nsec1") || /^[0-9a-fA-F]{64}$/.test(privateKey);
}

const nostrSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ cfg, accountId }) =>
    accountId?.trim() || resolveDefaultSetupNostrAccountId(cfg),
  applyAccountName: ({ cfg, accountId, name }) =>
    patchTopLevelChannelConfigSection({
      cfg,
      channel,
      patch: buildNostrSetupPatch(accountId, name?.trim() ? { name: name.trim() } : {}),
    }),
  validateInput: ({ input }) => {
    const typedInput = input as {
      useEnv?: boolean;
      privateKey?: string;
      relayUrls?: string;
    };
    if (!typedInput.useEnv) {
      const privateKey = typedInput.privateKey?.trim();
      if (!privateKey) {
        return "Nostr requires --private-key or --use-env.";
      }
      if (!looksLikeNostrPrivateKey(privateKey)) {
        return "Nostr private key must be valid nsec or 64-character hex.";
      }
    }
    if (typedInput.relayUrls?.trim()) {
      return parseRelayUrls(typedInput.relayUrls).error ?? null;
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const typedInput = input as {
      useEnv?: boolean;
      privateKey?: string;
      relayUrls?: string;
    };
    const relayResult = typedInput.relayUrls?.trim()
      ? parseRelayUrls(typedInput.relayUrls)
      : { relays: [] };
    return patchTopLevelChannelConfigSection({
      cfg,
      channel,
      enabled: true,
      clearFields: typedInput.useEnv ? ["privateKey"] : undefined,
      patch: buildNostrSetupPatch(accountId, {
        ...(typedInput.useEnv ? {} : { privateKey: typedInput.privateKey?.trim() }),
        ...(relayResult.relays.length > 0 ? { relays: relayResult.relays } : {}),
      }),
    });
  },
};

const nostrSetupWizard = createDelegatedSetupWizardProxy({
  channel,
  loadWizard: async () => (await import("./setup-surface.js")).nostrSetupWizard,
  status: {
    ...createStandardChannelSetupStatus({
      channelLabel: "Nostr",
      configuredLabel: "configured",
      unconfiguredLabel: "needs private key",
      configuredHint: "configured",
      unconfiguredHint: "needs private key",
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
