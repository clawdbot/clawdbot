import { isDeepStrictEqual } from "node:util";
import { formatInvalidConfigRecoveryHint } from "../cli/config-recovery-hints.js";
import {
  type ReadConfigFileSnapshotWithPluginMetadataResult,
  readConfigFileSnapshotWithPluginMetadata,
} from "../config/io.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { isNixMode } from "../config/paths.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { applyConfigOverrides } from "../config/runtime-overrides.js";
import type { GatewayAuthConfig, GatewayTailscaleConfig } from "../config/types.gateway.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  GATEWAY_AUTH_SURFACE_PATHS,
  evaluateGatewayAuthSurfaceStates,
} from "../secrets/runtime-gateway-auth-surfaces.js";
import { resolveGatewayAuth } from "./auth.js";
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

type PrepareRuntimeSecretsSnapshot =
  typeof import("../secrets/runtime.js").prepareSecretsRuntimeSnapshot;
type ActivateRuntimeSecretsSnapshot =
  typeof import("../secrets/runtime.js").activateSecretsRuntimeSnapshot;
type PreparedRuntimeSecretsSnapshot = Awaited<ReturnType<PrepareRuntimeSecretsSnapshot>>;

type RuntimeSecretsActivationParams = {
  reason: "startup" | "reload" | "restart-check";
  activate: boolean;
};

export type ActivateRuntimeSecrets = ((
  config: OpenClawConfig,
  params: RuntimeSecretsActivationParams,
) => Promise<PreparedRuntimeSecretsSnapshot>) & {
  activatePreparedSnapshot?: (
    snapshot: PreparedRuntimeSecretsSnapshot,
    params: RuntimeSecretsActivationParams,
  ) => Promise<PreparedRuntimeSecretsSnapshot>;
};

type GatewayStartupConfigOverrides = {
  auth?: GatewayAuthConfig;
  tailscale?: GatewayTailscaleConfig;
};

type GatewayStartupConfigMeasure = <T>(name: string, run: () => T | Promise<T>) => Promise<T>;

export type GatewayStartupConfigSnapshotLoadResult = {
  snapshot: ConfigFileSnapshot;
  wroteConfig: boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

export async function loadGatewayStartupConfigSnapshot(params: {
  minimalTestGateway: boolean;
  log: GatewayStartupLog;
  measure?: GatewayStartupConfigMeasure;
  initialSnapshotRead?: ReadConfigFileSnapshotWithPluginMetadataResult;
}): Promise<GatewayStartupConfigSnapshotLoadResult> {
  const measure = params.measure ?? (async (_name, run) => await run());
  const snapshotRead =
    params.initialSnapshotRead ??
    (await measure("config.snapshot.read", () =>
      readConfigFileSnapshotWithPluginMetadata({ measure }),
    ));
  const configSnapshot = snapshotRead.snapshot;
  const pluginMetadataSnapshot = snapshotRead.pluginMetadataSnapshot;
  const wroteConfig = false;
  if (configSnapshot.legacyIssues.length > 0 && isNixMode) {
    throw new Error(
      "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.",
    );
  }
  if (configSnapshot.exists) {
    assertValidGatewayStartupConfigSnapshot(configSnapshot, { includeDoctorHint: true });
  }

  const autoEnable = params.minimalTestGateway
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
    };
  }

  params.log.info(
    `gateway: auto-enabled plugins for this runtime without writing config:\n${autoEnable.changes.map((entry) => `- ${entry}`).join("\n")}`,
  );
  return {
    snapshot: withRuntimeConfig(configSnapshot, autoEnable.config),
    wroteConfig,
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
  };
}

function withRuntimeConfig(
  snapshot: ConfigFileSnapshot,
  runtimeConfig: OpenClawConfig,
): ConfigFileSnapshot {
  return {
    ...snapshot,
    runtimeConfig,
    config: runtimeConfig,
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
  let secretsRuntimePromise: Promise<typeof import("../secrets/runtime.js")> | null = null;
  let authProfilesPromise: Promise<typeof import("../agents/auth-profiles.js")> | null = null;
  const loadSecretsRuntime = () => {
    secretsRuntimePromise ??= import("../secrets/runtime.js");
    return secretsRuntimePromise;
  };
  const loadAuthProfiles = () => {
    authProfilesPromise ??= import("../agents/auth-profiles.js");
    return authProfilesPromise;
  };

  const runWithSecretsActivationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = secretsActivationTail.then(operation, operation);
    secretsActivationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  };

  const loadActivateRuntimeSecretsSnapshot = async () => {
    if (params.activateRuntimeSecretsSnapshot) {
      return params.activateRuntimeSecretsSnapshot;
    }
    return (await loadSecretsRuntime()).activateSecretsRuntimeSnapshot;
  };

  const finishPreparedSnapshot = async (
    prepared: PreparedRuntimeSecretsSnapshot,
    activationParams: RuntimeSecretsActivationParams,
  ) => {
    assertRuntimeGatewayAuthNotKnownWeak(prepared.config);
    if (activationParams.activate) {
      const activateRuntimeSecretsSnapshot = await loadActivateRuntimeSecretsSnapshot();
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
  };

  const handleSecretsActivationError = (
    err: unknown,
    activationParams: RuntimeSecretsActivationParams,
    eventConfig: OpenClawConfig,
  ): never => {
    const details = String(err);
    if (!secretsDegraded) {
      params.logSecrets.error?.(`[SECRETS_RELOADER_DEGRADED] ${details}`);
      if (activationParams.reason !== "startup") {
        params.emitStateEvent(
          "SECRETS_RELOADER_DEGRADED",
          `Secret resolution failed; runtime remains on last-known-good snapshot. ${details}`,
          eventConfig,
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
  };

  const activateRuntimeSecrets = (async (config, activationParams) =>
    await runWithSecretsActivationLock(async () => {
      try {
        const secretsRuntime =
          params.prepareRuntimeSecretsSnapshot && params.activateRuntimeSecretsSnapshot
            ? null
            : await loadSecretsRuntime();
        const prepareRuntimeSecretsSnapshot =
          params.prepareRuntimeSecretsSnapshot ?? secretsRuntime!.prepareSecretsRuntimeSnapshot;
        const startupPreflight =
          activationParams.reason === "startup" || activationParams.reason === "restart-check";
        const loadAuthStore = startupPreflight
          ? (await loadAuthProfiles()).loadAuthProfileStoreWithoutExternalProfiles
          : undefined;
        const prepared = await prepareRuntimeSecretsSnapshot({
          config: pruneSkippedStartupSecretSurfaces(config),
          ...(loadAuthStore ? { loadAuthStore } : {}),
        });
        return await finishPreparedSnapshot(prepared, activationParams);
      } catch (err) {
        return handleSecretsActivationError(err, activationParams, config);
      }
    })) as ActivateRuntimeSecrets;

  activateRuntimeSecrets.activatePreparedSnapshot = async (snapshot, activationParams) =>
    await runWithSecretsActivationLock(async () => {
      try {
        return await finishPreparedSnapshot(snapshot, activationParams);
      } catch (err) {
        return handleSecretsActivationError(err, activationParams, snapshot.sourceConfig);
      }
    });

  return activateRuntimeSecrets;
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
  const doctorHint = options.includeDoctorHint ? `\n${formatInvalidConfigRecoveryHint()}` : "";
  throw new Error(`Invalid config at ${snapshot.path}.\n${issues}${doctorHint}`);
}

export async function prepareGatewayStartupConfig(params: {
  configSnapshot: ConfigFileSnapshot;
  authOverride?: GatewayAuthConfig;
  tailscaleOverride?: GatewayTailscaleConfig;
  activateRuntimeSecrets: ActivateRuntimeSecrets;
  persistStartupAuth?: boolean;
  measure?: GatewayStartupConfigMeasure;
}): Promise<Awaited<ReturnType<typeof ensureGatewayStartupAuth>>> {
  const measure = params.measure ?? (async (_name, run) => await run());
  await measure("config.auth.snapshot-validate", () =>
    assertValidGatewayStartupConfigSnapshot(params.configSnapshot),
  );

  const runtimeConfig = await measure("config.auth.runtime-overrides", () =>
    applyConfigOverrides(params.configSnapshot.config),
  );
  const startupPreflightConfig = await measure("config.auth.startup-overrides", () =>
    applyGatewayAuthOverridesForStartupPreflight(runtimeConfig, {
      auth: params.authOverride,
      tailscale: params.tailscaleOverride,
    }),
  );
  const needsAuthSecretPreflight = await measure("config.auth.secret-surface", () =>
    hasActiveGatewayAuthSecretRef(startupPreflightConfig),
  );
  let preflightPrepared: PreparedRuntimeSecretsSnapshot | undefined;
  const preflightConfig = await measure("config.auth.secret-preflight", async () => {
    if (!needsAuthSecretPreflight) {
      return startupPreflightConfig;
    }
    preflightPrepared = await params.activateRuntimeSecrets(startupPreflightConfig, {
      reason: "startup",
      activate: false,
    });
    return preflightPrepared.config;
  });
  const canReusePreflightPreparedSnapshot = (config: OpenClawConfig): boolean =>
    Boolean(
      preflightPrepared &&
        params.activateRuntimeSecrets.activatePreparedSnapshot &&
        isDeepStrictEqual(
          pruneSkippedStartupSecretSurfaces(config),
          preflightPrepared.sourceConfig,
        ),
    );
  const activateStartupSecrets = async (config: OpenClawConfig) => {
    if (preflightPrepared && canReusePreflightPreparedSnapshot(config)) {
      return await params.activateRuntimeSecrets.activatePreparedSnapshot!(preflightPrepared, {
        reason: "startup",
        activate: true,
      });
    }
    return await params.activateRuntimeSecrets(config, {
      reason: "startup",
      activate: true,
    });
  };
  const preflightAuthOverride = await measure("config.auth.preflight-override", () =>
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
      : params.authOverride,
  );

  const authBootstrap = await measure("config.auth.ensure", () =>
    ensureGatewayStartupAuth({
      cfg: runtimeConfig,
      env: process.env,
      authOverride: preflightAuthOverride,
      tailscaleOverride: params.tailscaleOverride,
      persist: params.persistStartupAuth ?? false,
      baseHash: params.configSnapshot.hash,
    }),
  );
  const runtimeStartupConfig = await measure("config.auth.runtime-startup-overrides", () =>
    applyGatewayAuthOverridesForStartupPreflight(authBootstrap.cfg, {
      auth: params.authOverride,
      tailscale: params.tailscaleOverride,
    }),
  );
  const activatedConfig = (
    await measure("config.auth.secrets-activate", () => activateStartupSecrets(runtimeStartupConfig))
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
