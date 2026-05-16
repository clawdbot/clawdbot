import {
  createAllowFromSection,
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  hasConfiguredSecretInput,
  patchChannelConfigForAccount,
  setSetupChannelEnabled,
  splitSetupEntries,
  createSetupTranslator,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { inspectTelegramAccount } from "./account-inspect.js";
import { listTelegramAccountIds, resolveTelegramAccount } from "./accounts.js";
import {
  getTelegramTokenHelpLines,
  getTelegramUserIdHelpLines,
  parseTelegramAllowFromId,
} from "./setup-core.js";
import {
  buildTelegramDmAccessWarningLines,
  ensureTelegramDefaultGroupMentionGate,
  shouldShowTelegramDmAccessWarning,
  telegramSetupDmPolicy,
} from "./setup-surface.helpers.js";

const t = createSetupTranslator();

const channel = "telegram" as const;

export const telegramSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "Telegram",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsToken"),
    configuredHint: t("wizard.channels.statusRecommendedConfigured"),
    unconfiguredHint: t("wizard.channels.statusRecommendedNewcomerFriendly"),
    configuredScore: 1,
    unconfiguredScore: 10,
    resolveConfigured: ({ cfg, accountId }) =>
      (accountId ? [accountId] : listTelegramAccountIds(cfg)).some((resolvedAccountId) => {
        const account = inspectTelegramAccount({ cfg, accountId: resolvedAccountId });
        return account.configured;
      }),
  }),
  prepare: async ({ cfg, accountId, credentialValues }) => ({
    cfg: ensureTelegramDefaultGroupMentionGate(cfg, accountId),
    credentialValues,
  }),
  credentials: [
    {
      inputKey: "token",
      providerHint: channel,
      credentialLabel: t("wizard.telegram.botToken"),
      preferredEnvVar: "TELEGRAM_BOT_TOKEN",
      helpTitle: t("wizard.telegram.botToken"),
      helpLines: getTelegramTokenHelpLines(),
      envPrompt: t("wizard.telegram.tokenEnvPrompt"),
      keepPrompt: t("wizard.telegram.tokenKeepPrompt"),
      inputPrompt: t("wizard.telegram.tokenInputPrompt"),
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const resolved = resolveTelegramAccount({ cfg, accountId });
        const hasConfiguredBotToken = hasConfiguredSecretInput(resolved.config.botToken);
        const hasConfiguredValue =
          hasConfiguredBotToken || Boolean(resolved.config.tokenFile?.trim());
        return {
          accountConfigured: Boolean(resolved.token) || hasConfiguredValue,
          hasConfiguredValue,
          resolvedValue: normalizeOptionalString(resolved.token),
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? normalizeOptionalString(process.env.TELEGRAM_BOT_TOKEN)
              : undefined,
        };
      },
    },
  ],
  allowFrom: createAllowFromSection({
    helpTitle: t("wizard.telegram.userIdTitle"),
    helpLines: getTelegramUserIdHelpLines(),
    message: t("wizard.telegram.allowFromPrompt"),
    placeholder: "123456789",
    invalidWithoutCredentialNote: t("wizard.telegram.allowFromInvalid"),
    parseInputs: splitSetupEntries,
    parseId: parseTelegramAllowFromId,
    resolveEntries: async ({ entries }) =>
      entries.map((entry) => {
        const id = parseTelegramAllowFromId(entry);
        return { input: entry, resolved: Boolean(id), id };
      }),
    apply: async ({ cfg, accountId, allowFrom }) =>
      patchChannelConfigForAccount({
        cfg,
        channel,
        accountId,
        patch: { dmPolicy: "allowlist", allowFrom },
      }),
  }),
  finalize: async ({ cfg, accountId, prompter }) => {
    if (!shouldShowTelegramDmAccessWarning(cfg, accountId)) {
      return;
    }
    await prompter.note(
      buildTelegramDmAccessWarningLines(accountId).join("\n"),
      "Telegram DM access warning",
    );
  },
  dmPolicy: telegramSetupDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
