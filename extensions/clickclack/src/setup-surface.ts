// ClickClack plugin module implements guided setup behavior.
import {
  baseUrlTextInput,
  createStandardChannelSetupStatus,
  createSetupTranslator,
  DEFAULT_ACCOUNT_ID,
  defineTokenCredential,
  formatDocsLink,
  hasConfiguredSecretInput,
  setSetupChannelEnabled,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { listClickClackAccountIds, resolveClickClackAccount } from "./accounts.js";
import {
  applyClickClackCredentialConfig,
  applyClickClackSetupConfigPatch,
  normalizeClickClackBaseUrl,
} from "./setup-core.js";
import { checkClickClackSetupConnection } from "./setup-verify.js";
import type { CoreConfig, ResolvedClickClackAccount } from "./types.js";

const t = createSetupTranslator();
const channel = "clickclack" as const;

function hasConfiguredClickClackCredential(account: ResolvedClickClackAccount): boolean {
  return (
    hasConfiguredSecretInput(account.config.token) || Boolean(account.config.tokenFile?.trim())
  );
}

function isClickClackSetupConfigured(account: ResolvedClickClackAccount): boolean {
  return Boolean(
    account.baseUrl &&
    account.workspace &&
    (account.token || hasConfiguredClickClackCredential(account)),
  );
}

export const clickClackSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "ClickClack",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsSetup"),
    configuredHint: t("wizard.channels.statusSelfHostedChat"),
    unconfiguredHint: t("wizard.channels.statusNeedsSetup"),
    configuredScore: 2,
    unconfiguredScore: 1,
    resolveConfigured: ({ cfg, accountId }) =>
      (accountId ? [accountId] : listClickClackAccountIds(cfg as CoreConfig)).some(
        (resolvedAccountId) =>
          isClickClackSetupConfigured(
            resolveClickClackAccount({
              cfg: cfg as CoreConfig,
              accountId: resolvedAccountId,
            }),
          ),
      ),
  }),
  introNote: {
    title: t("wizard.clickclack.botTokenTitle"),
    lines: [
      t("wizard.clickclack.helpCreateToken"),
      t("wizard.channels.docs", {
        link: formatDocsLink("/channels/clickclack", "clickclack"),
      }),
    ],
    shouldShow: ({ cfg, accountId }) =>
      !isClickClackSetupConfigured(
        resolveClickClackAccount({
          cfg: cfg as CoreConfig,
          accountId,
        }),
      ),
  },
  credentials: [
    defineTokenCredential({
      inputKey: "token",
      configKey: "token",
      configuredFields: ["token", "tokenFile"],
      providerHint: channel,
      credentialLabel: t("wizard.clickclack.botToken"),
      preferredEnvVar: "CLICKCLACK_BOT_TOKEN",
      envPrompt: t("wizard.clickclack.envPrompt"),
      keepPrompt: t("wizard.clickclack.botTokenKeep"),
      inputPrompt: t("wizard.clickclack.botTokenInput"),
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      resolveAccount: ({ cfg, accountId }) =>
        resolveClickClackAccount({ cfg: cfg as CoreConfig, accountId }),
      hasConfiguredValue: hasConfiguredClickClackCredential,
      resolvedValue: (account) => account.token || undefined,
      envValue: ({ accountId }) =>
        accountId === DEFAULT_ACCOUNT_ID
          ? process.env.CLICKCLACK_BOT_TOKEN?.trim() || undefined
          : undefined,
      patchAccount: ({ cfg, accountId, mode, patch }) =>
        mode === "env"
          ? applyClickClackCredentialConfig({ cfg, accountId, useEnv: true })
          : applyClickClackCredentialConfig({ cfg, accountId, ...patch }),
      useEnv: { clearFields: ["token", "tokenFile"] },
      set: { clearFields: ["tokenFile"] },
    }),
  ],
  textInputs: [
    baseUrlTextInput({
      inputKey: "baseUrl",
      configKey: "baseUrl",
      message: t("wizard.clickclack.baseUrlPrompt"),
      resolveAccount: ({ cfg, accountId }) =>
        resolveClickClackAccount({ cfg: cfg as CoreConfig, accountId }),
      currentValue: (account) => account.baseUrl || undefined,
      includeInitialValue: true,
      validate: (value) =>
        normalizeClickClackBaseUrl(value)
          ? undefined
          : "ClickClack server URL must be a valid http(s) URL.",
      normalize: (value) => normalizeClickClackBaseUrl(value) ?? value.trim(),
      patchAccount: ({ cfg, accountId, patch }) =>
        applyClickClackSetupConfigPatch({
          cfg,
          accountId,
          patch,
        }),
    }),
    {
      inputKey: "workspace",
      message: t("wizard.clickclack.workspacePrompt"),
      helpTitle: t("wizard.clickclack.workspacePrompt"),
      helpLines: [t("wizard.clickclack.workspaceHelp")],
      currentValue: ({ cfg, accountId }) =>
        resolveClickClackAccount({ cfg: cfg as CoreConfig, accountId }).workspace || undefined,
      initialValue: ({ cfg, accountId }) =>
        resolveClickClackAccount({ cfg: cfg as CoreConfig, accountId }).workspace || undefined,
      validate: ({ value }) => (value.trim() ? undefined : "Required"),
      normalizeValue: ({ value }) => value.trim(),
      applySet: async ({ cfg, accountId, value }) =>
        applyClickClackSetupConfigPatch({
          cfg,
          accountId,
          patch: { workspace: value },
        }),
    },
  ],
  finalize: async ({ cfg, accountId, credentialValues, prompter }) => {
    const result = await checkClickClackSetupConnection({
      cfg: cfg as CoreConfig,
      accountId,
      token: credentialValues.token,
    });
    if (result.status === "connected") {
      await prompter.note(
        t("wizard.clickclack.connected", {
          handle: result.handle,
          workspace: result.workspaceName,
        }),
        t("wizard.clickclack.connectionTitle"),
      );
      return;
    }
    if (result.status === "skipped-env-token" || result.status === "skipped-unconfigured") {
      return;
    }
    const message =
      result.status === "invalid-token"
        ? t("wizard.clickclack.invalidToken")
        : result.status === "workspace-not-found"
          ? t("wizard.clickclack.workspaceNotFound", { workspace: result.workspace })
          : t("wizard.clickclack.connectionFailed", {
              error: result.error,
            });
    await prompter.note(message, t("wizard.clickclack.validationWarningTitle"));
  },
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
