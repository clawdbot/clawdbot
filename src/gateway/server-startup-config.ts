// Gateway startup config loads, repairs, validates, and activates runtime config
// plus secrets snapshots before the server exposes user-facing surfaces.
import { isDeepStrictEqual } from "node:util";
import { applyConfigOverrides } from "../config/runtime-overrides.js";
import type { GatewayAuthConfig, GatewayTailscaleConfig } from "../config/types.gateway.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { measureDiagnosticsTimelineSpan } from "../infra/diagnostics-timeline.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  classifySecretResolutionErrorDegradations,
  isRetryableSecretDegradationReason,
  listSecretResolutionErrorOwners,
} from "../secrets/runtime-degraded-state.js";
import { prepareSecretsRuntimeFastPathSnapshot } from "../secrets/runtime-fast-path.js";
import { registerProviderAuthRuntimeSnapshotActivationOwner } from "../secrets/runtime-provider-auth-activation.js";
import {
  listProviderAuthDegradedOwners,
  preparedDegradationSupportsSourceOnlyRecovery,
  resolvePreparedSecretsStateScope,
  type SecretsStateScope,
} from "../secrets/runtime-provider-auth-scope.js";
import {
  activateSecretsRuntimeSnapshotState,
  graftActiveSecretsRuntimeAuthState,
  getActiveSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  hasActiveSecretsRuntimeSnapshotLineage,
  hasSameSecretReloadContract,
  hasCurrentAuthStoreCredentialsRevision,
} from "../secrets/runtime-state.js";
import { logRuntimeSecretWarnings } from "../secrets/runtime-warning-log.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import type { ChannelAutostartSuppression } from "./server-channels.js";
import {
  applyGatewayAuthOverridesForStartupPreflight,
  assertRuntimeGatewayAuthNotKnownWeak,
  assertValidGatewayStartupConfigSnapshot,
  hasActiveGatewayAuthSecretRef,
  logGatewayAuthSurfaceDiagnostics,
  type GatewayStartupConfigMeasure,
  type GatewayStartupLog,
} from "./server-startup-config-helpers.js";
import {
  logPreparedSecretDegradations,
  logThrownSecretDegradations,
} from "./server-startup-secret-diagnostics.js";
export {
  loadGatewayStartupConfigSnapshot,
  type GatewayStartupConfigSnapshotLoadResult,
} from "./server-startup-config-helpers.js";
import {
  resolveGatewayStartupSecretProjection,
  resolveGatewayStartupSourceConfig,
} from "./server-startup-secret-surfaces.js";
import { ensureGatewayStartupAuth } from "./startup-auth.js";

type GatewaySecretsStateEventCode = "SECRETS_RELOADER_DEGRADED" | "SECRETS_RELOADER_RECOVERED";

type PrepareRuntimeSecretsSnapshot =
  typeof import("../secrets/runtime.js").prepareSecretsRuntimeSnapshot;
type ActivateRuntimeSecretsSnapshot =
  typeof import("../secrets/runtime.js").activateSecretsRuntimeSnapshot;
type PreparedRuntimeSecretsSnapshot = Awaited<ReturnType<PrepareRuntimeSecretsSnapshot>>;

type RuntimeSecretsActivationParams = {
  reason: "startup" | "reload" | "restart-check";
  activate: boolean;
  /** This preparation belongs to a live reload; publish failure against the active snapshot. */
  publishFailureAsDegraded?: boolean;
  /** Reject warning publication after a speculative reload loses transaction ownership. */
  canPublishFailureAsDegraded?: () => boolean;
  env?: NodeJS.ProcessEnv;
  includeAuthStoreRefs?: boolean;
  /** Raw config source paired with an otherwise fully activated prepared snapshot. */
  runtimeSourceConfig?: OpenClawConfig;
  /** Defer degradation/recovery publication until a larger transaction can no longer roll back. */
  deferStatePublication?: boolean;
};

type DeferredSecretsStateTransition = {
  activationRevision: number;
  reason: RuntimeSecretsActivationParams["reason"];
  activationScope: SecretsStateScope;
} & ({ kind: "degraded" } | { kind: "recovered"; degradationGeneration: number });

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

const runtimeSecretsStatePublishers = new WeakMap<
  ActivateRuntimeSecrets,
  (
    snapshot: PreparedRuntimeSecretsSnapshot,
    options?: { sourceOnly?: boolean; expectedRevision?: number },
  ) => void
>();

/** Publishes a deferred degradation or recovery after the prepared snapshot wins its commit CAS. */
export function publishRuntimeSecretsStateTransition(
  activateRuntimeSecrets: ActivateRuntimeSecrets,
  snapshot: PreparedRuntimeSecretsSnapshot,
  options?: { sourceOnly?: boolean; expectedRevision?: number },
): void {
  runtimeSecretsStatePublishers.get(activateRuntimeSecrets)?.(snapshot, options);
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
  let degradationGeneration = 0;
  let activeDegradationGeneration: number | null = null;
  let activeDegradationConfig: OpenClawConfig | null = null;
  let activeDegradationSupportsSourceOnlyRecovery = false;
  let activeDegradationScope: SecretsStateScope | null = null;
  const deferredStateTransitions = new WeakMap<object, DeferredSecretsStateTransition>();
  let pendingDeferredLineageRevision: number | null = null;
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

  const publishRecovery = (
    config: OpenClawConfig,
    expectedGeneration?: number,
    scope: SecretsStateScope = "full",
  ) => {
    if (
      !secretsDegraded ||
      (expectedGeneration !== undefined && activeDegradationGeneration !== expectedGeneration) ||
      (scope === "provider-auth" && activeDegradationScope !== "provider-auth")
    ) {
      return;
    }
    const recoveredMessage =
      "Secret resolution recovered; runtime remained on last-known-good during the outage.";
    params.logSecrets.info(`[SECRETS_RELOADER_RECOVERED] ${recoveredMessage}`);
    params.emitStateEvent("SECRETS_RELOADER_RECOVERED", recoveredMessage, config);
    secretsDegraded = false;
    activeDegradationGeneration = null;
    activeDegradationConfig = null;
    activeDegradationSupportsSourceOnlyRecovery = false;
    activeDegradationScope = null;
  };

  const publishDegradation = (
    prepared: PreparedRuntimeSecretsSnapshot,
    reason: RuntimeSecretsActivationParams["reason"],
    scope: SecretsStateScope = "full",
    activationScope: SecretsStateScope = "full",
  ) => {
    logPreparedSecretDegradations(params.logSecrets, prepared.degradedOwners ?? []);
    if (reason === "startup") {
      return;
    }
    // A provider-auth-only refresh cannot erase unrelated full-reload degradation.
    // A committed full reload may narrow full state to its remaining provider owners.
    if (activationScope === "provider-auth" && activeDegradationScope === "full") {
      return;
    }
    if (!secretsDegraded) {
      params.emitStateEvent(
        "SECRETS_RELOADER_DEGRADED",
        "Secret resolution degraded one or more owners; healthy owners were refreshed.",
        prepared.config,
      );
    }
    const currentSupportsSourceOnlyRecovery =
      preparedDegradationSupportsSourceOnlyRecovery(prepared);
    activeDegradationSupportsSourceOnlyRecovery = secretsDegraded
      ? activeDegradationSupportsSourceOnlyRecovery && currentSupportsSourceOnlyRecovery
      : currentSupportsSourceOnlyRecovery;
    secretsDegraded = true;
    activeDegradationGeneration = ++degradationGeneration;
    activeDegradationConfig = structuredClone(prepared.sourceConfig);
    activeDegradationScope = scope;
  };

  const finishPreparedSnapshot = async (
    prepared: PreparedRuntimeSecretsSnapshot,
    activationParams: RuntimeSecretsActivationParams,
    options?: {
      activateRuntimeSecretsSnapshot?: (snapshot: PreparedRuntimeSecretsSnapshot) => void;
      onActivated?: () => void;
      alreadyActivated?: boolean;
      stateScope?: SecretsStateScope;
      stateDegradedOwners?: PreparedRuntimeSecretsSnapshot["degradedOwners"];
    },
  ) => {
    assertRuntimeGatewayAuthNotKnownWeak(prepared.config);
    if (activationParams.activate && !options?.alreadyActivated) {
      const activateRuntimeSecretsSnapshot =
        options?.activateRuntimeSecretsSnapshot ?? (await loadActivateRuntimeSecretsSnapshot());
      activateRuntimeSecretsSnapshot(prepared);
    }
    if (activationParams.activate) {
      // Invoke publication at the activation edge so no microtask can replace
      // the candidate before its runtime commit begins.
      options?.onActivated?.();
      logGatewayAuthSurfaceDiagnostics(prepared, params.logSecrets);
    }
    logRuntimeSecretWarnings({
      snapshot: prepared,
      log: params.logSecrets,
      ownerUnavailable:
        activationParams.activate && activationParams.deferStatePublication !== true
          ? "include"
          : "exclude",
    });
    const statePrepared = options?.stateDegradedOwners
      ? { ...prepared, degradedOwners: options.stateDegradedOwners }
      : prepared;
    const stateScope = options?.stateScope ?? resolvePreparedSecretsStateScope(statePrepared);
    const activationScope = options?.stateScope ?? "full";
    if (activationParams.activate && (statePrepared.degradedOwners?.length ?? 0) > 0) {
      if (activationParams.deferStatePublication === true) {
        const activationRevision = getActiveSecretsRuntimeSnapshotRevision();
        deferredStateTransitions.set(prepared, {
          kind: "degraded",
          activationRevision,
          reason: activationParams.reason,
          activationScope,
        });
        pendingDeferredLineageRevision = activationRevision;
      } else {
        publishDegradation(statePrepared, activationParams.reason, stateScope, activationScope);
      }
    } else if (activationParams.activate && secretsDegraded) {
      if (activationParams.deferStatePublication === true) {
        if (activeDegradationGeneration !== null) {
          const activationRevision = getActiveSecretsRuntimeSnapshotRevision();
          deferredStateTransitions.set(prepared, {
            kind: "recovered",
            activationRevision,
            degradationGeneration: activeDegradationGeneration,
            reason: activationParams.reason,
            activationScope,
          });
          pendingDeferredLineageRevision = activationRevision;
        }
      } else {
        publishRecovery(prepared.config, undefined, stateScope);
      }
    }
    return prepared;
  };

  const handleSecretsActivationError = (
    err: unknown,
    activationParams: RuntimeSecretsActivationParams,
    eventConfig: OpenClawConfig,
  ): never => {
    const mayPublishReloadDegradation =
      (activationParams.activate || activationParams.publishFailureAsDegraded === true) &&
      (activationParams.canPublishFailureAsDegraded?.() ?? true);
    const degradations = classifySecretResolutionErrorDegradations(err);
    const retryableDegradations = degradations.filter((degradation) =>
      isRetryableSecretDegradationReason(degradation.reason),
    );
    if (
      retryableDegradations.length > 0 &&
      (activationParams.reason === "startup" || mayPublishReloadDegradation)
    ) {
      logThrownSecretDegradations(params.logSecrets, err, retryableDegradations);
      if (activationParams.reason !== "startup") {
        if (!secretsDegraded) {
          params.emitStateEvent(
            "SECRETS_RELOADER_DEGRADED",
            "Secret resolution failed; runtime remains on the last-known-good snapshot.",
            eventConfig,
          );
        }
        const failedOwners = listSecretResolutionErrorOwners(err).filter(
          (owner) => owner.failureMatched,
        );
        const currentFailureSupportsSourceOnlyRecovery =
          failedOwners.length > 0 &&
          failedOwners.every(
            (owner) => owner.source === "config" && owner.degradationState === "cold",
          );
        activeDegradationSupportsSourceOnlyRecovery = secretsDegraded
          ? activeDegradationSupportsSourceOnlyRecovery && currentFailureSupportsSourceOnlyRecovery
          : currentFailureSupportsSourceOnlyRecovery;
        secretsDegraded = true;
        activeDegradationGeneration = ++degradationGeneration;
        activeDegradationConfig = structuredClone(eventConfig);
        activeDegradationScope = "full";
      }
    }
    if (activationParams.reason === "startup") {
      if (degradations.length > 0) {
        throw new Error("Startup failed: required secrets are unavailable.");
      }
      throw new Error(`Startup failed: required secrets are unavailable. ${String(err)}`, {
        cause: err,
      });
    }
    throw err;
  };

  const activateRuntimeSecrets = (async (config, activationParams) =>
    await runWithSecretsActivationLock(async () => {
      let activationSourceConfig = config;
      try {
        const { sourceConfig, assignmentConfig } = resolveGatewayStartupSecretProjection({
          config,
          reason: activationParams.reason,
          channelAutostartSuppression: params.channelAutostartSuppression,
          ...(activationParams.env ? { env: activationParams.env } : {}),
        });
        activationSourceConfig = sourceConfig;
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
          activationParams.reason !== "startup" || getActiveSecretsRuntimeSnapshot() === null;
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
        return handleSecretsActivationError(err, activationParams, activationSourceConfig);
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
    const runtimeSourceConfig = activationParams.runtimeSourceConfig;
    const activateRuntimeSecretsSnapshot = activationParams.activate
      ? runtimeSourceConfig
        ? (
            (runtime) => (preparedSnapshot: PreparedRuntimeSecretsSnapshot) =>
              runtime.activateSecretsRuntimeSnapshotWithSource(
                preparedSnapshot,
                runtimeSourceConfig,
              )
          )(await loadSecretsRuntime())
        : await loadActivateRuntimeSecretsSnapshot()
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

  const providerAuthActivationParams = { reason: "reload", activate: true } as const;
  registerProviderAuthRuntimeSnapshotActivationOwner({
    runExclusive: runWithSecretsActivationLock,
    isCurrent: (snapshot, expectedRevision) =>
      getActiveSecretsRuntimeSnapshotRevision() === expectedRevision &&
      hasCurrentAuthStoreCredentialsRevision(snapshot),
    assertValid: (snapshot) => assertRuntimeGatewayAuthNotKnownWeak(snapshot.config),
    publish: async (snapshot) => {
      if (
        pendingDeferredLineageRevision !== null &&
        hasActiveSecretsRuntimeSnapshotLineage(pendingDeferredLineageRevision)
      ) {
        return;
      }
      await finishPreparedSnapshot(snapshot, providerAuthActivationParams, {
        alreadyActivated: true,
        stateScope: "provider-auth",
        stateDegradedOwners: listProviderAuthDegradedOwners(snapshot),
      });
    },
    onError: (error, snapshot) =>
      handleSecretsActivationError(error, providerAuthActivationParams, snapshot.sourceConfig),
  });

  runtimeSecretsStatePublishers.set(activateRuntimeSecrets, (snapshot, options) => {
    const transition = deferredStateTransitions.get(snapshot);
    deferredStateTransitions.delete(snapshot);
    if (transition && pendingDeferredLineageRevision === transition.activationRevision) {
      pendingDeferredLineageRevision = null;
    }
    if (!transition) {
      const sourceOnlyOwnsLineage =
        options?.sourceOnly === true &&
        options.expectedRevision !== undefined &&
        hasActiveSecretsRuntimeSnapshotLineage(options.expectedRevision);
      const activeSnapshot = sourceOnlyOwnsLineage ? getActiveSecretsRuntimeSnapshot() : null;
      const sourceOnlyDegradationGeneration = activeDegradationGeneration;
      const sourceOnlyContractRecovered =
        activeSnapshot !== null &&
        sourceOnlyDegradationGeneration !== null &&
        activeDegradationSupportsSourceOnlyRecovery &&
        activeDegradationConfig !== null &&
        !hasSameSecretReloadContract(activeDegradationConfig, activeSnapshot.sourceConfig);
      if (sourceOnlyContractRecovered) {
        if ((activeSnapshot.degradedOwners?.length ?? 0) > 0) {
          const activeScope = resolvePreparedSecretsStateScope(activeSnapshot);
          publishDegradation(activeSnapshot, "reload", activeScope);
        } else {
          publishRecovery(activeSnapshot.config, sourceOnlyDegradationGeneration);
        }
      }
      return;
    }
    if (!hasActiveSecretsRuntimeSnapshotLineage(transition.activationRevision)) {
      return;
    }
    const activeSnapshot = getActiveSecretsRuntimeSnapshot();
    if (!activeSnapshot) {
      return;
    }
    logRuntimeSecretWarnings({
      snapshot: activeSnapshot,
      log: params.logSecrets,
      ownerUnavailable: "active-only",
    });
    if ((activeSnapshot.degradedOwners?.length ?? 0) > 0) {
      const activeScope = resolvePreparedSecretsStateScope(activeSnapshot);
      const { reason, activationScope } = transition;
      publishDegradation(activeSnapshot, reason, activeScope, activationScope);
      return;
    }
    if (
      options?.sourceOnly === true &&
      (!activeDegradationSupportsSourceOnlyRecovery ||
        activeDegradationConfig === null ||
        hasSameSecretReloadContract(activeDegradationConfig, activeSnapshot.sourceConfig))
    ) {
      return;
    }
    const generation =
      transition.kind === "recovered" ? transition.degradationGeneration : undefined;
    publishRecovery(activeSnapshot.config, generation, transition.activationScope);
  });

  return activateRuntimeSecrets;
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
