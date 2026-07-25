// Line plugin module implements setup surface behavior.
import {
  createAllowFromSection,
  createStandardChannelSetupStatus,
  defineTokenCredential,
  mergeAllowFromEntries,
  createSetupTranslator,
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
  type ChannelSetupDmPolicy,
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

const lineDmPolicy: ChannelSetupDmPolicy = {
  label: "LINE",
  channel,
  policyKey: "channels.line.dmPolicy",
  allowFromKey: "channels.line.allowFrom",
  resolveConfigKeys: (cfg, accountId) =>
    (accountId ?? resolveDefaultLineAccountId(cfg)) !== DEFAULT_ACCOUNT_ID
      ? {
          policyKey: `channels.line.accounts.${accountId ?? resolveDefaultLineAccountId(cfg)}.dmPolicy`,
          allowFromKey: `channels.line.accounts.${accountId ?? resolveDefaultLineAccountId(cfg)}.allowFrom`,
        }
      : {
          policyKey: "channels.line.dmPolicy",
          allowFromKey: "channels.line.allowFrom",
        },
  getCurrent: (cfg, accountId) =>
    resolveLineAccount({ cfg, accountId: accountId ?? resolveDefaultLineAccountId(cfg) }).config
      .dmPolicy ?? "pairing",
  setPolicy: (cfg, policy, accountId) =>
    patchLineAccountConfig({
      cfg,
      accountId: accountId ?? resolveDefaultLineAccountId(cfg),
      enabled: true,
      patch:
        policy === "open"
          ? {
              dmPolicy: "open",
              allowFrom: mergeAllowFromEntries(
                resolveLineAccount({
                  cfg,
                  accountId: accountId ?? resolveDefaultLineAccountId(cfg),
                }).config.allowFrom,
                ["*"],
              ),
            }
          : { dmPolicy: policy },
      clearFields: policy === "pairing" || policy === "disabled" ? ["allowFrom"] : undefined,
    }),
};

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
