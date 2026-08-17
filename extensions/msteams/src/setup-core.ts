import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
// Msteams plugin module implements setup core behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  createSetupTranslator,
  setSetupChannelEnabled,
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeSecretInputString } from "./secret-input.js";
import { hasConfiguredMSTeamsCredentials, resolveMSTeamsCredentials } from "./token.js";

const t = createSetupTranslator();
const channel = "msteams" as const;

export const msteamsSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: () => DEFAULT_ACCOUNT_ID,
  applyAccountConfig: ({ cfg }) => setSetupChannelEnabled(cfg, channel, true),
};

export const msteamsSetupContract = defineChannelSetupContract({
  fields: {},
  legacyAdapter: msteamsSetupAdapter,
});

async function promptMSTeamsCredentials(prompter: WizardPrompter): Promise<{
  appId: string;
  appPassword: string;
  tenantId: string;
}> {
  const promptRequired = async (message: string) =>
    (
      await prompter.text({
        message,
        validate: (value) => (value?.trim() ? undefined : t("common.required")),
      })
    ).trim();
  return {
    appId: await promptRequired(t("wizard.msteams.appIdPrompt")),
    appPassword: await promptRequired(t("wizard.msteams.appPasswordPrompt")),
    tenantId: await promptRequired(t("wizard.msteams.tenantIdPrompt")),
  };
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

      if (canUseEnv || hasConfigCreds) {
        const keep = await prompter.confirm({
          message: t(canUseEnv ? "wizard.msteams.envPrompt" : "wizard.msteams.credentialsKeep"),
          initialValue: true,
        });
        if (keep) {
          next = msteamsSetupAdapter.applyAccountConfig({
            cfg: next,
            accountId: DEFAULT_ACCOUNT_ID,
            input: {},
          });
        } else {
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
