import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeSecretInputString } from "./secret-input.js";
import { hasConfiguredMSTeamsCredentials, resolveMSTeamsCredentials } from "./token.js";

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
      message: "Enter MS Teams App ID",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    })
  ).trim();
  const appPassword = (
    await prompter.text({
      message: "Enter MS Teams App Password",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    })
  ).trim();
  const tenantId = (
    await prompter.text({
      message: "Enter MS Teams Tenant ID",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    })
  ).trim();
  return { appId, appPassword, tenantId };
}

async function noteMSTeamsCredentialHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Azure Bot registration -> get App ID + Tenant ID",
      "2) Add a client secret (App Password)",
      "3) Set webhook URL + messaging endpoint",
      "Tip: you can also set MSTEAMS_APP_ID / MSTEAMS_APP_PASSWORD / MSTEAMS_TENANT_ID.",
      `Docs: ${formatDocsLink("/channels/msteams", "msteams")}`,
    ].join("\n"),
    "MS Teams credentials",
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
      configuredLabel: "configured",
      unconfiguredLabel: "needs app credentials",
      configuredHint: "configured",
      unconfiguredHint: "needs app creds",
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
          message:
            "MSTEAMS_APP_ID + MSTEAMS_APP_PASSWORD + MSTEAMS_TENANT_ID detected. Use env vars?",
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
          message: "MS Teams credentials already configured. Keep them?",
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
