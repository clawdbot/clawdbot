// Shared setup-wizard steps used by the classic wizard and the bootstrap onboarding flow.
import type { GatewayAuthChoice, OnboardOptions } from "../commands/onboard-types.js";
import { createConfigIO, resolveGatewayPort } from "../config/config.js";
import type { ConfigWriteOptions } from "../config/io.js";
import { applyMergePatch, createMergePatch } from "../config/merge-patch.js";
import type { ConfigWriteAfterWrite } from "../config/runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { transformConfigWithPendingPluginInstalls } from "../plugins/install-record-commit.js";
import { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";
import { t } from "./i18n/index.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";
import {
  getSecurityConfirmMessage,
  getSecurityNoteMessage,
  getSecurityNoteTitle,
} from "./setup.security-note.js";
import type { QuickstartGatewayDefaults } from "./setup.types.js";

type QuickstartGatewayOptionOverrides = Pick<
  OnboardOptions,
  | "gatewayPort"
  | "gatewayBind"
  | "gatewayAuth"
  | "gatewayToken"
  | "gatewayTokenRefEnv"
  | "gatewayPassword"
  | "tailscale"
>;

export function hasQuickstartGatewayOverrides(
  overrides: QuickstartGatewayOptionOverrides,
): boolean {
  return (
    overrides.gatewayPort !== undefined ||
    overrides.gatewayBind !== undefined ||
    overrides.gatewayAuth !== undefined ||
    overrides.gatewayToken !== undefined ||
    overrides.gatewayTokenRefEnv !== undefined ||
    overrides.gatewayPassword !== undefined ||
    overrides.tailscale !== undefined
  );
}

export function formatQuickstartGatewaySummary(
  defaults: QuickstartGatewayDefaults,
  keepExisting: boolean,
): string {
  const bind = {
    auto: t("wizard.gateway.bindAuto"),
    custom: t("wizard.gateway.bindCustom"),
    lan: t("wizard.gateway.bindLan"),
    loopback: t("wizard.gateway.bindLoopback"),
    tailnet: t("wizard.gateway.bindTailnet"),
  }[defaults.bind];
  return [
    ...(keepExisting ? [t("wizard.setup.quickstartKeepSettings")] : []),
    t("wizard.setup.quickstartGatewayPort", { port: defaults.port }),
    t("wizard.setup.quickstartGatewayBind", { bind }),
    ...(defaults.bind === "custom" && defaults.customBindHost
      ? [
          t("wizard.setup.quickstartGatewayCustomIp", {
            host: defaults.customBindHost,
          }),
        ]
      : []),
    t("wizard.setup.quickstartGatewayAuth", {
      auth:
        defaults.authMode === "token"
          ? t("wizard.setup.quickstartAuthTokenDefault")
          : t("common.password"),
    }),
    t("wizard.setup.quickstartTailscaleExposure", {
      exposure: t(`wizard.gatewayTailscale.${defaults.tailscaleMode}`),
    }),
    t("wizard.setup.quickstartDirectChannels"),
  ].join("\n");
}

/**
 * Config writes go through the pending-plugin-install commit helper so wizard
 * flows never drop install records that a concurrent migration already staged.
 */
export async function writeWizardConfigFile(
  config: OpenClawConfig,
  opts: {
    allowConfigSizeDrop?: boolean;
    /** Reject the write if config changed after the caller's verified snapshot. */
    baseHash?: string;
    /** Preserve an absent-file precondition that cannot be represented by baseHash. */
    baseSnapshot?: ConfigFileSnapshot;
    /** Apply only the wizard's delta to the latest authored config. */
    mergeBase?: OpenClawConfig;
    writeOptions?: ConfigWriteOptions;
    /** Runtime follow-up intent for the Gateway config watcher. */
    afterWrite?: ConfigWriteAfterWrite;
  } = {},
): Promise<OpenClawConfig> {
  const committed = await transformConfigWithPendingPluginInstalls({
    ...(opts.baseHash !== undefined ? { baseHash: opts.baseHash } : {}),
    // Caller-owned snapshots are one-shot CAS preconditions, not retry baselines.
    ...(opts.baseHash !== undefined || opts.baseSnapshot ? { maxAttempts: 1 } : {}),
    ...(opts.afterWrite ? { afterWrite: opts.afterWrite } : {}),
    writeOptions: {
      ...opts.writeOptions,
      ...(opts.allowConfigSizeDrop !== undefined
        ? { allowConfigSizeDrop: opts.allowConfigSizeDrop }
        : {}),
      ...(opts.baseSnapshot ? { baseSnapshot: opts.baseSnapshot } : {}),
    },
    transform: (current) => ({
      nextConfig: opts.mergeBase
        ? (applyMergePatch(current, createMergePatch(opts.mergeBase, config)) as OpenClawConfig)
        : config,
    }),
  });
  return committed.nextConfig;
}

export async function readSetupConfigFileSnapshot() {
  return await createConfigIO({ pluginValidation: "skip" }).readConfigFileSnapshot();
}

export async function readValidSetupConfigFile(): Promise<OpenClawConfig> {
  const snapshot = await readSetupConfigFileSnapshot();
  if (!snapshot.valid) {
    throw new Error("Migration target config became invalid. Run `openclaw doctor`.");
  }
  return snapshot.exists ? (snapshot.sourceConfig ?? snapshot.config) : {};
}

/** One-time security acknowledgement; persisted so reruns stay quiet. */
export async function requireRiskAcknowledgement(params: {
  opts: OnboardOptions;
  prompter: WizardPrompter;
  config: OpenClawConfig;
}): Promise<OpenClawConfig> {
  if (params.config.wizard?.securityAcknowledgedAt) {
    return params.config;
  }
  if (params.opts.acceptRisk === true) {
    return applySecurityAcknowledgement(params.config);
  }

  await params.prompter.note(getSecurityNoteMessage(), getSecurityNoteTitle());

  const ok = await params.prompter.confirm({
    message: getSecurityConfirmMessage(),
    initialValue: true,
    layout: "vertical",
  });
  if (!ok) {
    throw new WizardCancelledError(t("wizard.setup.riskNotAccepted"));
  }
  return applySecurityAcknowledgement(params.config);
}

function applySecurityAcknowledgement(config: OpenClawConfig): OpenClawConfig {
  if (config.wizard?.securityAcknowledgedAt) {
    return config;
  }
  return {
    ...config,
    wizard: {
      ...config.wizard,
      securityAcknowledgedAt: new Date().toISOString(),
    },
  };
}

/** Derive quickstart gateway defaults, preserving any existing gateway settings. */
export function resolveQuickstartGatewayDefaults(
  baseConfig: OpenClawConfig,
  overrides: QuickstartGatewayOptionOverrides = {},
): QuickstartGatewayDefaults {
  const hasExisting =
    typeof baseConfig.gateway?.port === "number" ||
    baseConfig.gateway?.bind !== undefined ||
    baseConfig.gateway?.auth?.mode !== undefined ||
    baseConfig.gateway?.auth?.token !== undefined ||
    baseConfig.gateway?.auth?.password !== undefined ||
    baseConfig.gateway?.customBindHost !== undefined ||
    baseConfig.gateway?.tailscale?.mode !== undefined;

  const bindRaw = baseConfig.gateway?.bind;
  const bind =
    bindRaw === "loopback" ||
    bindRaw === "lan" ||
    bindRaw === "auto" ||
    bindRaw === "custom" ||
    bindRaw === "tailnet"
      ? bindRaw
      : "loopback";

  let authMode: GatewayAuthChoice = "token";
  if (baseConfig.gateway?.auth?.mode === "token" || baseConfig.gateway?.auth?.mode === "password") {
    authMode = baseConfig.gateway.auth.mode;
  } else if (baseConfig.gateway?.auth?.token) {
    authMode = "token";
  } else if (baseConfig.gateway?.auth?.password) {
    authMode = "password";
  }

  const tailscaleRaw = baseConfig.gateway?.tailscale?.mode;
  const tailscaleMode =
    tailscaleRaw === "off" || tailscaleRaw === "serve" || tailscaleRaw === "funnel"
      ? tailscaleRaw
      : "off";

  const explicitAuthMode =
    overrides.gatewayAuth ??
    (overrides.gatewayToken !== undefined || overrides.gatewayTokenRefEnv !== undefined
      ? "token"
      : overrides.gatewayPassword !== undefined
        ? "password"
        : undefined);

  return {
    hasExisting,
    port: overrides.gatewayPort ?? resolveGatewayPort(baseConfig),
    bind: overrides.gatewayBind ?? bind,
    authMode: explicitAuthMode ?? authMode,
    tailscaleMode: overrides.tailscale ?? tailscaleMode,
    token:
      overrides.gatewayTokenRefEnv !== undefined
        ? {
            source: "env",
            provider: resolveDefaultSecretProviderAlias(baseConfig, "env", {
              preferFirstProviderForSource: true,
            }),
            id: overrides.gatewayTokenRefEnv.trim(),
          }
        : (overrides.gatewayToken ?? baseConfig.gateway?.auth?.token),
    password: overrides.gatewayPassword ?? baseConfig.gateway?.auth?.password,
    customBindHost: baseConfig.gateway?.customBindHost,
  };
}
