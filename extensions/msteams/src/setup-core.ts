import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
// Msteams plugin module implements setup core behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  createSetupTranslator,
  normalizeAccountId,
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import type { MSTeamsConfig } from "../runtime-api.js";
import {
  resolveDefaultMSTeamsAccountId,
  resolveMSTeamsAccountConfig,
  type MSTeamsMultiAccountConfig,
} from "./accounts.js";
import { normalizeSecretInputString } from "./secret-input.js";
import { hasConfiguredMSTeamsCredentials, resolveMSTeamsCredentials } from "./token.js";

const t = createSetupTranslator();
const channel = "msteams" as const;

type MSTeamsSetupAccountConfig = Partial<MSTeamsConfig> & {
  name?: string;
};

type MSTeamsSetupInput = {
  name?: string;
  appId?: string;
  appPassword?: string;
  tenantId?: string;
  webhookPort?: number;
  useEnv?: boolean;
};

function applySecretAuthCredentials(
  patch: MSTeamsSetupAccountConfig,
  existing: MSTeamsSetupAccountConfig,
): MSTeamsSetupAccountConfig {
  return {
    ...patch,
    authType: "secret",
    ...(existing.certificatePath !== undefined ? { certificatePath: undefined } : {}),
    ...(existing.certificateThumbprint !== undefined ? { certificateThumbprint: undefined } : {}),
    ...(existing.useManagedIdentity !== undefined ? { useManagedIdentity: undefined } : {}),
    ...(existing.managedIdentityClientId !== undefined
      ? { managedIdentityClientId: undefined }
      : {}),
  };
}

function readMSTeamsSetupCredential(
  input: MSTeamsSetupInput,
  key: "appId" | "appPassword" | "tenantId",
): string | undefined {
  switch (key) {
    case "appId":
      return "appId" in input && typeof input.appId === "string" ? input.appId : undefined;
    case "appPassword":
      return "appPassword" in input && typeof input.appPassword === "string"
        ? input.appPassword
        : undefined;
    case "tenantId":
      return "tenantId" in input && typeof input.tenantId === "string" ? input.tenantId : undefined;
  }
  return undefined;
}

function resolveSetupAccountId(cfg: OpenClawConfig, accountId?: string | null): string {
  return normalizeAccountId(accountId ?? resolveDefaultMSTeamsAccountId(cfg));
}

function resolveMSTeamsSetupChannelConfig(
  cfg: OpenClawConfig,
): MSTeamsMultiAccountConfig | undefined {
  return cfg.channels?.msteams as MSTeamsMultiAccountConfig | undefined; // SAFETY: the public config contract owns these optional fields.
}

function resolveRawMSTeamsAccountKey(
  accounts: Record<string, Partial<MSTeamsConfig>> | undefined,
  accountId: string,
): string | undefined {
  const normalized = normalizeAccountId(accountId);
  if (!accounts) {
    return undefined;
  }
  return Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
}

function resolveRawMSTeamsAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): MSTeamsSetupAccountConfig {
  const normalized = normalizeAccountId(accountId);
  const msteams = (cfg.channels?.msteams ?? {}) as MSTeamsMultiAccountConfig; // SAFETY: the public config contract owns these optional fields.
  if (normalized === DEFAULT_ACCOUNT_ID) {
    return msteams;
  }
  const rawAccountKey = resolveRawMSTeamsAccountKey(msteams.accounts, normalized);
  return (rawAccountKey ? msteams.accounts?.[rawAccountKey] : undefined) ?? {};
}

function splitRootIdentity(msteams: MSTeamsMultiAccountConfig): {
  root: MSTeamsMultiAccountConfig;
  defaultAccount: MSTeamsSetupAccountConfig;
} {
  const { appId, appPassword, webhook, ...root } = msteams;
  const rootWebhook = webhook ? { ...webhook } : undefined;
  const defaultWebhook = rootWebhook?.port === undefined ? undefined : { port: rootWebhook.port };
  if (rootWebhook) {
    delete rootWebhook.port;
  }
  const defaultAccount: MSTeamsSetupAccountConfig = {
    ...(appId !== undefined ? { appId } : {}),
    ...(appPassword !== undefined ? { appPassword } : {}),
    ...(defaultWebhook ? { webhook: defaultWebhook } : {}),
  };
  return {
    root: {
      ...root,
      ...(rootWebhook && Object.keys(rootWebhook).length > 0 ? { webhook: rootWebhook } : {}),
    },
    defaultAccount,
  };
}

export function patchMSTeamsAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: MSTeamsSetupAccountConfig;
  ensureEnabled?: boolean;
  scopeDefaultToAccounts?: boolean;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const msteams = (params.cfg.channels?.msteams ?? {}) as MSTeamsMultiAccountConfig; // SAFETY: the public config contract owns these optional fields.
  const ensureEnabled = params.ensureEnabled ?? true;
  const scopeDefaultToAccounts = params.scopeDefaultToAccounts ?? false;
  if (accountId === DEFAULT_ACCOUNT_ID && !scopeDefaultToAccounts) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        msteams: {
          ...msteams,
          ...(ensureEnabled ? { enabled: true } : {}),
          ...params.patch,
        },
      },
    };
  }

  const { root: baseMsteams, defaultAccount } = splitRootIdentity(msteams);
  const baseAccounts = baseMsteams.accounts ?? {};
  const hasPromotedDefaultIdentity = Object.keys(defaultAccount).length > 0;
  const promotedDefaultKey =
    resolveRawMSTeamsAccountKey(baseAccounts, DEFAULT_ACCOUNT_ID) ?? DEFAULT_ACCOUNT_ID;
  const accounts =
    hasPromotedDefaultIdentity && accountId !== DEFAULT_ACCOUNT_ID
      ? {
          ...baseAccounts,
          [promotedDefaultKey]: {
            ...defaultAccount,
            ...baseAccounts[promotedDefaultKey],
          },
        }
      : baseAccounts;
  const rawAccountKey = resolveRawMSTeamsAccountKey(accounts, accountId) ?? accountId;
  const existing =
    accountId === DEFAULT_ACCOUNT_ID
      ? ({ ...defaultAccount, ...accounts[rawAccountKey] } as MSTeamsSetupAccountConfig) // SAFETY: both are account fragments.
      : ((accounts[rawAccountKey] ?? {}) as MSTeamsSetupAccountConfig); // SAFETY: map values are account fragments.
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      msteams: {
        ...baseMsteams,
        ...(ensureEnabled ? { enabled: true } : {}),
        accounts: {
          ...accounts,
          [rawAccountKey]: {
            ...existing,
            ...(ensureEnabled ? { enabled: true } : {}),
            ...params.patch,
          },
        },
      } as MSTeamsMultiAccountConfig, // SAFETY: this preserves MSTeamsConfig and adds its declared accounts map.
    },
  };
}

function resolveCredentialsForSetup(cfg: OpenClawConfig, accountId: string) {
  return resolveMSTeamsCredentials(resolveMSTeamsAccountConfig(cfg, accountId), {
    allowEnvFallback: accountId === DEFAULT_ACCOUNT_ID,
    pathPrefix:
      accountId === DEFAULT_ACCOUNT_ID
        ? "channels.msteams"
        : `channels.msteams.accounts.${accountId}`,
  });
}

function hasConfiguredCredentialsForSetup(cfg: OpenClawConfig, accountId: string): boolean {
  const accountConfig = resolveMSTeamsAccountConfig(cfg, accountId);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return hasConfiguredMSTeamsCredentials(accountConfig);
  }
  if (resolveCredentialsForSetup(cfg, accountId)) {
    return true;
  }
  if (accountConfig.authType === "federated") {
    return Boolean(
      normalizeSecretInputString(accountConfig.appId) &&
      normalizeSecretInputString(accountConfig.tenantId) &&
      (accountConfig.certificatePath || accountConfig.useManagedIdentity),
    );
  }
  return Boolean(
    normalizeSecretInputString(accountConfig.appId) &&
    normalizeSecretInputString(accountConfig.tenantId) &&
    accountConfig.appPassword,
  );
}

export const msteamsSetupAdapter: ChannelSetupAdapter<MSTeamsSetupInput> = {
  resolveAccountId: ({ cfg, accountId }) => resolveSetupAccountId(cfg, accountId),
  applyAccountName: ({ cfg, accountId, name }) => {
    const trimmed = name?.trim();
    return trimmed
      ? patchMSTeamsAccountConfig({
          cfg,
          accountId: resolveSetupAccountId(cfg, accountId),
          patch: { name: trimmed },
        })
      : cfg;
  },
  validateInput: ({ cfg, accountId, input }) => {
    const appId = readMSTeamsSetupCredential(input, "appId");
    const appPassword = readMSTeamsSetupCredential(input, "appPassword");
    const tenantId = readMSTeamsSetupCredential(input, "tenantId");
    if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return "MSTEAMS_* environment variables can only be used for the default account.";
    }
    if (!input.useEnv && !(appId?.trim() && appPassword?.trim() && tenantId?.trim())) {
      return "MS Teams requires appId, appPassword, and tenantId (or --use-env for the default account).";
    }
    if (
      input.webhookPort !== undefined &&
      (!Number.isInteger(input.webhookPort) || input.webhookPort < 1 || input.webhookPort > 65535)
    ) {
      return "MS Teams webhook port must be an integer between 1 and 65535.";
    }
    if (
      accountId !== DEFAULT_ACCOUNT_ID &&
      input.webhookPort === undefined &&
      typeof resolveRawMSTeamsAccountConfig(cfg, accountId).webhook?.port !== "number"
    ) {
      return "MS Teams named accounts require --webhook-port <1-65535>.";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const resolvedAccountId = resolveSetupAccountId(cfg, accountId);
    const appId = readMSTeamsSetupCredential(input, "appId");
    const appPassword = readMSTeamsSetupCredential(input, "appPassword");
    const tenantId = readMSTeamsSetupCredential(input, "tenantId");
    const existing = resolveRawMSTeamsAccountConfig(cfg, resolvedAccountId);
    const patch: MSTeamsSetupAccountConfig = {};
    if (appId?.trim()) {
      patch.appId = appId.trim();
    }
    if (appPassword?.trim()) {
      patch.appPassword = appPassword.trim();
    }
    if (tenantId?.trim()) {
      patch.tenantId = tenantId.trim();
    }
    if (input.webhookPort !== undefined) {
      patch.webhook = { ...existing.webhook, port: input.webhookPort };
    }
    return patchMSTeamsAccountConfig({
      cfg,
      accountId: resolvedAccountId,
      patch: applySecretAuthCredentials(patch, existing),
      scopeDefaultToAccounts: true,
    });
  },
};

export const msteamsSetupContract = defineChannelSetupContract({
  fields: {
    appId: {
      kind: "string",
      cli: { flags: "--app-id <id>", description: "Microsoft Teams application id" },
    },
    appPassword: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--app-password <secret>", description: "Microsoft Teams app password" },
    },
    tenantId: {
      kind: "string",
      cli: { flags: "--tenant-id <id>", description: "Microsoft Teams tenant id" },
    },
    webhookPort: {
      kind: "integer",
      cli: { flags: "--webhook-port <port>", description: "Microsoft Teams webhook port" },
    },
    useEnv: {
      kind: "boolean",
      cli: { flags: "--use-env", description: "Use Microsoft Teams environment credentials" },
      envVars: ["MSTEAMS_APP_ID", "MSTEAMS_APP_PASSWORD", "MSTEAMS_TENANT_ID"],
      envVarMode: "all",
    },
  },
  adapter: msteamsSetupAdapter,
});

function enableMSTeamsAccount(cfg: OpenClawConfig, accountId: string): OpenClawConfig {
  const resolvedAccountId = normalizeAccountId(accountId);
  const accounts = resolveMSTeamsSetupChannelConfig(cfg)?.accounts;
  const hasScopedDefault =
    resolvedAccountId === DEFAULT_ACCOUNT_ID &&
    resolveRawMSTeamsAccountKey(accounts, DEFAULT_ACCOUNT_ID) !== undefined;
  return patchMSTeamsAccountConfig({
    cfg,
    accountId: resolvedAccountId,
    patch: {},
    scopeDefaultToAccounts: hasScopedDefault,
  });
}

function setMSTeamsAccountCredentials(params: {
  cfg: OpenClawConfig;
  accountId: string;
  appId: string;
  appPassword: string;
  tenantId: string;
  webhookPort?: number;
}): OpenClawConfig {
  const existing = resolveRawMSTeamsAccountConfig(params.cfg, params.accountId);
  return patchMSTeamsAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
    patch: applySecretAuthCredentials(
      {
        appId: params.appId,
        appPassword: params.appPassword,
        tenantId: params.tenantId,
        ...(params.webhookPort !== undefined
          ? { webhook: { ...existing.webhook, port: params.webhookPort } }
          : {}),
      },
      existing,
    ),
    scopeDefaultToAccounts: params.accountId === DEFAULT_ACCOUNT_ID,
  });
}

function setMSTeamsAccountWebhookPort(params: {
  cfg: OpenClawConfig;
  accountId: string;
  port: number;
}): OpenClawConfig {
  const existing = resolveRawMSTeamsAccountConfig(params.cfg, params.accountId);
  return patchMSTeamsAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
    patch: { webhook: { ...existing.webhook, port: params.port } },
  });
}

async function promptMSTeamsWebhookPort(params: {
  cfg: OpenClawConfig;
  accountId: string;
  prompter: WizardPrompter;
}): Promise<number> {
  const current = resolveMSTeamsAccountConfig(params.cfg, params.accountId).webhook?.port;
  const raw = await params.prompter.text({
    message: t("wizard.msteams.webhookPortPrompt"),
    initialValue: typeof current === "number" ? String(current) : undefined,
    validate: (value) => {
      const trimmed = value.trim();
      const port = /^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
      return Number.isInteger(port) && port > 0 && port <= 65535
        ? undefined
        : t("wizard.msteams.webhookPortInvalid");
    },
  });
  return Number(raw.trim());
}
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
    resolveAccountIdForConfigure: ({ cfg, accountOverride, defaultAccountId }) =>
      resolveSetupAccountId(cfg, accountOverride ?? defaultAccountId),
    resolveShouldPromptAccountIds: ({ shouldPromptAccountIds }) => shouldPromptAccountIds,
    status: createStandardChannelSetupStatus({
      channelLabel: "MS Teams",
      configuredLabel: t("wizard.channels.statusConfigured"),
      unconfiguredLabel: t("wizard.channels.statusNeedsAppCredentials"),
      configuredHint: t("wizard.channels.statusConfigured"),
      unconfiguredHint: t("wizard.channels.statusNeedsAppCreds"),
      configuredScore: 2,
      unconfiguredScore: 0,
      includeStatusLine: true,
      resolveConfigured: ({ cfg, accountId }) => {
        const resolvedAccountId = resolveSetupAccountId(cfg, accountId);
        return (
          Boolean(resolveCredentialsForSetup(cfg, resolvedAccountId)) ||
          hasConfiguredCredentialsForSetup(cfg, resolvedAccountId)
        );
      },
    }),
    credentials: [],
    finalize: async ({ cfg, accountId, prompter }) => {
      const resolvedAccountId = resolveSetupAccountId(cfg, accountId);
      const resolved = resolveCredentialsForSetup(cfg, resolvedAccountId);
      const hasConfigCreds = hasConfiguredCredentialsForSetup(cfg, resolvedAccountId);
      const canUseEnv = Boolean(
        resolvedAccountId === DEFAULT_ACCOUNT_ID &&
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
          next = enableMSTeamsAccount(next, resolvedAccountId);
        } else {
          ({ appId, appPassword, tenantId } = await promptMSTeamsCredentials(prompter));
        }
      } else {
        ({ appId, appPassword, tenantId } = await promptMSTeamsCredentials(prompter));
      }

      let webhookPort: number | undefined;
      if (
        resolvedAccountId !== DEFAULT_ACCOUNT_ID &&
        typeof resolveMSTeamsAccountConfig(next, resolvedAccountId).webhook?.port !== "number"
      ) {
        webhookPort = await promptMSTeamsWebhookPort({
          cfg: next,
          accountId: resolvedAccountId,
          prompter,
        });
      }

      if (appId && appPassword && tenantId) {
        next = setMSTeamsAccountCredentials({
          cfg: next,
          accountId: resolvedAccountId,
          appId,
          appPassword,
          tenantId,
          webhookPort,
        });
      } else if (webhookPort !== undefined) {
        next = setMSTeamsAccountWebhookPort({
          cfg: next,
          accountId: resolvedAccountId,
          port: webhookPort,
        });
      }

      return { cfg: next, accountId: resolvedAccountId };
    },
  };
}
