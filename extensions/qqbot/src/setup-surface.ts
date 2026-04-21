import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  createStandardChannelSetupStatus,
  hasConfiguredSecretInput,
  setSetupChannelEnabled,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  DEFAULT_ACCOUNT_ID,
  listQQBotAccountIds,
  resolveQQBotAccount,
  applyQQBotAccountConfig,
} from "./config.js";

const channel = "qqbot" as const;

type QQBotEnvCredentialField = "appId" | "clientSecret";
type QQBotSetupCredentialState = {
  accountConfigured: boolean;
  hasConfiguredSecretValue: boolean;
  resolvedAppId?: string;
  resolvedClientSecret?: string;
};

function resolveQQBotSetupCredentialState(
  cfg: OpenClawConfig,
  accountId: string,
): QQBotSetupCredentialState {
  const resolved = resolveQQBotAccount(cfg, accountId, { allowUnresolvedSecretRef: true });
  const hasConfiguredSecretValue = Boolean(
    hasConfiguredSecretInput(resolved.config.clientSecret) ||
    normalizeOptionalString(resolved.config.clientSecretFile) ||
    resolved.clientSecret,
  );
  return {
    accountConfigured: Boolean(resolved.appId && hasConfiguredSecretValue),
    hasConfiguredSecretValue,
    resolvedAppId: resolved.appId || undefined,
    resolvedClientSecret: resolved.clientSecret || undefined,
  };
}

/**
 * Clear only the credential fields owned by the setup prompt that switched to
 * env-backed resolution. This preserves mixed-source setups such as config
 * AppID + env AppSecret.
 */
function clearQQBotCredentialField(
  cfg: OpenClawConfig,
  accountId: string,
  field: QQBotEnvCredentialField,
): OpenClawConfig {
  const next = { ...cfg };
  const qqbot = { ...(next.channels?.qqbot as Record<string, unknown> | undefined) };

  const clearField = (entry: Record<string, unknown>) => {
    if (field === "appId") {
      delete entry.appId;
      return;
    }
    delete entry.clientSecret;
    delete entry.clientSecretFile;
  };

  if (accountId === DEFAULT_ACCOUNT_ID) {
    clearField(qqbot);
  } else {
    const accounts = { ...(qqbot.accounts as Record<string, Record<string, unknown>> | undefined) };
    if (accounts[accountId]) {
      const entry = { ...accounts[accountId] };
      clearField(entry);
      accounts[accountId] = entry;
      qqbot.accounts = accounts;
    }
  }

  next.channels = { ...next.channels, qqbot };
  return next;
}

const QQBOT_SETUP_HELP_LINES = [
  "To create a QQ Bot, visit the QQ Open Platform:",
  `  ${formatDocsLink("https://q.qq.com", "q.qq.com")}`,
  "",
  "1. Create an application and note the AppID.",
  "2. Go to development settings to find the AppSecret.",
];

export const qqbotSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "QQ Bot",
    configuredLabel: "configured",
    unconfiguredLabel: "needs AppID + AppSecret",
    configuredHint: "configured",
    unconfiguredHint: "needs AppID + AppSecret",
    configuredScore: 1,
    unconfiguredScore: 6,
    resolveConfigured: ({ cfg, accountId }) =>
      (accountId ? [accountId] : listQQBotAccountIds(cfg)).some((resolvedAccountId) => {
        const account = resolveQQBotAccount(cfg, resolvedAccountId, {
          allowUnresolvedSecretRef: true,
        });
        return Boolean(
          account.appId &&
          (Boolean(account.clientSecret) ||
            hasConfiguredSecretInput(account.config.clientSecret) ||
            Boolean(account.config.clientSecretFile?.trim())),
        );
      }),
  }),
  credentials: [
    {
      inputKey: "token",
      providerHint: channel,
      credentialLabel: "AppID",
      preferredEnvVar: "QQBOT_APP_ID",
      helpTitle: "QQ Bot AppID",
      helpLines: QQBOT_SETUP_HELP_LINES,
      envPrompt: "QQBOT_APP_ID detected. Use env var?",
      keepPrompt: "QQ Bot AppID already configured. Keep it?",
      inputPrompt: "Enter QQ Bot AppID",
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const state = resolveQQBotSetupCredentialState(cfg, accountId);
        return {
          accountConfigured: state.accountConfigured,
          hasConfiguredValue: Boolean(state.resolvedAppId),
          resolvedValue: state.resolvedAppId,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? normalizeOptionalString(process.env.QQBOT_APP_ID)
              : undefined,
        };
      },
      applyUseEnv: ({ cfg, accountId }) =>
        clearQQBotCredentialField(applyQQBotAccountConfig(cfg, accountId, {}), accountId, "appId"),
      applySet: ({ cfg, accountId, resolvedValue }) =>
        applyQQBotAccountConfig(cfg, accountId, { appId: resolvedValue }),
    },
    {
      inputKey: "password",
      providerHint: "qqbot-secret",
      credentialLabel: "AppSecret",
      preferredEnvVar: "QQBOT_CLIENT_SECRET",
      helpTitle: "QQ Bot AppSecret",
      helpLines: QQBOT_SETUP_HELP_LINES,
      envPrompt: "QQBOT_CLIENT_SECRET detected. Use env var?",
      keepPrompt: "QQ Bot AppSecret already configured. Keep it?",
      inputPrompt: "Enter QQ Bot AppSecret",
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const state = resolveQQBotSetupCredentialState(cfg, accountId);
        return {
          accountConfigured: state.accountConfigured,
          hasConfiguredValue: state.hasConfiguredSecretValue,
          resolvedValue: state.resolvedClientSecret,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? normalizeOptionalString(process.env.QQBOT_CLIENT_SECRET)
              : undefined,
        };
      },
      applyUseEnv: ({ cfg, accountId }) =>
        clearQQBotCredentialField(
          applyQQBotAccountConfig(cfg, accountId, {}),
          accountId,
          "clientSecret",
        ),
      applySet: ({ cfg, accountId, resolvedValue }) =>
        applyQQBotAccountConfig(cfg, accountId, { clientSecret: resolvedValue }),
    },
  ],
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
