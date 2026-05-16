import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import {
  createStandardChannelSetupStatus,
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
    {
      inputKey: "token",
      providerHint: channel,
      credentialLabel: t("wizard.nextcloudTalk.botSecret"),
      preferredEnvVar: "NEXTCLOUD_TALK_BOT_SECRET",
      envPrompt: t("wizard.nextcloudTalk.botSecretEnvPrompt"),
      keepPrompt: t("wizard.nextcloudTalk.botSecretKeep"),
      inputPrompt: t("wizard.nextcloudTalk.botSecretInput"),
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const resolvedAccount = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
        return {
          accountConfigured: Boolean(resolvedAccount.secret && resolvedAccount.baseUrl),
          hasConfiguredValue: Boolean(
            hasConfiguredSecretInput(resolvedAccount.config.botSecret) ||
            resolvedAccount.config.botSecretFile,
          ),
          resolvedValue: resolvedAccount.secret || undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? normalizeOptionalString(process.env.NEXTCLOUD_TALK_BOT_SECRET)
              : undefined,
        };
      },
      applyUseEnv: async (params) => {
        const resolvedAccount = resolveNextcloudTalkAccount({
          cfg: params.cfg as CoreConfig,
          accountId: params.accountId,
        });
        const cleared = clearNextcloudTalkAccountFields(
          params.cfg as CoreConfig,
          params.accountId,
          ["botSecret", "botSecretFile"],
        );
        return setNextcloudTalkAccountConfig(cleared, params.accountId, {
          baseUrl: resolvedAccount.baseUrl,
        });
      },
      applySet: async (params) =>
        setNextcloudTalkAccountConfig(
          clearNextcloudTalkAccountFields(params.cfg as CoreConfig, params.accountId, [
            "botSecret",
            "botSecretFile",
          ]),
          params.accountId,
          {
            botSecret: params.value,
          },
        ),
    },
    {
      inputKey: "password",
      providerHint: "nextcloud-talk-api",
      credentialLabel: t("wizard.nextcloudTalk.apiPassword"),
      preferredEnvVar: "NEXTCLOUD_TALK_API_PASSWORD",
      envPrompt: "",
      keepPrompt: t("wizard.nextcloudTalk.apiPasswordKeep"),
      inputPrompt: t("wizard.nextcloudTalk.apiPasswordInput"),
      inspect: ({ cfg, accountId }) => {
        const resolvedAccount = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
        const apiUser = resolvedAccount.config.apiUser?.trim();
        const apiPasswordConfigured = Boolean(
          hasConfiguredSecretInput(resolvedAccount.config.apiPassword) ||
          resolvedAccount.config.apiPasswordFile,
        );
        return {
          accountConfigured: Boolean(apiUser && apiPasswordConfigured),
          hasConfiguredValue: apiPasswordConfigured,
        };
      },
      shouldPrompt: ({ credentialValues }) => credentialValues[CONFIGURE_API_FLAG] === "1",
      applySet: async (params) =>
        setNextcloudTalkAccountConfig(
          clearNextcloudTalkAccountFields(params.cfg as CoreConfig, params.accountId, [
            "apiPassword",
            "apiPasswordFile",
          ]),
          params.accountId,
          {
            apiPassword: params.value,
          },
        ),
    },
  ],
  textInputs: [
    {
      inputKey: "httpUrl",
      message: t("wizard.nextcloudTalk.instanceUrlPrompt"),
      currentValue: ({ cfg, accountId }) =>
        resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId }).baseUrl || undefined,
      shouldPrompt: ({ currentValue }) => !currentValue,
      validate: ({ value }) => validateNextcloudTalkBaseUrl(value),
      normalizeValue: ({ value }) => normalizeNextcloudTalkBaseUrl(value),
      applySet: async (params) =>
        setNextcloudTalkAccountConfig(params.cfg as CoreConfig, params.accountId, {
          baseUrl: params.value,
        }),
    },
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
