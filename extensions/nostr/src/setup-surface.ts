// Nostr plugin module implements setup surface behavior.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
// Nostr plugin module implements setup surface behavior.
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import type { ChannelSetupDmPolicy, ChannelSetupWizard, DmPolicy } from "openclaw/plugin-sdk/setup";
import {
  createSetupTranslator,
  createStandardChannelSetupStatus,
  createTopLevelChannelDmPolicy,
  createTopLevelChannelParsedAllowFromPrompt,
  formatDocsLink,
  mergeAllowFromEntries,
  parseSetupEntriesWithParser,
  patchTopLevelChannelConfigSection,
} from "openclaw/plugin-sdk/setup";
import { DEFAULT_RELAYS } from "./default-relays.js";
import { getPublicKeyFromPrivate, normalizePubkey } from "./nostr-key-utils.js";
import { buildNostrSetupPatch, createNostrSetupAdapter, parseRelayUrls } from "./setup-adapter.js";
import { resolveDefaultNostrAccountId, resolveNostrAccount } from "./types.js";

const t = createSetupTranslator();

const channel = "nostr" as const;
const NOSTR_SETUP_HELP_LINES = [
  t("wizard.nostr.helpPrivateKeyFormat"),
  t("wizard.nostr.helpRelaysOptional"),
  t("wizard.nostr.helpEnvVars"),
  `Docs: ${formatDocsLink("/channels/nostr", "channels/nostr")}`,
];

const NOSTR_ALLOW_FROM_HELP_LINES = [
  t("wizard.nostr.allowlistIntro"),
  t("wizard.nostr.examples"),
  "- npub1...",
  "- nostr:npub1...",
  "- 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  t("wizard.nostr.multipleEntries"),
  `Docs: ${formatDocsLink("/channels/nostr", "channels/nostr")}`,
];

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
  noteTitle: t("wizard.nostr.allowlistTitle"),
  noteLines: NOSTR_ALLOW_FROM_HELP_LINES,
  message: t("wizard.nostr.allowFromPrompt"),
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

export const nostrSetupAdapter = createNostrSetupAdapter({
  resolveAccountId: (cfg, accountId) => accountId?.trim() || resolveDefaultNostrAccountId(cfg),
  validatePrivateKey: (privateKey) => {
    try {
      getPublicKeyFromPrivate(privateKey);
      return true;
    } catch {
      return false;
    }
  },
});

export const nostrSetupWizard: ChannelSetupWizard = {
  channel,
  resolveAccountIdForConfigure: ({ accountOverride, defaultAccountId }) =>
    accountOverride?.trim() || defaultAccountId,
  resolveShouldPromptAccountIds: () => false,
  status: createStandardChannelSetupStatus({
    channelLabel: "Nostr",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsPrivateKey"),
    configuredHint: t("wizard.channels.statusConfigured"),
    unconfiguredHint: t("wizard.channels.statusNeedsPrivateKey"),
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
    title: t("wizard.nostr.setupTitle"),
    lines: NOSTR_SETUP_HELP_LINES,
  },
  envShortcut: {
    prompt: t("wizard.nostr.privateKeyEnvPrompt"),
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
      helpTitle: t("wizard.nostr.privateKeyTitle"),
      helpLines: NOSTR_SETUP_HELP_LINES,
      envPrompt: t("wizard.nostr.privateKeyEnvPrompt"),
      keepPrompt: t("wizard.nostr.privateKeyKeep"),
      inputPrompt: t("wizard.nostr.privateKeyInput"),
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
      message: t("wizard.nostr.relayUrlsPrompt"),
      placeholder: DEFAULT_RELAYS.join(", "),
      required: false,
      applyEmptyValue: true,
      helpTitle: t("wizard.nostr.relaysTitle"),
      helpLines: [t("wizard.nostr.relaysWsOnly"), t("wizard.nostr.helpRelaysOptional")],
      currentValue: ({ cfg, accountId }) => {
        const account = resolveNostrAccount({ cfg, accountId });
        const configuredRelays = cfg.channels?.nostr?.relays as string[] | undefined;
        const relays = configuredRelays && configuredRelays.length > 0 ? account.relays : [];
        return relays.join(", ");
      },
      keepPrompt: (value) => t("wizard.nostr.relayUrlsKeep", { value }),
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
