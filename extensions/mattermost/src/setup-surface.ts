// Mattermost plugin module implements setup surface behavior.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  applySetupAccountConfigPatch,
  baseUrlTextInput,
  createStandardChannelSetupStatus,
  defineTokenCredential,
  formatDocsLink,
  createSetupTranslator,
  setSetupChannelEnabled,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import {
  applyMattermostSetupConfigPatch,
  isMattermostConfigured,
  resolveMattermostAccountWithSecrets,
} from "./setup-core.js";
import { normalizeMattermostBaseUrl } from "./setup.client.runtime.js";
import { hasConfiguredSecretInput } from "./setup.secret-input.runtime.js";

const t = createSetupTranslator();

const channel = "mattermost" as const;
export { mattermostSetupAdapter } from "./setup-core.js";

export const mattermostSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "Mattermost",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsTokenUrl"),
    configuredHint: t("wizard.channels.statusConfigured"),
    unconfiguredHint: t("wizard.channels.statusNeedsSetup"),
    configuredScore: 2,
    unconfiguredScore: 1,
    resolveConfigured: ({ cfg, accountId }) =>
      isMattermostConfigured(
        resolveMattermostAccountWithSecrets(cfg, accountId ?? DEFAULT_ACCOUNT_ID),
      ),
  }),
  introNote: {
    title: t("wizard.mattermost.botTokenTitle"),
    lines: [
      t("wizard.mattermost.helpOpenConsole"),
      t("wizard.mattermost.helpCreateBot"),
      t("wizard.mattermost.helpBaseUrl"),
      t("wizard.mattermost.helpBotMember"),
      t("wizard.channels.docs", { link: formatDocsLink("/mattermost", "mattermost") }),
    ],
    shouldShow: ({ cfg, accountId }) =>
      !isMattermostConfigured(resolveMattermostAccountWithSecrets(cfg, accountId)),
  },
  envShortcut: {
    prompt: t("wizard.mattermost.envPrompt"),
    preferredEnvVar: "MATTERMOST_BOT_TOKEN",
    isAvailable: ({ cfg, accountId }) => {
      if (accountId !== DEFAULT_ACCOUNT_ID) {
        return false;
      }
      const resolvedAccount = resolveMattermostAccountWithSecrets(cfg, accountId);
      const hasConfigValues =
        hasConfiguredSecretInput(resolvedAccount.config.botToken) ||
        Boolean(resolvedAccount.config.baseUrl?.trim());
      return Boolean(
        process.env.MATTERMOST_BOT_TOKEN?.trim() &&
        process.env.MATTERMOST_URL?.trim() &&
        !hasConfigValues,
      );
    },
    apply: ({ cfg, accountId }) =>
      applySetupAccountConfigPatch({
        cfg,
        channelKey: channel,
        accountId,
        patch: {},
      }),
  },
  credentials: [
    defineTokenCredential({
      inputKey: "botToken",
      configKey: "botToken",
      providerHint: channel,
      credentialLabel: t("wizard.mattermost.botToken"),
      preferredEnvVar: "MATTERMOST_BOT_TOKEN",
      envPrompt: t("wizard.mattermost.envPrompt"),
      keepPrompt: t("wizard.mattermost.botTokenKeep"),
      inputPrompt: t("wizard.mattermost.botTokenInput"),
      resolveAccount: ({ cfg, accountId }) => resolveMattermostAccountWithSecrets(cfg, accountId),
      accountConfigured: isMattermostConfigured,
      patchAccount: ({ cfg, accountId, patch }) =>
        applyMattermostSetupConfigPatch({
          cfg,
          accountId,
          patch,
        }),
      set: {},
    }),
  ],
  textInputs: [
    baseUrlTextInput({
      inputKey: "httpUrl",
      configKey: "baseUrl",
      message: t("wizard.mattermost.baseUrlPrompt"),
      confirmCurrentValue: false,
      resolveAccount: ({ cfg, accountId }) => resolveMattermostAccountWithSecrets(cfg, accountId),
      currentValue: (account) => account.baseUrl ?? process.env.MATTERMOST_URL?.trim(),
      includeInitialValue: true,
      shouldPrompt: ({ cfg, accountId, credentialValues, currentValue }) => {
        const resolvedAccount = resolveMattermostAccountWithSecrets(cfg, accountId);
        const tokenConfigured =
          Boolean(resolvedAccount.botToken?.trim()) ||
          hasConfiguredSecretInput(resolvedAccount.config.botToken);
        return Boolean(credentialValues.botToken) || !tokenConfigured || !currentValue;
      },
      validate: (value) =>
        normalizeMattermostBaseUrl(value)
          ? undefined
          : "Mattermost base URL must include a valid base URL.",
      normalize: (value) => normalizeMattermostBaseUrl(value) ?? value.trim(),
      patchAccount: ({ cfg, accountId, patch }) =>
        applyMattermostSetupConfigPatch({
          cfg,
          accountId,
          patch,
        }),
    }),
  ],
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
