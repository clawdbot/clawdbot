import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  createSetupTranslator,
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeSecretInputString } from "./secret-input.js";
import { hasConfiguredMSTeamsCredentials, resolveMSTeamsCredentials } from "./token.js";

const t = createSetupTranslator();

export const msteamsSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: () => DEFAULT_ACCOUNT_ID,
  applyAccountConfig: ({ cfg }) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: {
        ...cfg.channels?.msteams,
        enabled: true,
      },
    },
  }),
};

const channel = "msteams" as const;

async function promptMSTeamsCredentials(prompter: WizardPrompter): Promise<{
  appId: string;
  appPassword: string;
  tenantId: string;
}> {
  const appId = (
    await prompter.text({
      message: t("wizard.msteams.appIdPrompt"),
      validate: (value) => (value?.trim() ? undefined : t("common.required")),
    })
  ).trim();
  const appPassword = (
    await prompter.text({
      message: t("wizard.msteams.appPasswordPrompt"),
      validate: (value) => (value?.trim() ? undefined : t("common.required")),
    })
  ).trim();
  const tenantId = (
    await prompter.text({
      message: t("wizard.msteams.tenantIdPrompt"),
      validate: (value) => (value?.trim() ? undefined : t("common.required")),
    })
  ).trim();
  return { appId, appPassword, tenantId };
}

async function noteMSTeamsCredentialHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      t("wizard.msteams.helpAzureBot"),
      t("wizard.msteams.helpClientSecret"),
      t("wizard.msteams.helpWebhook"),
      t("wizard.msteams.helpEnvTip"),
      t("wizard.channels.docs", { link: formatDocsLink("/channels/msteams", "msteams") }),
    ].join("\n"),
    t("wizard.msteams.credentialsTitle"),
  );
}

export function createMSTeamsSetupWizardBase(): Pick<
  ChannelSetupWizard,
  | "channel"
  | "resolveAccountIdForConfigure"
  | "resolveShouldPromptAccountIds"
  | "status"
  | "credentials"
  | "finalize"
> {
  return {
    channel,
    resolveAccountIdForConfigure: () => DEFAULT_ACCOUNT_ID,
    resolveShouldPromptAccountIds: () => false,
    status: createStandardChannelSetupStatus({
      channelLabel: "MS Teams",
      configuredLabel: t("wizard.channels.statusConfigured"),
      unconfiguredLabel: t("wizard.channels.statusNeedsAppCredentials"),
      configuredHint: t("wizard.channels.statusConfigured"),
      unconfiguredHint: t("wizard.channels.statusNeedsAppCreds"),
      configuredScore: 2,
      unconfiguredScore: 0,
      includeStatusLine: true,
      resolveConfigured: ({ cfg }) =>
        Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)) ||
        hasConfiguredMSTeamsCredentials(cfg.channels?.msteams),
    }),
    credentials: [],
    finalize: async ({ cfg, prompter }) => {
      const resolved = resolveMSTeamsCredentials(cfg.channels?.msteams);
      const hasConfigCreds = hasConfiguredMSTeamsCredentials(cfg.channels?.msteams);
      const canUseEnv = Boolean(
        !hasConfigCreds &&
        normalizeSecretInputString(process.env.MSTEAMS_APP_ID) &&
        normalizeSecretInputString(process.env.MSTEAMS_APP_PASSWORD) &&
        normalizeSecretInputString(process.env.MSTEAMS_TENANT_ID),
      );

      let next: OpenClawConfig = cfg;
      let appId: string | null = null;
      let appPassword: string | null = null;
      let tenantId: string | null = null;

      if (!resolved && !hasConfigCreds) {
        await noteMSTeamsCredentialHelp(prompter);
      }

      if (canUseEnv) {
        const keepEnv = await prompter.confirm({
          message: t("wizard.msteams.envPrompt"),
          initialValue: true,
        });
        if (keepEnv) {
          next = msteamsSetupAdapter.applyAccountConfig({
            cfg: next,
            accountId: DEFAULT_ACCOUNT_ID,
            input: {},
          });
        } else {
          ({ appId, appPassword, tenantId } = await promptMSTeamsCredentials(prompter));
        }
      } else if (hasConfigCreds) {
        const keep = await prompter.confirm({
          message: t("wizard.msteams.credentialsKeep"),
          initialValue: true,
        });
        if (!keep) {
          ({ appId, appPassword, tenantId } = await promptMSTeamsCredentials(prompter));
        }
      } else {
        ({ appId, appPassword, tenantId } = await promptMSTeamsCredentials(prompter));
      }

      if (appId && appPassword && tenantId) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            msteams: {
              ...next.channels?.msteams,
              enabled: true,
              appId,
              appPassword,
              tenantId,
            },
          },
        };
      }

      return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
    },
  };
}
