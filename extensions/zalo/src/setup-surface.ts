import {
  buildSingleChannelSecretPromptState,
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  hasConfiguredSecretInput,
  promptSingleChannelSecretInput,
  runSingleChannelSecretStep,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type SecretInput,
  createSetupTranslator,
} from "openclaw/plugin-sdk/setup";
import { resolveZaloAccount } from "./accounts.js";
import { noteZaloTokenHelp, promptZaloAllowFrom } from "./setup-allow-from.js";
import { zaloDmPolicy } from "./setup-core.js";

const t = createSetupTranslator();

const channel = "zalo" as const;

type UpdateMode = "polling" | "webhook";

function setZaloUpdateMode(
  cfg: OpenClawConfig,
  accountId: string,
  mode: UpdateMode,
  webhookUrl?: string,
  webhookSecret?: SecretInput,
  webhookPath?: string,
): OpenClawConfig {
  const isDefault = accountId === DEFAULT_ACCOUNT_ID;
  if (mode === "polling") {
    if (isDefault) {
      const {
        webhookUrl: _url,
        webhookSecret: _secret,
        webhookPath: _path,
        ...rest
      } = cfg.channels?.zalo ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          zalo: rest,
        },
      } as OpenClawConfig;
    }
    const accounts = { ...cfg.channels?.zalo?.accounts } as Record<string, Record<string, unknown>>;
    const existing = accounts[accountId] ?? {};
    const { webhookUrl: _url, webhookSecret: _secret, webhookPath: _path, ...rest } = existing;
    accounts[accountId] = rest;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          accounts,
        },
      },
    } as OpenClawConfig;
  }

  if (isDefault) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          webhookUrl,
          webhookSecret,
          webhookPath,
        },
      },
    } as OpenClawConfig;
  }

  const accounts = { ...cfg.channels?.zalo?.accounts } as Record<string, Record<string, unknown>>;
  accounts[accountId] = {
    ...accounts[accountId],
    webhookUrl,
    webhookSecret,
    webhookPath,
  };
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zalo: {
        ...cfg.channels?.zalo,
        accounts,
      },
    },
  } as OpenClawConfig;
}

export { zaloSetupAdapter } from "./setup-core.js";

export const zaloSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "Zalo",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsToken"),
    configuredHint: t("wizard.channels.statusRecommendedConfigured"),
    unconfiguredHint: t("wizard.channels.statusRecommendedNewcomerFriendly"),
    configuredScore: 1,
    unconfiguredScore: 10,
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) => {
      const account = resolveZaloAccount({
        cfg,
        accountId,
        allowUnresolvedSecretRef: true,
      });
      return (
        Boolean(account.token) ||
        hasConfiguredSecretInput(account.config.botToken) ||
        Boolean(account.config.tokenFile?.trim())
      );
    },
  }),
  credentials: [],
  finalize: async ({ cfg, accountId, forceAllowFrom, options, prompter }) => {
    let next = cfg;
    const resolvedAccount = resolveZaloAccount({
      cfg: next,
      accountId,
      allowUnresolvedSecretRef: true,
    });
    const accountConfigured = Boolean(resolvedAccount.token);
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const hasConfigToken = Boolean(
      hasConfiguredSecretInput(resolvedAccount.config.botToken) || resolvedAccount.config.tokenFile,
    );
    const tokenStep = await runSingleChannelSecretStep({
      cfg: next,
      prompter,
      providerHint: "zalo",
      credentialLabel: t("wizard.zalo.botToken"),
      secretInputMode: options?.secretInputMode,
      accountConfigured,
      hasConfigToken,
      allowEnv,
      envValue: process.env.ZALO_BOT_TOKEN,
      envPrompt: t("wizard.zalo.tokenEnvPrompt"),
      keepPrompt: t("wizard.zalo.tokenKeep"),
      inputPrompt: t("wizard.zalo.tokenInput"),
      preferredEnvVar: "ZALO_BOT_TOKEN",
      onMissingConfigured: async () => await noteZaloTokenHelp(prompter),
      applyUseEnv: async (currentCfg) =>
        accountId === DEFAULT_ACCOUNT_ID
          ? ({
              ...currentCfg,
              channels: {
                ...currentCfg.channels,
                zalo: {
                  ...currentCfg.channels?.zalo,
                  enabled: true,
                },
              },
            } as OpenClawConfig)
          : currentCfg,
      applySet: async (currentCfg, value) =>
        accountId === DEFAULT_ACCOUNT_ID
          ? ({
              ...currentCfg,
              channels: {
                ...currentCfg.channels,
                zalo: {
                  ...currentCfg.channels?.zalo,
                  enabled: true,
                  botToken: value,
                },
              },
            } as OpenClawConfig)
          : ({
              ...currentCfg,
              channels: {
                ...currentCfg.channels,
                zalo: {
                  ...currentCfg.channels?.zalo,
                  enabled: true,
                  accounts: {
                    ...currentCfg.channels?.zalo?.accounts,
                    [accountId]: {
                      ...(currentCfg.channels?.zalo?.accounts?.[accountId] as
                        | Record<string, unknown>
                        | undefined),
                      enabled: true,
                      botToken: value,
                    },
                  },
                },
              },
            } as OpenClawConfig),
    });
    next = tokenStep.cfg;

    const wantsWebhook = await prompter.confirm({
      message: t("wizard.zalo.webhookModePrompt"),
      initialValue: Boolean(resolvedAccount.config.webhookUrl),
    });
    if (wantsWebhook) {
      const webhookUrl = (
        await prompter.text({
          message: t("wizard.zalo.webhookUrlPrompt"),
          initialValue: resolvedAccount.config.webhookUrl,
          validate: (value) =>
            value?.trim()?.startsWith("https://") ? undefined : "HTTPS URL required",
        })
      ).trim();
      const defaultPath = (() => {
        try {
          return new URL(webhookUrl).pathname || "/zalo-webhook";
        } catch {
          return "/zalo-webhook";
        }
      })();

      let webhookSecretResult = await promptSingleChannelSecretInput({
        cfg: next,
        prompter,
        providerHint: "zalo-webhook",
        credentialLabel: t("wizard.zalo.webhookSecret"),
        secretInputMode: options?.secretInputMode,
        ...buildSingleChannelSecretPromptState({
          accountConfigured: hasConfiguredSecretInput(resolvedAccount.config.webhookSecret),
          hasConfigToken: hasConfiguredSecretInput(resolvedAccount.config.webhookSecret),
          allowEnv: false,
        }),
        envPrompt: "",
        keepPrompt: t("wizard.zalo.webhookSecretKeep"),
        inputPrompt: t("wizard.zalo.webhookSecretInput"),
        preferredEnvVar: "ZALO_WEBHOOK_SECRET",
      });
      while (
        webhookSecretResult.action === "set" &&
        typeof webhookSecretResult.value === "string" &&
        (webhookSecretResult.value.length < 8 || webhookSecretResult.value.length > 256)
      ) {
        await prompter.note(t("wizard.zalo.webhookSecretLength"), t("wizard.zalo.webhookTitle"));
        webhookSecretResult = await promptSingleChannelSecretInput({
          cfg: next,
          prompter,
          providerHint: "zalo-webhook",
          credentialLabel: t("wizard.zalo.webhookSecret"),
          secretInputMode: options?.secretInputMode,
          ...buildSingleChannelSecretPromptState({
            accountConfigured: false,
            hasConfigToken: false,
            allowEnv: false,
          }),
          envPrompt: "",
          keepPrompt: t("wizard.zalo.webhookSecretKeep"),
          inputPrompt: t("wizard.zalo.webhookSecretInput"),
          preferredEnvVar: "ZALO_WEBHOOK_SECRET",
        });
      }
      const webhookSecret =
        webhookSecretResult.action === "set"
          ? webhookSecretResult.value
          : resolvedAccount.config.webhookSecret;
      const webhookPath = (
        await prompter.text({
          message: t("wizard.zalo.webhookPathPrompt"),
          initialValue: resolvedAccount.config.webhookPath ?? defaultPath,
        })
      ).trim();
      next = setZaloUpdateMode(
        next,
        accountId,
        "webhook",
        webhookUrl,
        webhookSecret,
        webhookPath || undefined,
      );
    } else {
      next = setZaloUpdateMode(next, accountId, "polling");
    }

    if (forceAllowFrom) {
      next = await promptZaloAllowFrom({
        cfg: next,
        prompter,
        accountId,
      });
    }

    return { cfg: next };
  },
  dmPolicy: zaloDmPolicy,
};
