// Nextcloud Talk plugin module implements setup surface behavior.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import {
  baseUrlTextInput,
  createStandardChannelSetupStatus,
  defineTokenCredential,
  formatDocsLink,
  setSetupChannelEnabled,
  createSetupTranslator,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import {
  clearNextcloudTalkAccountFields,
  nextcloudTalkDmPolicy,
  normalizeNextcloudTalkBaseUrl,
  setNextcloudTalkAccountConfig,
  validateNextcloudTalkBaseUrl,
} from "./setup-core.js";
import type { CoreConfig } from "./types.js";

const t = createSetupTranslator();

const channel = "nextcloud-talk" as const;
const CONFIGURE_API_FLAG = "__nextcloudTalkConfigureApiCredentials";

export const nextcloudTalkSetupWizard: ChannelSetupWizard = {
  channel,
  stepOrder: "text-first",
  status: createStandardChannelSetupStatus({
    channelLabel: "Nextcloud Talk",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsSetup"),
    configuredHint: t("wizard.channels.statusConfigured"),
    unconfiguredHint: t("wizard.channels.statusSelfHostedChat"),
    configuredScore: 1,
    unconfiguredScore: 5,
    resolveConfigured: ({ cfg, accountId }) => {
      const account = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
      return Boolean(account.secret && account.baseUrl);
    },
  }),
  introNote: {
    title: t("wizard.nextcloudTalk.setupTitle"),
    lines: [
      t("wizard.nextcloudTalk.helpSsh"),
      t("wizard.nextcloudTalk.helpInstallCommand"),
      t("wizard.nextcloudTalk.helpCopySecret"),
      t("wizard.nextcloudTalk.helpEnableRoom"),
      t("wizard.nextcloudTalk.helpEnvTip"),
      t("wizard.channels.docs", {
        link: formatDocsLink("/channels/nextcloud-talk", "channels/nextcloud-talk"),
      }),
    ],
    shouldShow: ({ cfg, accountId }) => {
      const account = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
      return !account.secret || !account.baseUrl;
    },
  },
  prepare: async ({ cfg, accountId, credentialValues, prompter }) => {
    const resolvedAccount = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
    const hasApiCredentials = Boolean(
      resolvedAccount.config.apiUser?.trim() &&
      (hasConfiguredSecretInput(resolvedAccount.config.apiPassword) ||
        resolvedAccount.config.apiPasswordFile),
    );
    const configureApiCredentials = await prompter.confirm({
      message: t("wizard.nextcloudTalk.configureApiCredentials"),
      initialValue: hasApiCredentials,
    });
    if (!configureApiCredentials) {
      return undefined;
    }
    return {
      credentialValues: {
        ...credentialValues,
        [CONFIGURE_API_FLAG]: "1",
      },
    };
  },
  credentials: [
    defineTokenCredential({
      inputKey: "token",
      configKey: "botSecret",
      configuredFields: ["botSecret", "botSecretFile"],
      providerHint: channel,
      credentialLabel: t("wizard.nextcloudTalk.botSecret"),
      preferredEnvVar: "NEXTCLOUD_TALK_BOT_SECRET",
      envPrompt: t("wizard.nextcloudTalk.botSecretEnvPrompt"),
      keepPrompt: t("wizard.nextcloudTalk.botSecretKeep"),
      inputPrompt: t("wizard.nextcloudTalk.botSecretInput"),
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      resolveAccount: ({ cfg, accountId }) =>
        resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId }),
      accountConfigured: (account) => Boolean(account.secret && account.baseUrl),
      hasConfiguredValue: (account) =>
        Boolean(hasConfiguredSecretInput(account.config.botSecret) || account.config.botSecretFile),
      resolvedValue: (account) => account.secret || undefined,
      envValue: ({ accountId }) =>
        accountId === DEFAULT_ACCOUNT_ID
          ? normalizeOptionalString(process.env.NEXTCLOUD_TALK_BOT_SECRET)
          : undefined,
      patchAccount: ({ cfg, accountId, patch, clearFields }) => {
        const cleared = clearNextcloudTalkAccountFields(cfg as CoreConfig, accountId, clearFields);
        return setNextcloudTalkAccountConfig(cleared, accountId, patch);
      },
      useEnv: {
        clearFields: ["botSecret", "botSecretFile"],
        patch: (account) => ({ baseUrl: account.baseUrl }),
      },
      set: { clearFields: ["botSecret", "botSecretFile"] },
    }),
    defineTokenCredential({
      inputKey: "password",
      configKey: "apiPassword",
      configuredFields: ["apiPassword", "apiPasswordFile"],
      providerHint: "nextcloud-talk-api",
      credentialLabel: t("wizard.nextcloudTalk.apiPassword"),
      preferredEnvVar: "NEXTCLOUD_TALK_API_PASSWORD",
      envPrompt: "",
      keepPrompt: t("wizard.nextcloudTalk.apiPasswordKeep"),
      inputPrompt: t("wizard.nextcloudTalk.apiPasswordInput"),
      resolveAccount: ({ cfg, accountId }) =>
        resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId }),
      accountConfigured: (account) =>
        Boolean(
          account.config.apiUser?.trim() &&
          (hasConfiguredSecretInput(account.config.apiPassword) || account.config.apiPasswordFile),
        ),
      hasConfiguredValue: (account) =>
        Boolean(
          hasConfiguredSecretInput(account.config.apiPassword) || account.config.apiPasswordFile,
        ),
      shouldPrompt: ({ credentialValues }) => credentialValues[CONFIGURE_API_FLAG] === "1",
      patchAccount: ({ cfg, accountId, patch, clearFields }) =>
        setNextcloudTalkAccountConfig(
          clearNextcloudTalkAccountFields(cfg as CoreConfig, accountId, clearFields),
          accountId,
          patch,
        ),
      set: { clearFields: ["apiPassword", "apiPasswordFile"] },
    }),
  ],
  textInputs: [
    baseUrlTextInput({
      inputKey: "httpUrl",
      configKey: "baseUrl",
      message: t("wizard.nextcloudTalk.instanceUrlPrompt"),
      resolveAccount: ({ cfg, accountId }) =>
        resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId }),
      currentValue: (account) => account.baseUrl || undefined,
      shouldPrompt: ({ currentValue }) => !currentValue,
      validate: validateNextcloudTalkBaseUrl,
      normalize: normalizeNextcloudTalkBaseUrl,
      patchAccount: ({ cfg, accountId, patch }) =>
        setNextcloudTalkAccountConfig(cfg as CoreConfig, accountId, patch),
    }),
    {
      inputKey: "userId",
      message: t("wizard.nextcloudTalk.apiUserPrompt"),
      currentValue: ({ cfg, accountId }) =>
        resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId }).config.apiUser?.trim() ||
        undefined,
      shouldPrompt: ({ credentialValues }) => credentialValues[CONFIGURE_API_FLAG] === "1",
      validate: ({ value }) => (value ? undefined : t("common.required")),
      applySet: async (params) =>
        setNextcloudTalkAccountConfig(params.cfg as CoreConfig, params.accountId, {
          apiUser: params.value,
        }),
    },
  ],
  dmPolicy: nextcloudTalkDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
