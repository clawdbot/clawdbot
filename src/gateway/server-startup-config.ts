// Gateway startup config loads, repairs, validates, and activates runtime config
// plus secrets snapshots before the server exposes user-facing surfaces.
import { isDeepStrictEqual } from "node:util";
import {
  formatInvalidConfigRecoveryHint,
  formatPluginPackagingRuntimeOutputRecoveryHint,
} from "../cli/config-recovery-hints.js";
import { createInvalidConfigError } from "../config/io.invalid-config.js";
import {
  type ReadConfigFileSnapshotWithPluginMetadataResult,
  readConfigFileSnapshotWithPluginMetadata,
} from "../config/io.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { isNixMode } from "../config/paths.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { isPluginPackagingRuntimeOutputInvalidConfigSnapshot } from "../config/recovery-policy.js";
import { applyConfigOverrides } from "../config/runtime-overrides.js";
import type { GatewayAuthConfig, GatewayTailscaleConfig } from "../config/types.gateway.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { measureDiagnosticsTimelineSpan } from "../infra/diagnostics-timeline.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { prepareSecretsRuntimeFastPathSnapshot } from "../secrets/runtime-fast-path.js";
import {
  GATEWAY_AUTH_SURFACE_PATHS,
  evaluateGatewayAuthSurfaceStates,
} from "../secrets/runtime-gateway-auth-surfaces.js";
import {
  activateSecretsRuntimeSnapshotState,
  graftActiveSecretsRuntimeAuthState,
  getActiveSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  hasCurrentAuthStoreCredentialsRevision,
} from "../secrets/runtime-state.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import { resolveGatewayAuth } from "./auth.js";
import { assertGatewayAuthNotKnownWeak } from "./known-weak-gateway-secrets.js";
import type { ChannelAutostartSuppression } from "./server-channels.js";
import {
  resolveGatewayStartupSecretProjection,
  resolveGatewayStartupSourceConfig,
} from "./server-startup-secret-surfaces.js";
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
  env?: NodeJS.ProcessEnv;
  includeAuthStoreRefs?: boolean;
};

/** Gateway startup hook that prepares secrets and optionally activates the prepared snapshot. */
export type ActivateRuntimeSecrets = ((
  config: OpenClawConfig,
  params: RuntimeSecretsActivationParams,
) => Promise<PreparedRuntimeSecretsSnapshot>) & {
  activatePreparedSnapshot?: (
    snapshot: PreparedRuntimeSecretsSnapshot,
    params: RuntimeSecretsActivationParams,
  ) => Promise<PreparedRuntimeSecretsSnapshot>;
  activatePreparedSnapshotIfCurrent?: (
    snapshot: PreparedRuntimeSecretsSnapshot,
    expectedRevision: number,
    params: RuntimeSecretsActivationParams,
    onActivated?: () => void | Promise<void>,
    canActivate?: () => boolean,
  ) => Promise<PreparedRuntimeSecretsSnapshot | null>;
};

type GatewayStartupConfigOverrides = {
  auth?: GatewayAuthConfig;
  tailscale?: GatewayTailscaleConfig;
};

type GatewayStartupConfigMeasure = <T>(
  name: string,
  run: () => T | Promise<T>,
  options?: { omitErrorMessage?: boolean },
) => Promise<T>;

/** Config snapshot plus optional plugin metadata loaded before Gateway startup auth. */
export type GatewayStartupConfigSnapshotLoadResult = {
  snapshot: ConfigFileSnapshot;
  wroteConfig: boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

/** Load and validate the config snapshot, applying runtime-only plugin auto-enable changes. */
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
    throw createInvalidConfigError(
      configSnapshot.path,
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
          discovery: pluginMetadataSnapshot?.discovery,
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

/** Create the serialized secrets activation function used by startup and reload paths. */
export function createRuntimeSecretsActivator(params: {
  logSecrets: GatewayStartupLog;
  emitStateEvent: (
    code: GatewaySecretsStateEventCode,
    message: string,
    cfg: OpenClawConfig,
  ) => void;
  prepareRuntimeSecretsSnapshot?: PrepareRuntimeSecretsSnapshot;
  activateRuntimeSecretsSnapshot?: ActivateRuntimeSecretsSnapshot;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins" | "manifestRegistry">;
  channelAutostartSuppression?: ChannelAutostartSuppression | null;
}): ActivateRuntimeSecrets {
  let secretsDegraded = false;
  let secretsActivationTail: Promise<void> = Promise.resolve();
  const loadSecretsRuntime = createLazyPromise(() => import("../secrets/runtime.js"), {
    cacheRejections: true,
  });
  const loadAuthProfiles = createLazyPromise(() => import("../agents/auth-profiles.js"), {
    cacheRejections: true,
  });
  const startupManifestRegistry =
    params.manifestRegistry ?? params.pluginMetadataSnapshot?.manifestRegistry;
  const runWithSecretsActivationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    // Secret refresh mutates process-wide active snapshot state, so activation
    // requests are serialized even when reload and startup probes overlap.
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
    options?: {
      activateRuntimeSecretsSnapshot?: (snapshot: PreparedRuntimeSecretsSnapshot) => void;
      onActivated?: () => void;
    },
  ) => {
    assertRuntimeGatewayAuthNotKnownWeak(prepared.config);
    if (activationParams.activate) {
      const activateRuntimeSecretsSnapshot =
        options?.activateRuntimeSecretsSnapshot ?? (await loadActivateRuntimeSecretsSnapshot());
      activateRuntimeSecretsSnapshot(prepared);
      // Invoke publication at the activation edge so no microtask can replace
      // the candidate before its runtime commit begins.
      options?.onActivated?.();
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
        const { sourceConfig, assignmentConfig } = resolveGatewayStartupSecretProjection({
          config,
          reason: activationParams.reason,
          channelAutostartSuppression: params.channelAutostartSuppression,
          ...(activationParams.env ? { env: activationParams.env } : {}),
        });
        const startupPreflight =
          activationParams.reason === "startup" || activationParams.reason === "restart-check";
        if (
          activationParams.reason === "startup" &&
          activationParams.activate &&
          !params.prepareRuntimeSecretsSnapshot &&
          !params.activateRuntimeSecretsSnapshot &&
          assignmentConfig === undefined
        ) {
          const fastPath = prepareSecretsRuntimeFastPathSnapshot({
            config: sourceConfig,
            ...(startupManifestRegistry ? { manifestRegistry: startupManifestRegistry } : {}),
          });
          if (fastPath) {
            // The startup fast path avoids importing the full secrets runtime
            // until refresh/preflight needs dynamic provider or auth-store work.
            return await finishPreparedSnapshot(fastPath.snapshot, activationParams, {
              activateRuntimeSecretsSnapshot: (snapshot) =>
                activateSecretsRuntimeSnapshotState({
                  snapshot,
                  refreshContext: fastPath.refreshContext,
                  refreshHandler: {
                    preflight: async (refreshParams) =>
                      await (
                        await loadSecretsRuntime()
                      ).preflightActiveSecretsRuntimeSnapshotRefresh(refreshParams),
                    refresh: async (refreshParams) =>
                      await (
                        await loadSecretsRuntime()
                      ).refreshActiveSecretsRuntimeSnapshotForConfig(refreshParams),
                  },
                }),
            });
          }
        }
        const loadAuthStore = startupPreflight
          ? (await loadAuthProfiles()).loadAuthProfileStoreWithoutExternalProfiles
          : undefined;
        const secretsRuntime =
          params.prepareRuntimeSecretsSnapshot && params.activateRuntimeSecretsSnapshot
            ? null
            : await loadSecretsRuntime();
        const prepareRuntimeSecretsSnapshot =
          params.prepareRuntimeSecretsSnapshot ?? secretsRuntime!.prepareSecretsRuntimeSnapshot;
        const allowUnavailableSecretOwners =
          activationParams.reason === "startup" && getActiveSecretsRuntimeSnapshot() === null;
        const prepared = await measureDiagnosticsTimelineSpan(
          "secrets.prepare",
          () =>
            prepareRuntimeSecretsSnapshot({
              config: sourceConfig,
              ...(assignmentConfig !== undefined ? { assignmentConfig } : {}),
              allowUnavailableSecretOwners,
              ...(activationParams.env ? { env: activationParams.env } : {}),
              includeAuthStoreRefs: activationParams.includeAuthStoreRefs,
              ...(startupManifestRegistry ? { manifestRegistry: startupManifestRegistry } : {}),
              ...(params.pluginMetadataSnapshot
                ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
                : {}),
              ...(loadAuthStore ? { loadAuthStore } : {}),
            }),
          {
            attributes: {
              activate: activationParams.activate,
              gatewayAuthSecretRef: hasActiveGatewayAuthSecretRef(config),
              reason: activationParams.reason,
            },
            config,
            env: activationParams.env ?? process.env,
            omitErrorMessage: true,
            phase: activationParams.reason,
          },
        );
        if (activationParams.includeAuthStoreRefs === false) {
          graftActiveSecretsRuntimeAuthState(prepared);
        }
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

  activateRuntimeSecrets.activatePreparedSnapshotIfCurrent = async (
    snapshot,
    expectedRevision,
    activationParams,
    onActivated,
    canActivate,
  ) => {
    // Resolve the lazy activator before entering the compare-and-activate
    // section so no await separates revision ownership from state publication.
    const activateRuntimeSecretsSnapshot = activationParams.activate
      ? await loadActivateRuntimeSecretsSnapshot()
      : undefined;
    return await runWithSecretsActivationLock(async () => {
      if (
        getActiveSecretsRuntimeSnapshotRevision() !== expectedRevision ||
        !hasCurrentAuthStoreCredentialsRevision(snapshot) ||
        (canActivate && !canActivate())
      ) {
        return null;
      }
      let activated: PreparedRuntimeSecretsSnapshot;
      let publication: Promise<void> | undefined;
      try {
        activated = await finishPreparedSnapshot(
          snapshot,
          activationParams,
          activateRuntimeSecretsSnapshot
            ? {
                activateRuntimeSecretsSnapshot,
                ...(onActivated
                  ? {
                      onActivated: () => {
                        publication = Promise.resolve(onActivated());
                      },
                    }
                  : {}),
              }
            : undefined,
        );
      } catch (err) {
        return handleSecretsActivationError(err, activationParams, snapshot.sourceConfig);
      }
      await publication;
      return activated;
    });
  };

  return activateRuntimeSecrets;
}

/** Throw a formatted startup error when the loaded config snapshot is invalid. */
function assertValidGatewayStartupConfigSnapshot(
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
  const recoveryHint =
    options.includeDoctorHint && isPluginPackagingRuntimeOutputInvalidConfigSnapshot(snapshot)
      ? `\n${formatPluginPackagingRuntimeOutputRecoveryHint()}`
      : options.includeDoctorHint
        ? `\n${formatInvalidConfigRecoveryHint()}`
        : "";
  throw createInvalidConfigError(snapshot.path, `${issues}${recoveryHint}`);
}

/** Prepare the effective Gateway startup config after auth, overrides, and secrets activation. */
export async function prepareGatewayStartupConfig(params: {
  configSnapshot: ConfigFileSnapshot;
  authOverride?: GatewayAuthConfig;
  tailscaleOverride?: GatewayTailscaleConfig;
  activateRuntimeSecrets: ActivateRuntimeSecrets;
  persistStartupAuth?: boolean;
  log?: GatewayStartupLog;
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
  const preflightConfig = await measure(
    "config.auth.secret-preflight",
    async () => {
      if (!needsAuthSecretPreflight) {
        return startupPreflightConfig;
      }
      preflightPrepared = await params.activateRuntimeSecrets(startupPreflightConfig, {
        reason: "startup",
        activate: false,
      });
      return preflightPrepared.config;
    },
    { omitErrorMessage: true },
  );
  const canReusePreflightPreparedSnapshot = (config: OpenClawConfig): boolean =>
    Boolean(
      preflightPrepared &&
      params.activateRuntimeSecrets.activatePreparedSnapshot &&
      isDeepStrictEqual(
        resolveGatewayStartupSourceConfig(config, process.env),
        preflightPrepared.sourceConfig,
      ),
    );
  const activateStartupSecrets = async (config: OpenClawConfig) => {
    // Reuse the preflight snapshot only if generated startup auth did not
    // change the secret-relevant source config.
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
      warn: params.log?.warn,
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
    await measure(
      "config.auth.secrets-activate",
      () => activateStartupSecrets(runtimeStartupConfig),
      { omitErrorMessage: true },
    )
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
