import {
  addWildcardAllowFrom,
  applySetupAccountConfigPatch,
  createPromptParsedAllowFromForAccount,
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  mergeAllowFromEntries,
  migrateBaseNameToDefaultAccount,
  splitSetupEntries,
  createSetupTranslator,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultGoogleChatAccountId, resolveGoogleChatAccount } from "./accounts.js";

const t = createSetupTranslator();

const channel = "googlechat" as const;
const ENV_SERVICE_ACCOUNT = "GOOGLE_CHAT_SERVICE_ACCOUNT";
const ENV_SERVICE_ACCOUNT_FILE = "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE";
const USE_ENV_FLAG = "__googlechatUseEnv";
const AUTH_METHOD_FLAG = "__googlechatAuthMethod";

type GoogleChatTextInput = NonNullable<ChannelSetupWizard["textInputs"]>[number];
type GoogleChatTextInputKey = GoogleChatTextInput["inputKey"];

const promptAllowFrom = createPromptParsedAllowFromForAccount({
  defaultAccountId: resolveDefaultGoogleChatAccountId,
  message: t("wizard.googlechat.allowFromPrompt"),
  placeholder: "users/123456789, name@example.com",
  parseEntries: (raw) => ({
    entries: mergeAllowFromEntries(undefined, splitSetupEntries(raw)),
  }),
  getExistingAllowFrom: ({ cfg, accountId }) =>
    resolveGoogleChatAccount({ cfg, accountId }).config.dm?.allowFrom ?? [],
  applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
    applySetupAccountConfigPatch({
      cfg,
      channelKey: channel,
      accountId,
      patch: {
        dm: {
          ...resolveGoogleChatAccount({ cfg, accountId }).config.dm,
          allowFrom,
        },
      },
    }),
});

const googlechatDmPolicy: ChannelSetupDmPolicy = {
  label: "Google Chat",
  channel,
  policyKey: "channels.googlechat.dm.policy",
  allowFromKey: "channels.googlechat.dm.allowFrom",
  resolveConfigKeys: (cfg, accountId) =>
    (accountId ?? resolveDefaultGoogleChatAccountId(cfg)) !== DEFAULT_ACCOUNT_ID
      ? {
          policyKey: `channels.googlechat.accounts.${accountId ?? resolveDefaultGoogleChatAccountId(cfg)}.dm.policy`,
          allowFromKey: `channels.googlechat.accounts.${accountId ?? resolveDefaultGoogleChatAccountId(cfg)}.dm.allowFrom`,
        }
      : {
          policyKey: "channels.googlechat.dm.policy",
          allowFromKey: "channels.googlechat.dm.allowFrom",
        },
  getCurrent: (cfg, accountId) =>
    resolveGoogleChatAccount({
      cfg,
      accountId: accountId ?? resolveDefaultGoogleChatAccountId(cfg),
    }).config.dm?.policy ?? "pairing",
  setPolicy: (cfg, policy, accountId) => {
    const resolvedAccountId = accountId ?? resolveDefaultGoogleChatAccountId(cfg);
    const currentDm = resolveGoogleChatAccount({
      cfg,
      accountId: resolvedAccountId,
    }).config.dm;
    return applySetupAccountConfigPatch({
      cfg,
      channelKey: channel,
      accountId: resolvedAccountId,
      patch: {
        dm: {
          ...currentDm,
          policy,
          ...(policy === "open" ? { allowFrom: addWildcardAllowFrom(currentDm?.allowFrom) } : {}),
        },
      },
    });
  },
  promptAllowFrom,
};

function createServiceAccountTextInput(params: {
  inputKey: GoogleChatTextInputKey;
  message: string;
  placeholder: string;
  authMethod: "file" | "inline";
  patchKey: "serviceAccountFile" | "serviceAccount";
}): GoogleChatTextInput {
  return {
    inputKey: params.inputKey,
    message: params.message,
    placeholder: params.placeholder,
    shouldPrompt: ({ credentialValues }) =>
      credentialValues[USE_ENV_FLAG] !== "1" &&
      credentialValues[AUTH_METHOD_FLAG] === params.authMethod,
    validate: ({ value }) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
    normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
    applySet: async ({ cfg, accountId, value }) =>
      applySetupAccountConfigPatch({
        cfg,
        channelKey: channel,
        accountId,
        patch: { [params.patchKey]: value },
      }),
  };
}

export const googlechatSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "Google Chat",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsServiceAccount"),
    configuredHint: t("wizard.channels.statusConfigured"),
    unconfiguredHint: t("wizard.channels.statusNeedsAuth"),
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) =>
      resolveGoogleChatAccount({ cfg, accountId }).credentialSource !== "none",
  }),
  introNote: {
    title: t("wizard.googlechat.setupTitle"),
    lines: [
      t("wizard.googlechat.setupServiceAccount"),
      t("wizard.googlechat.setupScopes"),
      t("wizard.googlechat.setupAudience"),
      t("wizard.channels.docs", { link: formatDocsLink("/channels/googlechat", "googlechat") }),
    ],
  },
  prepare: async ({ cfg, accountId, credentialValues, prompter }) => {
    const envReady =
      accountId === DEFAULT_ACCOUNT_ID &&
      (Boolean(process.env[ENV_SERVICE_ACCOUNT]) || Boolean(process.env[ENV_SERVICE_ACCOUNT_FILE]));
    if (envReady) {
      const useEnv = await prompter.confirm({
        message: t("wizard.googlechat.useEnvPrompt"),
        initialValue: true,
      });
      if (useEnv) {
        return {
          cfg: applySetupAccountConfigPatch({
            cfg,
            channelKey: channel,
            accountId,
            patch: {},
          }),
          credentialValues: {
            ...credentialValues,
            [USE_ENV_FLAG]: "1",
          },
        };
      }
    }

    const method = await prompter.select({
      message: t("wizard.googlechat.authMethod"),
      options: [
        { value: "file", label: t("wizard.googlechat.serviceAccountFile") },
        { value: "inline", label: t("wizard.googlechat.serviceAccountInline") },
      ],
      initialValue: "file",
    });

    return {
      credentialValues: {
        ...credentialValues,
        [USE_ENV_FLAG]: "0",
        [AUTH_METHOD_FLAG]: method,
      },
    };
  },
  credentials: [],
  textInputs: [
    createServiceAccountTextInput({
      inputKey: "tokenFile",
      message: t("wizard.googlechat.serviceAccountPath"),
      placeholder: "/path/to/service-account.json",
      authMethod: "file",
      patchKey: "serviceAccountFile",
    }),
    createServiceAccountTextInput({
      inputKey: "token",
      message: t("wizard.googlechat.serviceAccountJson"),
      placeholder: '{"type":"service_account", ... }',
      authMethod: "inline",
      patchKey: "serviceAccount",
    }),
  ],
  finalize: async ({ cfg, accountId, prompter }) => {
    const account = resolveGoogleChatAccount({
      cfg,
      accountId,
    });
    const audienceType = await prompter.select({
      message: t("wizard.googlechat.webhookAudienceType"),
      options: [
        { value: "app-url", label: t("wizard.googlechat.appUrlRecommended") },
        { value: "project-number", label: t("wizard.googlechat.projectNumber") },
      ],
      initialValue: account.config.audienceType === "project-number" ? "project-number" : "app-url",
    });
    const audience = await prompter.text({
      message:
        audienceType === "project-number"
          ? t("wizard.googlechat.projectNumber")
          : t("wizard.googlechat.appUrl"),
      placeholder:
        audienceType === "project-number" ? "1234567890" : "https://your.host/googlechat",
      initialValue: account.config.audience || undefined,
      validate: (value) =>
        normalizeStringifiedOptionalString(value) ? undefined : t("common.required"),
    });
    return {
      cfg: migrateBaseNameToDefaultAccount({
        cfg: applySetupAccountConfigPatch({
          cfg,
          channelKey: channel,
          accountId,
          patch: {
            audienceType,
            audience: normalizeOptionalString(audience) ?? "",
          },
        }),
        channelKey: channel,
      }),
    };
  },
  dmPolicy: googlechatDmPolicy,
};
