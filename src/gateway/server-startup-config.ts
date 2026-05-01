import { formatCliCommand } from "../cli/command-format.js";
import {
  readConfigFileSnapshotWithPluginMetadata,
  recoverConfigFromLastKnownGood,
  recoverConfigFromJsonRootSuffix,
} from "../config/io.js";
import { formatConfigIssueLines, formatConfigIssueSummary } from "../config/issue-format.js";
import { asResolvedSourceConfig, materializeRuntimeConfig } from "../config/materialize.js";
import { replaceConfigFile } from "../config/mutate.js";
import { isNixMode } from "../config/paths.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import {
  isPluginLocalInvalidConfigSnapshot,
  shouldAttemptLastKnownGoodRecovery,
} from "../config/recovery-policy.js";
import { applyConfigOverrides } from "../config/runtime-overrides.js";
import type { GatewayAuthConfig, GatewayTailscaleConfig } from "../config/types.gateway.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObjectWithPlugins } from "../config/validation.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  GATEWAY_AUTH_SURFACE_PATHS,
  evaluateGatewayAuthSurfaceStates,
} from "../secrets/runtime-gateway-auth-surfaces.js";
import {
  activateSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { resolveGatewayAuth } from "./auth.js";
import { enqueueConfigRecoveryNotice } from "./config-recovery-notice.js";
import { assertGatewayAuthNotKnownWeak } from "./known-weak-gateway-secrets.js";
import {
  ensureGatewayStartupAuth,
  mergeGatewayAuthConfig,
  mergeGatewayTailscaleConfig,
} from "./startup-auth.js";

type GatewayStartupLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error?: (message: string) => void;
};

type GatewaySecretsStateEventCode = "SECRETS_RELOADER_DEGRADED" | "SECRETS_RELOADER_RECOVERED";

export type ActivateRuntimeSecrets = (
  config: OpenClawConfig,
  params: { reason: "startup" | "reload" | "restart-check"; activate: boolean },
) => Promise<Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>>>;

type PrepareRuntimeSecretsSnapshot = typeof prepareSecretsRuntimeSnapshot;
type ActivateRuntimeSecretsSnapshot = typeof activateSecretsRuntimeSnapshot;

type GatewayStartupConfigOverrides = {
  auth?: GatewayAuthConfig;
  tailscale?: GatewayTailscaleConfig;
};

type GatewayStartupConfigMeasure = <T>(name: string, run: () => T | Promise<T>) => Promise<T>;

export type GatewayStartupConfigSnapshotLoadResult = {
  snapshot: ConfigFileSnapshot;
  wroteConfig: boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  degradedProviderApi?: boolean;
  degradedPluginConfig?: boolean;
};

const MODEL_PROVIDER_API_PATH_RE = /^models\.providers\.([^.]+)\.api$/;
const MODEL_PROVIDER_MODEL_API_PATH_RE = /^models\.providers\.([^.]+)\.models\.\d+\.api$/;

function resolveInvalidModelProviderApiIssueProviderId(issue: {
  path: string;
  message: string;
}): string | null {
  if (!issue.message.startsWith("Invalid option:")) {
    return null;
  }
  const providerMatch =
    issue.path.match(MODEL_PROVIDER_API_PATH_RE) ??
    issue.path.match(MODEL_PROVIDER_MODEL_API_PATH_RE);
  return providerMatch?.[1] ?? null;
}

function cloneConfigWithoutModelProviders(
  config: OpenClawConfig,
  providerIds: ReadonlySet<string>,
): OpenClawConfig {
  const providers = config.models?.providers;
  if (!providers) {
    return config;
  }
  let changed = false;
  const nextProviders = { ...providers };
  for (const providerId of providerIds) {
    if (!Object.hasOwn(nextProviders, providerId)) {
      continue;
    }
    delete nextProviders[providerId];
    changed = true;
  }
  if (!changed) {
    return config;
  }
  return {
    ...config,
    models: {
      ...config.models,
      providers: nextProviders,
    },
  };
}

function resolveGatewayStartupConfigWithoutInvalidModelProviders(params: {
  snapshot: ConfigFileSnapshot;
  log: GatewayStartupLog;
}): ConfigFileSnapshot | null {
  if (params.snapshot.valid || params.snapshot.legacyIssues.length > 0) {
    return null;
  }
  const providerIds = new Set<string>();
  for (const issue of params.snapshot.issues) {
    const providerId = resolveInvalidModelProviderApiIssueProviderId(issue);
    if (!providerId) {
      return null;
    }
    providerIds.add(providerId);
  }
  if (providerIds.size === 0) {
    return null;
  }

  const prunedSourceConfig = cloneConfigWithoutModelProviders(
    params.snapshot.sourceConfig,
    providerIds,
  );
  const validated = validateConfigObjectWithPlugins(prunedSourceConfig);
  if (!validated.ok) {
    return null;
  }
  const runtimeConfig = materializeRuntimeConfig(validated.config, "load");
  for (const providerId of providerIds) {
    params.log.warn(
      `gateway: skipped model provider ${providerId}; configured provider api is invalid. Run "openclaw doctor --fix" to repair the config.`,
    );
  }
  return {
    ...params.snapshot,
    sourceConfig: asResolvedSourceConfig(validated.config),
    resolved: asResolvedSourceConfig(validated.config),
    valid: true,
    runtimeConfig,
    config: runtimeConfig,
    issues: [],
    warnings: validated.warnings,
  };
}

function collectConfigSnapshotIssueDetails(snapshot: ConfigFileSnapshot) {
  return [...snapshot.issues, ...snapshot.legacyIssues];
}

function formatConfigRecoveryLogIssueSuffix(snapshot: ConfigFileSnapshot): string {
  const summary = formatConfigIssueSummary(collectConfigSnapshotIssueDetails(snapshot));
  return summary ? `; Rejected validation details: ${summary}.` : "";
}

function resolveGatewayStartupConfigWithoutInvalidPluginEntries(params: {
  snapshot: ConfigFileSnapshot;
  log: GatewayStartupLog;
}): ConfigFileSnapshot | null {
  if (!isPluginLocalInvalidConfigSnapshot(params.snapshot)) {
    return null;
  }
  const validated = validateConfigObjectWithPlugins(params.snapshot.sourceConfig, {
    pluginValidation: "skip",
  });
  if (!validated.ok) {
    return null;
  }
  const runtimeConfig = materializeRuntimeConfig(validated.config, "load");
  for (const issue of params.snapshot.issues) {
    params.log.warn(
      `gateway: skipped plugin config validation issue at ${issue.path}: ${issue.message}. Run "openclaw doctor --fix" to quarantine the plugin config.`,
    );
  }
  return {
    ...params.snapshot,
    sourceConfig: asResolvedSourceConfig(validated.config),
    resolved: asResolvedSourceConfig(validated.config),
    valid: true,
    runtimeConfig,
    config: runtimeConfig,
    issues: [],
    warnings: [...params.snapshot.warnings, ...params.snapshot.issues],
  };
}

export async function loadGatewayStartupConfigSnapshot(params: {
  minimalTestGateway: boolean;
  log: GatewayStartupLog;
  measure?: GatewayStartupConfigMeasure;
}): Promise<GatewayStartupConfigSnapshotLoadResult> {
  const measure = params.measure ?? (async (_name, run) => await run());
  let snapshotRead = await measure("config.snapshot.read", () =>
    readConfigFileSnapshotWithPluginMetadata({ measure }),
  );
  let configSnapshot = snapshotRead.snapshot;
  let pluginMetadataSnapshot = snapshotRead.pluginMetadataSnapshot;
  let wroteConfig = false;
  let degradedStartupConfig = false;
  let degradedPluginConfig = false;
  if (configSnapshot.legacyIssues.length > 0 && isNixMode) {
    throw new Error(
      "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.",
    );
  }
  if (configSnapshot.exists) {
    if (!configSnapshot.valid) {
      const providerApiPrunedSnapshot = resolveGatewayStartupConfigWithoutInvalidModelProviders({
        snapshot: configSnapshot,
        log: params.log,
      });
      if (providerApiPrunedSnapshot) {
        degradedStartupConfig = true;
        configSnapshot = providerApiPrunedSnapshot;
      }
    }
    if (!configSnapshot.valid) {
      const pluginConfigDegradedSnapshot = resolveGatewayStartupConfigWithoutInvalidPluginEntries({
        snapshot: configSnapshot,
        log: params.log,
      });
      if (pluginConfigDegradedSnapshot) {
        degradedPluginConfig = true;
        configSnapshot = pluginConfigDegradedSnapshot;
      }
    }
    if (!configSnapshot.valid) {
      const rejectedSnapshot = configSnapshot;
      const rejectedConfigIssues = collectConfigSnapshotIssueDetails(rejectedSnapshot);
      const canRecoverFromLastKnownGood = shouldAttemptLastKnownGoodRecovery(configSnapshot);
      const recovered = canRecoverFromLastKnownGood
        ? await recoverConfigFromLastKnownGood({
            snapshot: configSnapshot,
            reason: "startup-invalid-config",
          })
        : false;
      if (!canRecoverFromLastKnownGood) {
        params.log.warn(
          `gateway: last-known-good recovery skipped for plugin-local config invalidity: ${configSnapshot.path}`,
        );
      }
      if (recovered) {
        wroteConfig = true;
        params.log.warn(
          `gateway: invalid config was restored from last-known-good backup: ${rejectedSnapshot.path}${formatConfigRecoveryLogIssueSuffix(rejectedSnapshot)}`,
        );
        snapshotRead = await measure("config.snapshot.recovery-read", () =>
          readConfigFileSnapshotWithPluginMetadata({ measure }),
        );
        configSnapshot = snapshotRead.snapshot;
        pluginMetadataSnapshot = snapshotRead.pluginMetadataSnapshot;
        if (configSnapshot.valid) {
          enqueueConfigRecoveryNotice({
            cfg: configSnapshot.config,
            phase: "startup",
            reason: "startup-invalid-config",
            configPath: configSnapshot.path,
            issues: rejectedConfigIssues,
          });
        }
      }
      if (!recovered && (await recoverConfigFromJsonRootSuffix(configSnapshot))) {
        wroteConfig = true;
        params.log.warn(
          `gateway: invalid config was repaired by stripping a non-JSON prefix: ${configSnapshot.path}`,
        );
        snapshotRead = await measure("config.snapshot.prefix-recovery-read", () =>
          readConfigFileSnapshotWithPluginMetadata({ measure }),
        );
        configSnapshot = snapshotRead.snapshot;
        pluginMetadataSnapshot = snapshotRead.pluginMetadataSnapshot;
      }
    }
    assertValidGatewayStartupConfigSnapshot(configSnapshot, { includeDoctorHint: true });
  }

  const autoEnable =
    params.minimalTestGateway || degradedStartupConfig || degradedPluginConfig
      ? { config: configSnapshot.config, changes: [] as string[] }
      : await measure("config.snapshot.auto-enable", () =>
          applyPluginAutoEnable({
            config: configSnapshot.sourceConfig,
            env: process.env,
            ...(pluginMetadataSnapshot?.manifestRegistry
              ? { manifestRegistry: pluginMetadataSnapshot.manifestRegistry }
              : {}),
          }),
        );
  if (autoEnable.changes.length === 0) {
    return {
      snapshot: configSnapshot,
      wroteConfig,
      ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
      ...(degradedStartupConfig ? { degradedProviderApi: true } : {}),
      ...(degradedPluginConfig ? { degradedPluginConfig: true } : {}),
    };
  }

  try {
    await replaceConfigFile({
      nextConfig: autoEnable.config,
      afterWrite: { mode: "auto" },
    });
    wroteConfig = true;
    snapshotRead = await measure("config.snapshot.auto-enable-read", () =>
      readConfigFileSnapshotWithPluginMetadata({ measure }),
    );
    configSnapshot = snapshotRead.snapshot;
    pluginMetadataSnapshot = snapshotRead.pluginMetadataSnapshot;
    assertValidGatewayStartupConfigSnapshot(configSnapshot);
    params.log.info(
      `gateway: auto-enabled plugins:\n${autoEnable.changes.map((entry) => `- ${entry}`).join("\n")}`,
    );
  } catch (err) {
    params.log.warn(`gateway: failed to persist plugin auto-enable changes: ${String(err)}`);
  }

  return {
    snapshot: configSnapshot,
    wroteConfig,
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
    ...(degradedStartupConfig ? { degradedProviderApi: true } : {}),
    ...(degradedPluginConfig ? { degradedPluginConfig: true } : {}),
  };
}

export function createRuntimeSecretsActivator(params: {
  logSecrets: GatewayStartupLog;
  emitStateEvent: (
    code: GatewaySecretsStateEventCode,
    message: string,
    cfg: OpenClawConfig,
  ) => void;
  prepareRuntimeSecretsSnapshot?: PrepareRuntimeSecretsSnapshot;
  activateRuntimeSecretsSnapshot?: ActivateRuntimeSecretsSnapshot;
}): ActivateRuntimeSecrets {
  let secretsDegraded = false;
  let secretsActivationTail: Promise<void> = Promise.resolve();
  const prepareRuntimeSecretsSnapshot =
    params.prepareRuntimeSecretsSnapshot ?? prepareSecretsRuntimeSnapshot;
  const activateRuntimeSecretsSnapshot =
    params.activateRuntimeSecretsSnapshot ?? activateSecretsRuntimeSnapshot;

  const runWithSecretsActivationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = secretsActivationTail.then(operation, operation);
    secretsActivationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  };

  return async (config, activationParams) =>
    await runWithSecretsActivationLock(async () => {
      try {
        const prepared = await prepareRuntimeSecretsSnapshot({
          config: pruneSkippedStartupSecretSurfaces(config),
        });
        assertRuntimeGatewayAuthNotKnownWeak(prepared.config);
        if (activationParams.activate) {
          activateRuntimeSecretsSnapshot(prepared);
          logGatewayAuthSurfaceDiagnostics(prepared, params.logSecrets);
        }
        for (const warning of prepared.warnings) {
          params.logSecrets.warn(`[${warning.code}] ${warning.message}`);
        }
        if (secretsDegraded) {
          const recoveredMessage =
            "Secret resolution recovered; runtime remained on last-known-good during the outage.";
          params.logSecrets.info(`[SECRETS_RELOADER_RECOVERED] ${recoveredMessage}`);
          params.emitStateEvent("SECRETS_RELOADER_RECOVERED", recoveredMessage, prepared.config);
        }
        secretsDegraded = false;
        return prepared;
      } catch (err) {
        const details = String(err);
        if (!secretsDegraded) {
          params.logSecrets.error?.(`[SECRETS_RELOADER_DEGRADED] ${details}`);
          if (activationParams.reason !== "startup") {
            params.emitStateEvent(
              "SECRETS_RELOADER_DEGRADED",
              `Secret resolution failed; runtime remains on last-known-good snapshot. ${details}`,
              config,
            );
          }
        } else {
          params.logSecrets.warn(`[SECRETS_RELOADER_DEGRADED] ${details}`);
        }
        secretsDegraded = true;
        if (activationParams.reason === "startup") {
          throw new Error(`Startup failed: required secrets are unavailable. ${details}`, {
            cause: err,
          });
        }
        throw err;
      }
    });
}

export function assertValidGatewayStartupConfigSnapshot(
  snapshot: ConfigFileSnapshot,
  options: { includeDoctorHint?: boolean } = {},
): void {
  if (snapshot.valid) {
    return;
  }
  const issues =
    snapshot.issues.length > 0
      ? formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }).join("\n")
      : "Unknown validation issue.";
  const doctorHint = options.includeDoctorHint
    ? `\nRun "${formatCliCommand("openclaw doctor --fix")}" to repair, then retry.`
    : "";
  throw new Error(`Invalid config at ${snapshot.path}.\n${issues}${doctorHint}`);
}

export async function prepareGatewayStartupConfig(params: {
  configSnapshot: ConfigFileSnapshot;
  authOverride?: GatewayAuthConfig;
  tailscaleOverride?: GatewayTailscaleConfig;
  activateRuntimeSecrets: ActivateRuntimeSecrets;
  persistStartupAuth?: boolean;
}): Promise<Awaited<ReturnType<typeof ensureGatewayStartupAuth>>> {
  assertValidGatewayStartupConfigSnapshot(params.configSnapshot);

  const runtimeConfig = applyConfigOverrides(params.configSnapshot.config);
  const startupPreflightConfig = applyGatewayAuthOverridesForStartupPreflight(runtimeConfig, {
    auth: params.authOverride,
    tailscale: params.tailscaleOverride,
  });
  const needsAuthSecretPreflight = hasActiveGatewayAuthSecretRef(startupPreflightConfig);
  const preflightConfig = needsAuthSecretPreflight
    ? (
        await params.activateRuntimeSecrets(startupPreflightConfig, {
          reason: "startup",
          activate: false,
        })
      ).config
    : startupPreflightConfig;
  const preflightAuthOverride =
    typeof preflightConfig.gateway?.auth?.token === "string" ||
    typeof preflightConfig.gateway?.auth?.password === "string"
      ? {
          ...params.authOverride,
          ...(typeof preflightConfig.gateway?.auth?.token === "string"
            ? { token: preflightConfig.gateway.auth.token }
            : {}),
          ...(typeof preflightConfig.gateway?.auth?.password === "string"
            ? { password: preflightConfig.gateway.auth.password }
            : {}),
        }
      : params.authOverride;

  const authBootstrap = await ensureGatewayStartupAuth({
    cfg: runtimeConfig,
    env: process.env,
    authOverride: preflightAuthOverride,
    tailscaleOverride: params.tailscaleOverride,
    persist: params.persistStartupAuth ?? true,
    baseHash: params.configSnapshot.hash,
  });
  const runtimeStartupConfig = applyGatewayAuthOverridesForStartupPreflight(authBootstrap.cfg, {
    auth: params.authOverride,
    tailscale: params.tailscaleOverride,
  });
  const activatedConfig = (
    await params.activateRuntimeSecrets(runtimeStartupConfig, {
      reason: "startup",
      activate: true,
    })
  ).config;
  return {
    ...authBootstrap,
    cfg: activatedConfig,
  };
}

function hasActiveGatewayAuthSecretRef(config: OpenClawConfig): boolean {
  const states = evaluateGatewayAuthSurfaceStates({
    config,
    defaults: config.secrets?.defaults,
    env: process.env,
  });
  return GATEWAY_AUTH_SURFACE_PATHS.some((path) => {
    const state = states[path];
    return state.hasSecretRef && state.active;
  });
}

function pruneSkippedStartupSecretSurfaces(config: OpenClawConfig): OpenClawConfig {
  const skipChannels =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
  if (!skipChannels || !config.channels) {
    return config;
  }
  return {
    ...config,
    channels: undefined,
  };
}

function assertRuntimeGatewayAuthNotKnownWeak(config: OpenClawConfig): void {
  assertGatewayAuthNotKnownWeak(
    resolveGatewayAuth({
      authConfig: config.gateway?.auth,
      env: process.env,
      tailscaleMode: config.gateway?.tailscale?.mode ?? "off",
    }),
  );
}

function logGatewayAuthSurfaceDiagnostics(
  prepared: {
    sourceConfig: OpenClawConfig;
    warnings: Array<{ code: string; path: string; message: string }>;
  },
  logSecrets: GatewayStartupLog,
): void {
  const states = evaluateGatewayAuthSurfaceStates({
    config: prepared.sourceConfig,
    defaults: prepared.sourceConfig.secrets?.defaults,
    env: process.env,
  });
  const inactiveWarnings = new Map<string, string>();
  for (const warning of prepared.warnings) {
    if (warning.code !== "SECRETS_REF_IGNORED_INACTIVE_SURFACE") {
      continue;
    }
    inactiveWarnings.set(warning.path, warning.message);
  }
  for (const path of GATEWAY_AUTH_SURFACE_PATHS) {
    const state = states[path];
    if (!state.hasSecretRef) {
      continue;
    }
    const stateLabel = state.active ? "active" : "inactive";
    const inactiveDetails =
      !state.active && inactiveWarnings.get(path) ? inactiveWarnings.get(path) : undefined;
    const details = inactiveDetails ?? state.reason;
    logSecrets.info(`[SECRETS_GATEWAY_AUTH_SURFACE] ${path} is ${stateLabel}. ${details}`);
  }
}

function applyGatewayAuthOverridesForStartupPreflight(
  config: OpenClawConfig,
  overrides: GatewayStartupConfigOverrides,
): OpenClawConfig {
  if (!overrides.auth && !overrides.tailscale) {
    return config;
  }
  return {
    ...config,
    gateway: {
      ...config.gateway,
      auth: mergeGatewayAuthConfig(config.gateway?.auth, overrides.auth),
      tailscale: mergeGatewayTailscaleConfig(config.gateway?.tailscale, overrides.tailscale),
    },
  };
}
