import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/channel-setup";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import type { ChannelSetupDmPolicy, ChannelSetupWizard, DmPolicy } from "openclaw/plugin-sdk/setup";
import {
  createStandardChannelSetupStatus,
  createTopLevelChannelDmPolicy,
  createTopLevelChannelParsedAllowFromPrompt,
  formatDocsLink,
  mergeAllowFromEntries,
  parseSetupEntriesWithParser,
  patchTopLevelChannelConfigSection,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup";
import { DEFAULT_RELAYS } from "./default-relays.js";
import { getPublicKeyFromPrivate, normalizePubkey } from "./nostr-key-utils.js";
import { resolveDefaultNostrAccountId, resolveNostrAccount } from "./types.js";

const channel = "nostr" as const;

const NOSTR_SETUP_HELP_LINES = [
  "Use a Nostr private key in nsec or 64-character hex format.",
  "Relay URLs are optional. Leave blank to keep the default relay set.",
  "Env vars supported: NOSTR_PRIVATE_KEY (default account only).",
  `Docs: ${formatDocsLink("/channels/nostr", "channels/nostr")}`,
];

const NOSTR_ALLOW_FROM_HELP_LINES = [
  "Allowlist Nostr DMs by npub or hex pubkey.",
  "Examples:",
  "- npub1...",
  "- nostr:npub1...",
  "- 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "Multiple entries: comma-separated.",
  `Docs: ${formatDocsLink("/channels/nostr", "channels/nostr")}`,
];

function buildNostrSetupPatch(accountId: string, patch: Record<string, unknown>) {
  return {
    ...(accountId !== DEFAULT_ACCOUNT_ID ? { defaultAccount: accountId } : {}),
    ...patch,
  };
}

function parseRelayUrls(raw: string): { relays: string[]; error?: string } {
  const entries = splitSetupEntries(raw);
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

function parseNostrAllowFrom(raw: string): { entries: string[]; error?: string } {
  return parseSetupEntriesWithParser(raw, (entry) => {
    const cleaned = entry.replace(/^nostr:/i, "").trim();
    try {
      return { value: normalizePubkey(cleaned) };
    } catch {
      return { error: `Invalid Nostr pubkey: ${entry}` };
    }
  });
}

const promptNostrAllowFrom = createTopLevelChannelParsedAllowFromPrompt({
  channel,
  defaultAccountId: resolveDefaultNostrAccountId,
  noteTitle: "Nostr allowlist",
  noteLines: NOSTR_ALLOW_FROM_HELP_LINES,
  message: "Nostr allowFrom",
  placeholder: "npub1..., 0123abcd...",
  parseEntries: parseNostrAllowFrom,
  mergeEntries: ({ existing, parsed }) => mergeAllowFromEntries(existing, parsed),
});

const nostrDmPolicy: ChannelSetupDmPolicy = createTopLevelChannelDmPolicy({
  label: "Nostr",
  channel,
  policyKey: "channels.nostr.dmPolicy",
  allowFromKey: "channels.nostr.allowFrom",
  getCurrent: (cfg) => (cfg.channels?.nostr?.dmPolicy as DmPolicy | undefined) ?? "pairing",
  promptAllowFrom: promptNostrAllowFrom,
});

export const nostrSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ cfg, accountId }) => accountId?.trim() || resolveDefaultNostrAccountId(cfg),
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
      try {
        getPublicKeyFromPrivate(privateKey);
      } catch {
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

export const nostrSetupWizard: ChannelSetupWizard = {
  channel,
  resolveAccountIdForConfigure: ({ accountOverride, defaultAccountId }) =>
    accountOverride?.trim() || defaultAccountId,
  resolveShouldPromptAccountIds: () => false,
  status: createStandardChannelSetupStatus({
    channelLabel: "Nostr",
    configuredLabel: "configured",
    unconfiguredLabel: "needs private key",
    configuredHint: "configured",
    unconfiguredHint: "needs private key",
    configuredScore: 1,
    unconfiguredScore: 0,
    includeStatusLine: true,
    resolveConfigured: ({ cfg }) => resolveNostrAccount({ cfg }).configured,
    resolveExtraStatusLines: ({ cfg }) => {
      const account = resolveNostrAccount({ cfg });
      return [`Relays: ${account.relays.length || DEFAULT_RELAYS.length}`];
    },
  }),
  introNote: {
    title: "Nostr setup",
    lines: NOSTR_SETUP_HELP_LINES,
  },
  envShortcut: {
    prompt: "NOSTR_PRIVATE_KEY detected. Use env var?",
    preferredEnvVar: "NOSTR_PRIVATE_KEY",
    isAvailable: ({ cfg, accountId }) =>
      accountId === DEFAULT_ACCOUNT_ID &&
      Boolean(process.env.NOSTR_PRIVATE_KEY?.trim()) &&
      !hasConfiguredSecretInput(resolveNostrAccount({ cfg, accountId }).config.privateKey),
    apply: async ({ cfg, accountId }) =>
      patchTopLevelChannelConfigSection({
        cfg,
        channel,
        enabled: true,
        clearFields: ["privateKey"],
        patch: buildNostrSetupPatch(accountId, {}),
      }),
  },
  credentials: [
    {
      inputKey: "privateKey",
      providerHint: channel,
      credentialLabel: "private key",
      preferredEnvVar: "NOSTR_PRIVATE_KEY",
      helpTitle: "Nostr private key",
      helpLines: NOSTR_SETUP_HELP_LINES,
      envPrompt: "NOSTR_PRIVATE_KEY detected. Use env var?",
      keepPrompt: "Nostr private key already configured. Keep it?",
      inputPrompt: "Nostr private key (nsec... or hex)",
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const account = resolveNostrAccount({ cfg, accountId });
        return {
          accountConfigured: account.configured,
          hasConfiguredValue: hasConfiguredSecretInput(account.config.privateKey),
          resolvedValue: normalizeSecretInputString(account.config.privateKey),
          envValue: process.env.NOSTR_PRIVATE_KEY?.trim(),
        };
      },
      applyUseEnv: async ({ cfg, accountId }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel,
          enabled: true,
          clearFields: ["privateKey"],
          patch: buildNostrSetupPatch(accountId, {}),
        }),
      applySet: async ({ cfg, accountId, resolvedValue }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel,
          enabled: true,
          patch: buildNostrSetupPatch(accountId, { privateKey: resolvedValue }),
        }),
    },
  ],
  textInputs: [
    {
      inputKey: "relayUrls",
      message: "Relay URLs (comma-separated, optional)",
      placeholder: DEFAULT_RELAYS.join(", "),
      required: false,
      applyEmptyValue: true,
      helpTitle: "Nostr relays",
      helpLines: ["Use ws:// or wss:// relay URLs.", "Leave blank to keep the default relay set."],
      currentValue: ({ cfg, accountId }) => {
        const account = resolveNostrAccount({ cfg, accountId });
        const configuredRelays = cfg.channels?.nostr?.relays as string[] | undefined;
        const relays = configuredRelays && configuredRelays.length > 0 ? account.relays : [];
        return relays.join(", ");
      },
      keepPrompt: (value) => `Relay URLs set (${value}). Keep them?`,
      validate: ({ value }) => parseRelayUrls(value).error,
      applySet: async ({ cfg, accountId, value }) => {
        const relayResult = parseRelayUrls(value);
        return patchTopLevelChannelConfigSection({
          cfg,
          channel,
          enabled: true,
          clearFields: relayResult.relays.length > 0 ? undefined : ["relays"],
          patch: buildNostrSetupPatch(
            accountId,
            relayResult.relays.length > 0 ? { relays: relayResult.relays } : {},
          ),
        });
      },
    },
  ],
  dmPolicy: nostrDmPolicy,
  disable: (cfg) =>
    patchTopLevelChannelConfigSection({
      cfg,
      channel,
      patch: { enabled: false },
    }),
};
