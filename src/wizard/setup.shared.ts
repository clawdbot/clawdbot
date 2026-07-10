// Shared setup-wizard steps used by the classic wizard and the bootstrap onboarding flow.
import { isDeepStrictEqual } from "node:util";
import type { GatewayAuthChoice, OnboardOptions } from "../commands/onboard-types.js";
import { createConfigIO, replaceConfigFile, resolveGatewayPort } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  commitConfigWriteWithPendingPluginInstalls,
  hasPendingPluginInstallRecords,
  stripPendingPluginInstallRecords,
  unchangedPendingPluginInstallRecordIds,
} from "../plugins/install-record-commit.js";
import { isPlainObject } from "../utils.js";
import { t } from "./i18n/index.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";
import {
  getSecurityConfirmMessage,
  getSecurityNoteMessage,
  getSecurityNoteTitle,
} from "./setup.security-note.js";
import type { QuickstartGatewayDefaults } from "./setup.types.js";

function mergeWizardConfigValueOntoLatest(current: unknown, base: unknown, next: unknown): unknown {
  if (isDeepStrictEqual(next, base)) {
    return current;
  }
  if (isPlainObject(current) && isPlainObject(base) && isPlainObject(next)) {
    const merged: Record<string, unknown> = { ...current };
    const keys = new Set([...Object.keys(current), ...Object.keys(base), ...Object.keys(next)]);
    for (const key of keys) {
      const mergedValue = mergeWizardConfigValueOntoLatest(current[key], base[key], next[key]);
      if (mergedValue === undefined) {
        delete merged[key];
      } else {
        merged[key] = mergedValue;
      }
    }
    return merged;
  }
  return structuredClone(next);
}

/** Preserve concurrent edits while applying only changes made by an interactive wizard. */
export function mergeWizardConfigOntoLatest(
  current: OpenClawConfig,
  base: OpenClawConfig,
  next: OpenClawConfig,
): OpenClawConfig {
  return mergeWizardConfigValueOntoLatest(current, base, next) as OpenClawConfig;
}

/**
 * Config writes go through the pending-plugin-install commit helper so wizard
 * flows never drop install records that a concurrent migration already staged.
 */
export async function writeWizardConfigFile(
  configInput: OpenClawConfig,
  opts: {
    allowConfigSizeDrop?: boolean;
    migrationBaseConfig?: OpenClawConfig;
    onPendingPluginInstallMigration?: () => void;
  } = {},
): Promise<OpenClawConfig> {
  let config = configInput;
  const allowConfigSizeDrop = opts.allowConfigSizeDrop === true;
  if (!allowConfigSizeDrop && hasPendingPluginInstallRecords(config)) {
    // Explicit undefined means this writer already migrated its baseline; an omitted
    // key cannot distinguish fresh pending records from stale authored metadata.
    if (!Object.hasOwn(opts, "migrationBaseConfig")) {
      throw new Error(
        "Wizard config writes with pending plugin installs must declare migration ownership.",
      );
    }
    const migrationBaseConfig = opts.migrationBaseConfig;
    if (migrationBaseConfig && hasPendingPluginInstallRecords(migrationBaseConfig)) {
      await commitConfigWriteWithPendingPluginInstalls({
        nextConfig: migrationBaseConfig,
        sourceConfig: migrationBaseConfig,
        writeOptions: { allowConfigSizeDrop: true },
        commit: async (nextConfig, writeOptions) => {
          return await replaceConfigFile({
            nextConfig,
            ...(writeOptions ? { writeOptions } : {}),
            afterWrite: { mode: "auto" },
          });
        },
      });
      config = stripPendingPluginInstallRecords(
        config,
        unchangedPendingPluginInstallRecordIds(config, migrationBaseConfig),
      );
      opts.onPendingPluginInstallMigration?.();
    }
  }
  const committed = await commitConfigWriteWithPendingPluginInstalls({
    nextConfig: config,
    writeOptions: { allowConfigSizeDrop },
    commit: async (nextConfig, writeOptions) => {
      return await replaceConfigFile({
        nextConfig,
        ...(writeOptions ? { writeOptions } : {}),
        afterWrite: { mode: "auto" },
      });
    },
  });
  return committed.config;
}

export async function readSetupConfigFileSnapshot() {
  return await createConfigIO({ pluginValidation: "skip" }).readConfigFileSnapshot();
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

  return {
    hasExisting,
    port: resolveGatewayPort(baseConfig),
    bind,
    authMode,
    tailscaleMode,
    token: baseConfig.gateway?.auth?.token,
    password: baseConfig.gateway?.auth?.password,
    customBindHost: baseConfig.gateway?.customBindHost,
    tailscaleResetOnExit: baseConfig.gateway?.tailscale?.resetOnExit ?? false,
  };
}
