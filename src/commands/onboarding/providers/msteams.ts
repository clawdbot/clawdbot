import type { ClawdbotConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import { resolveMSTeamsCredentials } from "../../../msteams/token.js";
import { formatDocsLink } from "../../../terminal/links.js";
import { DEFAULT_ACCOUNT_ID } from "../../../routing/session-key.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { addWildcardAllowFrom } from "../helpers.js";
import type {
  ProviderOnboardingAdapter,
  ProviderOnboardingDmPolicy,
} from "../types.js";

const provider = "msteams" as const;

function setMSTeamsDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(cfg.msteams?.allowFrom)
      : undefined;
  return {
    ...cfg,
    msteams: {
      ...cfg.msteams,
      dmPolicy,
      ...(allowFrom ? { allowFrom } : {}),
    },
  };
}

async function noteMSTeamsCredentialHelp(
  prompter: WizardPrompter,
): Promise<void> {
  await prompter.note(
    [
      "1) Azure Bot registration → get App ID + Tenant ID",
      "2) Add a client secret (App Password)",
      "3) Set webhook URL + messaging endpoint",
      "Tip: you can also set MSTEAMS_APP_ID / MSTEAMS_APP_PASSWORD / MSTEAMS_TENANT_ID.",
      `Docs: ${formatDocsLink("/msteams", "msteams")}`,
    ].join("\n"),
    "MS Teams credentials",
  );
}

const dmPolicy: ProviderOnboardingDmPolicy = {
  label: "MS Teams",
  provider,
  policyKey: "msteams.dmPolicy",
  allowFromKey: "msteams.allowFrom",
  getCurrent: (cfg) => cfg.msteams?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setMSTeamsDmPolicy(cfg, policy),
};

export const msteamsOnboardingAdapter: ProviderOnboardingAdapter = {
  provider,
  getStatus: async ({ cfg }) => {
    const configured = Boolean(resolveMSTeamsCredentials(cfg.msteams));
    return {
      provider,
      configured,
      statusLines: [
        `MS Teams: ${configured ? "configured" : "needs app credentials"}`,
      ],
      selectionHint: configured ? "configured" : "needs app creds",
      quickstartScore: configured ? 2 : 0,
    };
  },
  configure: async ({ cfg, prompter }) => {
    const resolved = resolveMSTeamsCredentials(cfg.msteams);
    const hasConfigCreds = Boolean(
      cfg.msteams?.appId?.trim() &&
        cfg.msteams?.appPassword?.trim() &&
        cfg.msteams?.tenantId?.trim(),
    );
    const canUseEnv = Boolean(
      !hasConfigCreds &&
        process.env.MSTEAMS_APP_ID?.trim() &&
        process.env.MSTEAMS_APP_PASSWORD?.trim() &&
        process.env.MSTEAMS_TENANT_ID?.trim(),
    );

    let next = cfg;
    let appId: string | null = null;
    let appPassword: string | null = null;
    let tenantId: string | null = null;

    if (!resolved) {
      await noteMSTeamsCredentialHelp(prompter);
    }

    if (canUseEnv) {
      const keepEnv = await prompter.confirm({
        message:
          "MSTEAMS_APP_ID + MSTEAMS_APP_PASSWORD + MSTEAMS_TENANT_ID detected. Use env vars?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          msteams: {
            ...next.msteams,
            enabled: true,
          },
        };
      } else {
        appId = String(
          await prompter.text({
            message: "Enter MS Teams App ID",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        appPassword = String(
          await prompter.text({
            message: "Enter MS Teams App Password",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        tenantId = String(
          await prompter.text({
            message: "Enter MS Teams Tenant ID",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigCreds) {
      const keep = await prompter.confirm({
        message: "MS Teams credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        appId = String(
          await prompter.text({
            message: "Enter MS Teams App ID",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        appPassword = String(
          await prompter.text({
            message: "Enter MS Teams App Password",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        tenantId = String(
          await prompter.text({
            message: "Enter MS Teams Tenant ID",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      appId = String(
        await prompter.text({
          message: "Enter MS Teams App ID",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      appPassword = String(
        await prompter.text({
          message: "Enter MS Teams App Password",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      tenantId = String(
        await prompter.text({
          message: "Enter MS Teams Tenant ID",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (appId && appPassword && tenantId) {
      next = {
        ...next,
        msteams: {
          ...next.msteams,
          enabled: true,
          appId,
          appPassword,
          tenantId,
        },
      };
    }

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    msteams: { ...cfg.msteams, enabled: false },
  }),
};
