// Line plugin module implements setup surface behavior.
import { createChannelDmPolicy } from "openclaw/plugin-sdk/channel-dm-policy";
import {
  createAllowFromSection,
  createPromptParsedAllowFromForAccount,
  createStandardChannelSetupStatus,
  createSetupTranslator,
  defineTokenCredential,
  parseSetupEntriesWithParser,
} from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultLineAccountId } from "./accounts.js";
import {
  isLineConfigured,
  listLineAccountIds,
  parseLineAllowFromId,
  patchLineAccountConfig,
} from "./setup-core.js";
import {
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  resolveLineAccount,
  setSetupChannelEnabled,
  splitSetupEntries,
  type ChannelSetupWizard,
} from "./setup-runtime-api.js";

const t = createSetupTranslator();

const channel = "line" as const;

const LINE_SETUP_HELP_LINES = [
  t("wizard.line.helpOpenConsole"),
  t("wizard.line.helpCopyCredentials"),
  t("wizard.line.helpEnableWebhook"),
  t("wizard.line.helpWebhookUrl"),
  t("wizard.channels.docs", { link: formatDocsLink("/channels/line", "channels/line") }),
];

const LINE_ALLOW_FROM_HELP_LINES = [
  t("wizard.line.allowlistIntro"),
  t("wizard.line.idsCaseSensitive"),
  t("wizard.line.examples"),
  "- U1234567890abcdef1234567890abcdef",
  "- line:user:U1234567890abcdef1234567890abcdef",
  t("wizard.line.multipleEntries"),
  t("wizard.channels.docs", { link: formatDocsLink("/channels/line", "channels/line") }),
];

const promptLineAllowFrom = createPromptParsedAllowFromForAccount({
  defaultAccountId: resolveDefaultLineAccountId,
  noteTitle: t("wizard.line.allowlistTitle"),
  noteLines: LINE_ALLOW_FROM_HELP_LINES,
  message: t("wizard.line.allowFromPrompt"),
  placeholder: "U1234567890abcdef1234567890abcdef",
  parseEntries: (raw) =>
    parseSetupEntriesWithParser(raw, (entry) => {
      const id = parseLineAllowFromId(entry);
      return id ? { value: id } : { error: t("wizard.line.allowFromInvalid") };
    }),
  getExistingAllowFrom: ({ cfg, accountId }) =>
    resolveLineAccount({ cfg, accountId }).config.allowFrom ?? [],
  applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
    patchLineAccountConfig({
      cfg,
      accountId,
      enabled: true,
      patch: { allowFrom },
    }),
});

const lineDmPolicy = createChannelDmPolicy({
  label: "LINE",
  channel,
  resolveAccount: (cfg, accountId) =>
    resolveLineAccount({ cfg, accountId: accountId ?? resolveDefaultLineAccountId(cfg) }),
  applyPatch: ({ cfg, account, patch }) =>
    patchLineAccountConfig({
      cfg,
      accountId: account.accountId,
      enabled: true,
      patch,
      clearFields:
        patch.dmPolicy === "pairing" || patch.dmPolicy === "disabled" ? ["allowFrom"] : undefined,
    }),
  promptAllowFrom: promptLineAllowFrom,
});

export const lineSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "LINE",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsTokenSecret"),
    configuredHint: t("wizard.channels.statusConfigured"),
    unconfiguredHint: t("wizard.channels.statusNeedsTokenSecret"),
    configuredScore: 1,
    unconfiguredScore: 0,
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) =>
      isLineConfigured(cfg, accountId ?? resolveDefaultLineAccountId(cfg)),
    resolveExtraStatusLines: ({ cfg }) => [`Accounts: ${listLineAccountIds(cfg).length || 0}`],
  }),
  introNote: {
    title: t("wizard.line.messagingApiTitle"),
    lines: LINE_SETUP_HELP_LINES,
    shouldShow: ({ cfg, accountId }) =>
      !isLineConfigured(cfg, accountId ?? resolveDefaultLineAccountId(cfg)),
  },
  credentials: [
    defineTokenCredential({
      inputKey: "token",
      configKey: "channelAccessToken",
      configuredFields: ["channelAccessToken", "tokenFile"],
      providerHint: channel,
      credentialLabel: t("wizard.line.channelAccessToken"),
      preferredEnvVar: "LINE_CHANNEL_ACCESS_TOKEN",
      helpTitle: t("wizard.line.messagingApiTitle"),
      helpLines: LINE_SETUP_HELP_LINES,
      envPrompt: t("wizard.line.tokenEnvPrompt"),
      keepPrompt: t("wizard.line.tokenKeepPrompt"),
      inputPrompt: t("wizard.line.tokenInputPrompt"),
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      resolveAccount: ({ cfg, accountId }) => resolveLineAccount({ cfg, accountId }),
      accountConfigured: (account) =>
        Boolean(
          normalizeOptionalString(account.channelAccessToken) &&
          normalizeOptionalString(account.channelSecret),
        ),
      hasConfiguredValue: (account) =>
        Boolean(
          normalizeOptionalString(account.config.channelAccessToken) ??
          normalizeOptionalString(account.config.tokenFile),
        ),
      resolvedValue: (account) => normalizeOptionalString(account.channelAccessToken),
      envValue: ({ accountId }) =>
        accountId === DEFAULT_ACCOUNT_ID
          ? normalizeOptionalString(process.env.LINE_CHANNEL_ACCESS_TOKEN)
          : undefined,
      patchAccount: ({ cfg, accountId, patch, clearFields }) =>
        patchLineAccountConfig({
          cfg,
          accountId,
          enabled: true,
          clearFields,
          patch,
        }),
      useEnv: { clearFields: ["channelAccessToken", "tokenFile"] },
      set: { clearFields: ["tokenFile"], value: "resolved" },
    }),
    defineTokenCredential({
      inputKey: "password",
      configKey: "channelSecret",
      configuredFields: ["channelSecret", "secretFile"],
      providerHint: "line-secret",
      credentialLabel: t("wizard.line.channelSecret"),
      preferredEnvVar: "LINE_CHANNEL_SECRET",
      helpTitle: t("wizard.line.messagingApiTitle"),
      helpLines: LINE_SETUP_HELP_LINES,
      envPrompt: t("wizard.line.secretEnvPrompt"),
      keepPrompt: t("wizard.line.secretKeepPrompt"),
      inputPrompt: t("wizard.line.secretInputPrompt"),
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      resolveAccount: ({ cfg, accountId }) => resolveLineAccount({ cfg, accountId }),
      accountConfigured: (account) =>
        Boolean(
          normalizeOptionalString(account.channelAccessToken) &&
          normalizeOptionalString(account.channelSecret),
        ),
      hasConfiguredValue: (account) =>
        Boolean(
          normalizeOptionalString(account.config.channelSecret) ??
          normalizeOptionalString(account.config.secretFile),
        ),
      resolvedValue: (account) => normalizeOptionalString(account.channelSecret),
      envValue: ({ accountId }) =>
        accountId === DEFAULT_ACCOUNT_ID
          ? normalizeOptionalString(process.env.LINE_CHANNEL_SECRET)
          : undefined,
      patchAccount: ({ cfg, accountId, patch, clearFields }) =>
        patchLineAccountConfig({
          cfg,
          accountId,
          enabled: true,
          clearFields,
          patch,
        }),
      useEnv: { clearFields: ["channelSecret", "secretFile"] },
      set: { clearFields: ["secretFile"], value: "resolved" },
    }),
  ],
  allowFrom: createAllowFromSection({
    helpTitle: t("wizard.line.allowlistTitle"),
    helpLines: LINE_ALLOW_FROM_HELP_LINES,
    message: t("wizard.line.allowFromPrompt"),
    placeholder: "U1234567890abcdef1234567890abcdef",
    invalidWithoutCredentialNote: t("wizard.line.allowFromInvalid"),
    parseInputs: splitSetupEntries,
    parseId: parseLineAllowFromId,
    apply: ({ cfg, accountId, allowFrom }) =>
      patchLineAccountConfig({
        cfg,
        accountId,
        enabled: true,
        patch: { dmPolicy: "allowlist", allowFrom },
      }),
  }),
  dmPolicy: lineDmPolicy,
  completionNote: {
    title: t("wizard.line.webhookTitle"),
    lines: [
      t("wizard.line.completionEnableWebhook"),
      t("wizard.line.completionDefaultWebhook"),
      t("wizard.line.completionWebhookPath"),
      t("wizard.channels.docs", { link: formatDocsLink("/channels/line", "channels/line") }),
    ],
  },
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
