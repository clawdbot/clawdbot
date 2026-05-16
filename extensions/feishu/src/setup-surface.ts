import {
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  hasConfiguredSecretInput,
  mergeAllowFromEntries,
  patchTopLevelChannelConfigSection,
  promptSingleChannelSecretInput,
  splitSetupEntries,
  createSetupTranslator,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type DmPolicy,
  type OpenClawConfig,
  type SecretInput,
} from "openclaw/plugin-sdk/setup";
import { resolveDefaultFeishuAccountId, resolveFeishuAccount } from "./accounts.js";
import type { AppRegistrationResult } from "./app-registration.js";
import type { FeishuConfig, FeishuDomain } from "./types.js";

const t = createSetupTranslator();

const channel = "feishu" as const;
const SCAN_TO_CREATE_TP = "ob_cli_app";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isFeishuConfigured(cfg: OpenClawConfig): boolean {
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;

  const isAppIdConfigured = (value: unknown): boolean => {
    const asString = normalizeString(value);
    if (asString) {
      return true;
    }
    if (!value || typeof value !== "object") {
      return false;
    }
    const rec = value as Record<string, unknown>;
    const source = normalizeString(rec.source)?.toLowerCase();
    const id = normalizeString(rec.id);
    if (source === "env" && id) {
      return Boolean(normalizeString(process.env[id]));
    }
    return hasConfiguredSecretInput(value);
  };

  const topLevelConfigured =
    isAppIdConfigured(feishuCfg?.appId) && hasConfiguredSecretInput(feishuCfg?.appSecret);

  const accountConfigured = Object.values(feishuCfg?.accounts ?? {}).some((account) => {
    if (!account || typeof account !== "object") {
      return false;
    }
    const hasOwnAppId = Object.prototype.hasOwnProperty.call(account, "appId");
    const hasOwnAppSecret = Object.prototype.hasOwnProperty.call(account, "appSecret");
    const accountAppIdConfigured = hasOwnAppId
      ? isAppIdConfigured((account as Record<string, unknown>).appId)
      : isAppIdConfigured(feishuCfg?.appId);
    const accountSecretConfigured = hasOwnAppSecret
      ? hasConfiguredSecretInput((account as Record<string, unknown>).appSecret)
      : hasConfiguredSecretInput(feishuCfg?.appSecret);
    return accountAppIdConfigured && accountSecretConfigured;
  });

  return topLevelConfigured || accountConfigured;
}

function formatFeishuStatusLine(status: "configured-unverified" | "needs-credentials"): string {
  if (status === "needs-credentials") {
    return `Feishu: ${t("wizard.channels.statusNeedsAppCredentials")}`;
  }
  return `Feishu: ${t("wizard.channels.statusConfiguredConnectionNotVerified")}`;
}

/**
 * Patch feishu config at the correct location based on accountId.
 * - DEFAULT_ACCOUNT_ID → writes to top-level channels.feishu
 * - named account → writes to channels.feishu.accounts[accountId]
 */
function patchFeishuConfig(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Record<string, unknown>,
): OpenClawConfig {
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return patchTopLevelChannelConfigSection({
      cfg,
      channel,
      enabled: true,
      patch,
    });
  }
  const nextAccountPatch = {
    ...(feishuCfg?.accounts?.[accountId] as Record<string, unknown> | undefined),
    enabled: true,
    ...patch,
  };
  return patchTopLevelChannelConfigSection({
    cfg,
    channel,
    enabled: true,
    patch: {
      accounts: {
        ...feishuCfg?.accounts,
        [accountId]: nextAccountPatch,
      },
    },
  });
}

async function promptFeishuAllowFrom(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  prompter: Parameters<NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>>[0]["prompter"];
}): Promise<OpenClawConfig> {
  const feishuCfg = params.cfg.channels?.feishu as FeishuConfig | undefined;
  const resolvedAccountId = params.accountId ?? resolveDefaultFeishuAccountId(params.cfg);
  const account =
    resolvedAccountId !== DEFAULT_ACCOUNT_ID
      ? (feishuCfg?.accounts?.[resolvedAccountId] as Record<string, unknown> | undefined)
      : undefined;
  const existingAllowFrom = (account?.allowFrom ?? feishuCfg?.allowFrom ?? []) as Array<
    string | number
  >;
  await params.prompter.note(
    [
      t("wizard.feishu.allowlistIntro"),
      t("wizard.feishu.allowlistFindUser"),
      t("wizard.feishu.examples"),
      "- ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "- on_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    ].join("\n"),
    t("wizard.feishu.allowlistTitle"),
  );
  const entry = await params.prompter.text({
    message: t("wizard.feishu.allowFromPrompt"),
    placeholder: "ou_xxxxx, ou_yyyyy",
    initialValue:
      existingAllowFrom.length > 0 ? existingAllowFrom.map(String).join(", ") : undefined,
  });
  const mergedAllowFrom = mergeAllowFromEntries(existingAllowFrom, splitSetupEntries(entry));
  return patchFeishuConfig(params.cfg, resolvedAccountId, { allowFrom: mergedAllowFrom });
}

async function noteFeishuCredentialHelp(
  prompter: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"],
): Promise<void> {
  await prompter.note(
    [
      t("wizard.feishu.credentialsStepOpenPlatform"),
      t("wizard.feishu.credentialsStepCreateApp"),
      t("wizard.feishu.credentialsStepGetCredentials"),
      t("wizard.feishu.credentialsStepPermissions"),
      t("wizard.feishu.credentialsStepPublish"),
      t("wizard.feishu.credentialsEnvTip"),
      t("wizard.channels.docs", { link: formatDocsLink("/channels/feishu", "feishu") }),
    ].join("\n"),
    t("wizard.feishu.credentialsTitle"),
  );
}

async function promptFeishuAppId(params: {
  prompter: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"];
  initialValue?: string;
}): Promise<string> {
  return (
    await params.prompter.text({
      message: t("wizard.feishu.appIdPrompt"),
      initialValue: params.initialValue,
      validate: (value) => (value?.trim() ? undefined : t("common.required")),
    })
  ).trim();
}

const feishuDmPolicy: ChannelSetupDmPolicy = {
  label: "Feishu",
  channel,
  policyKey: "channels.feishu.dmPolicy",
  allowFromKey: "channels.feishu.allowFrom",
  resolveConfigKeys: (_cfg, accountId) => {
    const resolvedAccountId = accountId ?? resolveDefaultFeishuAccountId(_cfg);
    return resolvedAccountId !== DEFAULT_ACCOUNT_ID
      ? {
          policyKey: `channels.feishu.accounts.${resolvedAccountId}.dmPolicy`,
          allowFromKey: `channels.feishu.accounts.${resolvedAccountId}.allowFrom`,
        }
      : {
          policyKey: "channels.feishu.dmPolicy",
          allowFromKey: "channels.feishu.allowFrom",
        };
  },
  getCurrent: (cfg, accountId) => {
    const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
    const resolvedAccountId = accountId ?? resolveDefaultFeishuAccountId(cfg);
    if (resolvedAccountId !== DEFAULT_ACCOUNT_ID) {
      const account = feishuCfg?.accounts?.[resolvedAccountId] as
        | Record<string, unknown>
        | undefined;
      if (account?.dmPolicy) {
        return account.dmPolicy as DmPolicy;
      }
    }
    return (feishuCfg?.dmPolicy as DmPolicy | undefined) ?? "pairing";
  },
  setPolicy: (cfg, policy, accountId) => {
    const resolvedAccountId = accountId ?? resolveDefaultFeishuAccountId(cfg);
    return patchFeishuConfig(cfg, resolvedAccountId, {
      dmPolicy: policy,
      ...(policy === "open" ? { allowFrom: mergeAllowFromEntries([], ["*"]) } : {}),
    });
  },
  promptAllowFrom: promptFeishuAllowFrom,
};

type WizardPrompter = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"];
type FeishuSetupMethod = "manual" | "scan";

// ---------------------------------------------------------------------------
// Security policy helpers
// ---------------------------------------------------------------------------

function applyNewAppSecurityPolicy(
  cfg: OpenClawConfig,
  accountId: string,
  openId: string | undefined,
  groupPolicy: "allowlist" | "open" | "disabled",
): OpenClawConfig {
  let next = cfg;

  if (openId) {
    // dmPolicy=allowlist, allowFrom=[openId]
    next = patchFeishuConfig(next, accountId, { dmPolicy: "allowlist", allowFrom: [openId] });
  }

  // Apply group policy.
  const groupPatch: Record<string, unknown> = { groupPolicy };
  if (groupPolicy === "open") {
    groupPatch.requireMention = true;
  }
  next = patchFeishuConfig(next, accountId, groupPatch);

  return next;
}

// ---------------------------------------------------------------------------
// Scan-to-create flow
// ---------------------------------------------------------------------------

async function promptFeishuDomain(params: {
  prompter: WizardPrompter;
  initialValue?: FeishuDomain;
}): Promise<FeishuDomain> {
  return (await params.prompter.select({
    message: t("wizard.feishu.domainPrompt"),
    options: [
      { value: "feishu", label: t("wizard.feishu.domainFeishu") },
      { value: "lark", label: t("wizard.feishu.domainLark") },
    ],
    initialValue: params.initialValue ?? "feishu",
  })) as FeishuDomain;
}

async function promptFeishuSetupMethod(prompter: WizardPrompter): Promise<FeishuSetupMethod> {
  return (await prompter.select({
    message: t("wizard.feishu.setupMethodPrompt"),
    options: [
      { value: "manual", label: t("wizard.feishu.setupMethodManual") },
      { value: "scan", label: t("wizard.feishu.setupMethodScan") },
    ],
    initialValue: "manual",
  })) as FeishuSetupMethod;
}

async function runScanToCreate(
  prompter: WizardPrompter,
  domain: FeishuDomain,
): Promise<AppRegistrationResult | null> {
  const { beginAppRegistration, initAppRegistration, pollAppRegistration, printQrCode } =
    await import("./app-registration.js");
  try {
    await initAppRegistration(domain);
  } catch {
    await prompter.note(t("wizard.feishu.scanUnavailable"), t("wizard.feishu.setupTitle"));
    return null;
  }

  const begin = await beginAppRegistration(domain);

  await prompter.note(t("wizard.feishu.scanQr"), t("wizard.feishu.scanTitle"));
  await printQrCode(begin.qrUrl);

  const progress = prompter.progress(t("wizard.feishu.fetchingConfig"));

  const outcome = await pollAppRegistration({
    deviceCode: begin.deviceCode,
    interval: begin.interval,
    expireIn: begin.expireIn,
    initialDomain: domain,
    tp: SCAN_TO_CREATE_TP,
  });

  switch (outcome.status) {
    case "success":
      progress.stop(t("wizard.feishu.scanCompleted"));
      return outcome.result;
    case "access_denied":
      progress.stop(t("wizard.feishu.scanDenied"));
      return null;
    case "expired":
      progress.stop(t("wizard.feishu.scanExpired"));
      return null;
    case "timeout":
      progress.stop(t("wizard.feishu.scanTimedOut"));
      return null;
    case "error":
      progress.stop(t("wizard.feishu.scanError", { error: outcome.message }));
      return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// New app configuration flow
// ---------------------------------------------------------------------------

async function runNewAppFlow(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  options: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["options"];
}): Promise<{ cfg: OpenClawConfig }> {
  const { prompter, options } = params;
  let next = params.cfg;

  // Resolve target account: defaultAccount > first account key > top-level.
  const targetAccountId = resolveDefaultFeishuAccountId(next);

  // ----- QR scan flow -----
  let appId: string | null = null;
  let appSecret: SecretInput | null = null;
  let appSecretProbeValue: string | null = null;
  let scanDomain: FeishuDomain | undefined;
  let scanOpenId: string | undefined;
  const feishuCfg = next.channels?.feishu as FeishuConfig | undefined;
  const currentDomain = feishuCfg?.domain ?? "feishu";
  const setupMethod = await promptFeishuSetupMethod(prompter);
  const selectedDomain = await promptFeishuDomain({
    prompter,
    initialValue: currentDomain,
  });
  scanDomain = selectedDomain;

  const scanResult =
    setupMethod === "scan" ? await runScanToCreate(prompter, selectedDomain) : null;
  if (scanResult) {
    appId = scanResult.appId;
    appSecret = scanResult.appSecret;
    appSecretProbeValue = scanResult.appSecret;
    scanDomain = scanResult.domain;
    scanOpenId = scanResult.openId;
  } else {
    // Fallback to manual input: collect domain, appId, appSecret.
    await noteFeishuCredentialHelp(prompter);

    appId = await promptFeishuAppId({
      prompter,
      initialValue: normalizeString(process.env.FEISHU_APP_ID),
    });

    const appSecretResult = await promptSingleChannelSecretInput({
      cfg: next,
      prompter,
      providerHint: "feishu",
      credentialLabel: "App Secret",
      secretInputMode: options?.secretInputMode,
      accountConfigured: false,
      canUseEnv: false,
      hasConfigToken: false,
      envPrompt: "",
      keepPrompt: t("wizard.feishu.appSecretKeep"),
      inputPrompt: t("wizard.feishu.appSecretPrompt"),
      preferredEnvVar: "FEISHU_APP_SECRET",
    });
    if (appSecretResult.action === "set") {
      appSecret = appSecretResult.value;
      appSecretProbeValue = appSecretResult.resolvedValue;
    }

    // Fetch openId via API for manual flow.
    if (appId && appSecretProbeValue) {
      const { getAppOwnerOpenId } = await import("./app-registration.js");
      scanOpenId = await getAppOwnerOpenId({
        appId,
        appSecret: appSecretProbeValue,
        domain: selectedDomain,
      });
    }
  }

  // ----- Group chat policy -----
  const groupPolicy = (await prompter.select({
    message: t("wizard.feishu.groupPolicyPrompt"),
    options: [
      { value: "allowlist", label: t("wizard.feishu.groupPolicyAllowlist") },
      { value: "open", label: t("wizard.feishu.groupPolicyOpen") },
      { value: "disabled", label: t("wizard.feishu.groupPolicyDisabled") },
    ],
    initialValue: "allowlist",
  })) as "allowlist" | "open" | "disabled";

  // ----- Apply credentials & security policy -----
  const configProgress = prompter.progress(t("wizard.feishu.configuring"));
  await new Promise((resolve) => setTimeout(resolve, 50));

  if (appId && appSecret) {
    next = patchFeishuConfig(next, targetAccountId, {
      appId,
      appSecret,
      connectionMode: "websocket",
      ...(scanDomain ? { domain: scanDomain } : {}),
    });
  } else if (scanDomain) {
    next = patchFeishuConfig(next, targetAccountId, { domain: scanDomain });
  }

  next = applyNewAppSecurityPolicy(next, targetAccountId, scanOpenId, groupPolicy);

  configProgress.stop(t("wizard.feishu.botConfigured"));

  return { cfg: next };
}

// ---------------------------------------------------------------------------
// Edit configuration flow
// ---------------------------------------------------------------------------

async function runEditFlow(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  options: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["options"];
}): Promise<{ cfg: OpenClawConfig } | null> {
  const { prompter, options } = params;
  const next = params.cfg;
  const feishuCfg = next.channels?.feishu as FeishuConfig | undefined;

  // Check existing appId (top-level or first configured account).
  // Supports both plain string and SecretRef (env-backed) appId values.
  const resolveAppIdLabel = (value: unknown): string | undefined => {
    const asString = normalizeString(value);
    if (asString) {
      return asString;
    }
    if (value && typeof value === "object") {
      const rec = value as Record<string, unknown>;
      if (normalizeString(rec.source) && normalizeString(rec.id)) {
        const envValue = normalizeString(process.env[rec.id as string]);
        return envValue ?? `env:${String(rec.id)}`;
      }
      if (hasConfiguredSecretInput(value)) {
        return "(configured)";
      }
    }
    return undefined;
  };
  const existingAppId =
    resolveAppIdLabel(feishuCfg?.appId) ??
    Object.values(feishuCfg?.accounts ?? {}).reduce<string | undefined>((found, account) => {
      if (found) {
        return found;
      }
      if (account && typeof account === "object") {
        return resolveAppIdLabel((account as Record<string, unknown>).appId);
      }
      return undefined;
    }, undefined);
  if (existingAppId) {
    const useExisting = await prompter.confirm({
      message: t("wizard.feishu.existingBotPrompt", { appId: existingAppId }),
      initialValue: true,
    });

    if (!useExisting) {
      // User wants a new bot — run new app flow.
      return runNewAppFlow({ cfg: next, prompter, options });
    }
  } else {
    // No existing appId — run new app flow.
    return runNewAppFlow({ cfg: next, prompter, options });
  }

  await prompter.note(t("wizard.feishu.botConfigured"), "");

  return { cfg: next };
}

// ---------------------------------------------------------------------------
// Standalone login entry point (for `channels login --channel feishu`)
// ---------------------------------------------------------------------------

export async function runFeishuLogin(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const { cfg, prompter } = params;
  const options = {};
  const alreadyConfigured = isFeishuConfigured(cfg);

  if (alreadyConfigured) {
    const result = await runEditFlow({ cfg, prompter, options });
    if (result === null) {
      return cfg;
    }
    return result.cfg;
  }

  const result = await runNewAppFlow({ cfg, prompter, options });
  return result.cfg;
}

// ---------------------------------------------------------------------------
// Exported wizard
// ---------------------------------------------------------------------------

export const feishuSetupWizard: ChannelSetupWizard = {
  channel,
  resolveAccountIdForConfigure: ({ accountOverride, defaultAccountId, cfg }) =>
    (typeof accountOverride === "string" && accountOverride.trim()
      ? accountOverride.trim()
      : undefined) ??
    resolveDefaultFeishuAccountId(cfg) ??
    defaultAccountId,
  resolveShouldPromptAccountIds: () => false,
  status: {
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsAppCredentials"),
    configuredHint: t("wizard.channels.statusConfigured"),
    unconfiguredHint: t("wizard.channels.statusNeedsAppCreds"),
    configuredScore: 2,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) => isFeishuConfigured(cfg),
    resolveStatusLines: async ({ cfg, accountId, configured }) => {
      const account = resolveFeishuAccount({ cfg, accountId });
      let probeResult = null;
      if (configured && account.configured) {
        try {
          const { probeFeishu } = await import("./probe.js");
          probeResult = await probeFeishu(account);
        } catch {}
      }
      if (!configured) {
        return [formatFeishuStatusLine("needs-credentials")];
      }
      if (probeResult?.ok) {
        return [
          `Feishu: ${t("wizard.channels.statusConnectedAs", {
            name: probeResult.botName ?? probeResult.botOpenId ?? "bot",
          })}`,
        ];
      }
      return [formatFeishuStatusLine("configured-unverified")];
    },
  },

  // -------------------------------------------------------------------------
  // prepare: determine flow based on existing configuration
  // -------------------------------------------------------------------------
  prepare: async ({ cfg, credentialValues }) => {
    const alreadyConfigured = isFeishuConfigured(cfg);

    if (alreadyConfigured) {
      return {
        credentialValues: { ...credentialValues, _flow: "edit" },
      };
    }

    return {
      credentialValues: { ...credentialValues, _flow: "new" },
    };
  },

  credentials: [],

  // -------------------------------------------------------------------------
  // finalize: run the appropriate flow
  // -------------------------------------------------------------------------
  finalize: async ({ cfg, prompter, options, credentialValues }) => {
    const flow = credentialValues._flow ?? "new";

    if (flow === "edit") {
      const result = await runEditFlow({ cfg, prompter, options });
      if (result === null) {
        return { cfg };
      }
      return result;
    }

    return runNewAppFlow({ cfg, prompter, options });
  },

  dmPolicy: feishuDmPolicy,
  disable: (cfg) =>
    patchTopLevelChannelConfigSection({
      cfg,
      channel,
      patch: { enabled: false },
    }),
};
