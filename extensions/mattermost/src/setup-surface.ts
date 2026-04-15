import {
  createStandardChannelSetupStatus,
  formatDocsLink,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import {
  applySetupAccountConfigPatch,
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
} from "./runtime-api.js";
import { isMattermostConfigured, resolveMattermostAccountWithSecrets } from "./setup-core.js";
import { normalizeMattermostBaseUrl } from "./setup.client.runtime.js";
import { hasConfiguredSecretInput } from "./setup.secret-input.runtime.js";

const channel = "mattermost" as const;
export { mattermostSetupAdapter } from "./setup-core.js";

export const mattermostSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "Mattermost",
    configuredLabel: "configured",
    unconfiguredLabel: "needs token + url",
    configuredHint: "configured",
    unconfiguredHint: "needs setup",
    configuredScore: 2,
    unconfiguredScore: 1,
    resolveConfigured: ({ cfg, accountId }) =>
      isMattermostConfigured(
        resolveMattermostAccountWithSecrets(cfg, accountId ?? DEFAULT_ACCOUNT_ID),
      ),
  }),
  introNote: {
    title: "Mattermost bot token",
    lines: [
      "1) Mattermost System Console -> Integrations -> Bot Accounts",
      "2) Create a bot + copy its token",
      "3) Use your server base URL (e.g., https://chat.example.com)",
      "Tip: the bot must be a member of any channel you want it to monitor.",
      `Docs: ${formatDocsLink("/mattermost", "mattermost")}`,
    ],
    shouldShow: ({ cfg, accountId }) =>
      !isMattermostConfigured(resolveMattermostAccountWithSecrets(cfg, accountId)),
  },
  envShortcut: {
    prompt: "MATTERMOST_BOT_TOKEN + MATTERMOST_URL detected. Use env vars?",
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
    {
      inputKey: "botToken",
      providerHint: channel,
      credentialLabel: "bot token",
      preferredEnvVar: "MATTERMOST_BOT_TOKEN",
      envPrompt: "MATTERMOST_BOT_TOKEN + MATTERMOST_URL detected. Use env vars?",
      keepPrompt: "Mattermost bot token already configured. Keep it?",
      inputPrompt: "Enter Mattermost bot token",
      inspect: ({ cfg, accountId }) => {
        const resolvedAccount = resolveMattermostAccountWithSecrets(cfg, accountId);
        return {
          accountConfigured: isMattermostConfigured(resolvedAccount),
          hasConfiguredValue: hasConfiguredSecretInput(resolvedAccount.config.botToken),
        };
      },
    },
  ],
  textInputs: [
    {
      inputKey: "httpUrl",
      message: "Enter Mattermost base URL",
      confirmCurrentValue: false,
      currentValue: ({ cfg, accountId }) =>
        resolveMattermostAccountWithSecrets(cfg, accountId).baseUrl ??
        process.env.MATTERMOST_URL?.trim(),
      initialValue: ({ cfg, accountId }) =>
        resolveMattermostAccountWithSecrets(cfg, accountId).baseUrl ??
        process.env.MATTERMOST_URL?.trim(),
      shouldPrompt: ({ cfg, accountId, credentialValues, currentValue }) => {
        const resolvedAccount = resolveMattermostAccountWithSecrets(cfg, accountId);
        const tokenConfigured =
          Boolean(resolvedAccount.botToken?.trim()) ||
          hasConfiguredSecretInput(resolvedAccount.config.botToken);
        return Boolean(credentialValues.botToken) || !tokenConfigured || !currentValue;
      },
      validate: ({ value }) =>
        normalizeMattermostBaseUrl(value)
          ? undefined
          : "Mattermost base URL must include a valid base URL.",
      normalizeValue: ({ value }) => normalizeMattermostBaseUrl(value) ?? value.trim(),
    },
  ],
  disable: (cfg: OpenClawConfig) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      mattermost: {
        ...cfg.channels?.mattermost,
        enabled: false,
      },
    },
  }),
};
