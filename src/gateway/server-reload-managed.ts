import {
  advancePreparedModelRuntimeConfig,
  refreshPreparedModelRuntimeSnapshots,
} from "../agents/prepared-model-runtime.js";
import { copyConfigResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyLoggingConfig } from "../logging/logger.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeSnapshotRevisionState } from "../secrets/runtime-state.js";
import { resetSkillSnapshotConfigFingerprintCache } from "../skills/runtime/snapshot-config-fingerprint.js";
import { invalidateConfigGetResponseCache } from "./config-get-response.js";
import { isNoopGatewayReloadPlan } from "./config-reload-plan.js";
import { shouldRewarmProviderAuthState } from "./config-reload-recovery.js";
import {
  startGatewayConfigReloader,
  type GatewayConfigReloadTransactionOwnership,
  type GatewayReloadPlan,
} from "./config-reload.js";
import {
  GatewayConfigReloadSupersededError,
  GatewayHotReloadRecoveryError,
  GatewayHotReloadStaleSecretsError,
  abortPendingChannelReloads,
  type AcceptedRestartTarget,
  type AcceptedRestartTargetOwnership,
  type CurrentRuntimeSecretsPreparation,
  type GatewayGmailRestartAbortController,
  type GatewayRestartRequestOptions,
  type GatewayRestartTransactionResult,
  type ManagedGatewayConfigReloaderHandle,
  type ManagedGatewayConfigReloaderParams,
  type RuntimeSecretsPreflightParams,
} from "./server-reload-contracts.js";
import { createGatewayReloadHandlers } from "./server-reload-hot.js";
import {
  createManagedReloadSecretHandlers,
  isRuntimeSecretsPreparationCurrent,
} from "./server-reload-managed-secrets.js";
import {
  assertIrreversibleReloadPlanHasRecoveryOwner,
  restoreCanonicalSecretRefs,
} from "./server-reload-utils.js";
import {
  captureSharedGatewaySessionGenerationOwnership,
  disconnectStaleSharedGatewayAuthClients,
  isSharedGatewaySessionGenerationOwnershipCurrent,
  setRequiredSharedGatewaySessionGenerationIfOwned,
  type SharedGatewaySessionGenerationOwnership,
} from "./server-shared-auth-generation.js";

function canAdvancePreparedModelRuntimeConfigInPlace(plan: GatewayReloadPlan): boolean {
  return isNoopGatewayReloadPlan(plan) && !shouldRewarmProviderAuthState(plan);
}

export function startManagedGatewayConfigReloader(
  params: ManagedGatewayConfigReloaderParams,
): ManagedGatewayConfigReloaderHandle {
  let stopped = false;
  if (params.minimalTestGateway) {
    return {
      stop: async () => {
        stopped = true;
      },
      notifyPluginMetadataChanged: () => {},
      isConfigReloadSettled: () => !stopped,
    };
  }

  const prepareRuntimeCandidate = (
    runtimeConfig: OpenClawConfig,
    sourceConfig: OpenClawConfig,
    ownership?: GatewayConfigReloadTransactionOwnership,
  ): OpenClawConfig => {
    const canonicalConfig = restoreCanonicalSecretRefs(runtimeConfig, sourceConfig);
    copyConfigResolutionFacts(sourceConfig, canonicalConfig);
    const candidateConfig = ownership?.reapplyRuntimeOverlays(canonicalConfig) ?? canonicalConfig;
    const prepared = params.applyRuntimeConfigOverrides?.(candidateConfig) ?? candidateConfig;
    copyConfigResolutionFacts(candidateConfig, prepared);
    return prepared;
  };
  const applyRuntimeConfigOverrides = (config: OpenClawConfig): OpenClawConfig => {
    const applied = params.applyRuntimeConfigOverrides?.(config) ?? config;
    copyConfigResolutionFacts(config, applied);
    return applied;
  };
  const restartRecoveryAvailable =
    params.restartRecoveryAvailable !== false && params.requestRecoveryRestart !== undefined;

  const tryPrepareRuntimeSecrets = async (
    config: OpenClawConfig,
    transactionOwnership: GatewayConfigReloadTransactionOwnership,
    activationParams: RuntimeSecretsPreflightParams,
  ): Promise<CurrentRuntimeSecretsPreparation | null> => {
    if (!transactionOwnership.isCurrent()) {
      throw new GatewayConfigReloadSupersededError();
    }
    const expectedRevision = getActiveSecretsRuntimeSnapshotRevisionState();
    try {
      const snapshot = await params.activateRuntimeSecrets(config, {
        ...activationParams,
        activate: false,
        canPublishFailureAsDegraded: () =>
          transactionOwnership.isCurrent() &&
          getActiveSecretsRuntimeSnapshotRevisionState() === expectedRevision,
      });
      if (!transactionOwnership.isCurrent()) {
        throw new GatewayConfigReloadSupersededError();
      }
      return getActiveSecretsRuntimeSnapshotRevisionState() === expectedRevision
        ? { snapshot, expectedRevision }
        : null;
    } catch (error) {
      if (!transactionOwnership.isCurrent()) {
        throw new GatewayConfigReloadSupersededError();
      }
      if (getActiveSecretsRuntimeSnapshotRevisionState() !== expectedRevision) {
        return null;
      }
      throw error;
    }
  };
  let activeGmailRestartAbortController: GatewayGmailRestartAbortController | null = null;
  const abortActiveGmailRestart = () => {
    activeGmailRestartAbortController?.abort();
    activeGmailRestartAbortController = null;
  };
  const createGmailRestartAbortController = (): GatewayGmailRestartAbortController => {
    abortActiveGmailRestart();
    const abortController = new AbortController();
    if (stopped) {
      abortController.abort();
      return abortController;
    }
    activeGmailRestartAbortController = abortController;
    return abortController;
  };
  const {
    applyHotReload,
    acceptRestartConfig,
    beginGatewayRestartLifecycle,
    hasOutstandingGatewayRestart,
    hasConfigCandidatePending,
    pauseGatewayRestartForConfigCandidate,
    publishAppliedConfigHash,
    publishAcceptedRestartTarget,
    publishDeferredAppliedConfigHash,
    recordAcceptedRestartTarget,
    requestGatewayRestart,
    restoreConservativeRestartDebt,
    stopRestartRetries,
  } = createGatewayReloadHandlers({
    deps: params.deps,
    broadcast: params.broadcast,
    ...(params.resolveGatewayContext
      ? { resolveGatewayContext: params.resolveGatewayContext }
      : {}),
    getState: params.getState,
    setState: params.setState,
    getPluginMetadataSnapshot: params.getPluginMetadataSnapshot,
    startChannel: params.startChannel,
    stopChannel: params.stopChannel,
    pruneInactiveChannelAccountState: params.channelManager.pruneInactiveChannelAccountState,
    getChannelAutostartSuppression: params.getChannelAutostartSuppression,
    stopPostReadySidecars: params.stopPostReadySidecars,
    reloadPlugins: params.reloadPlugins,
    logHooks: params.logHooks,
    logChannels: params.logChannels,
    logCron: params.logCron,
    logReload: params.logReload,
    cronReconciliation: params.cronReconciliation,
    createGmailRestartAbortController,
    clearGmailRestartAbortController: (abortController) => {
      if (activeGmailRestartAbortController === abortController) {
        activeGmailRestartAbortController = null;
      }
    },
    ...(params.onCronRestart ? { onCronRestart: params.onCronRestart } : {}),
    ...(params.requestRecoveryRestart
      ? { requestRecoveryRestart: params.requestRecoveryRestart }
      : {}),
    assertRestartReady: () =>
      import("../state/openclaw-database-preflight.js").then(({ assertOpenClawDatabasesReady }) =>
        assertOpenClawDatabasesReady({ env: process.env, operation: "gateway-restart" }),
      ),
    restartRecoveryAvailable,
  });
  const runManagedRestart = async (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    transactionOwnership: GatewayConfigReloadTransactionOwnership,
    sourceConfig: OpenClawConfig,
    restartOptions?: GatewayRestartRequestOptions,
    beforeRestartRequest?: () => Promise<void>,
  ) => {
    const isCurrent = () => !stopped && transactionOwnership.isCurrent();
    const assertCurrent = () => {
      if (!isCurrent()) {
        throw new GatewayConfigReloadSupersededError();
      }
    };
    assertCurrent();
    const restartLifecycle = beginGatewayRestartLifecycle();
    let preparation:
      | {
          ownership: SharedGatewaySessionGenerationOwnership;
          previousRequired: string | undefined | null;
          previousCurrent: string | undefined;
          nextGeneration: string | undefined;
          runtimeConfig: OpenClawConfig;
        }
      | undefined;
    try {
      for (;;) {
        assertCurrent();
        const ownership = captureSharedGatewaySessionGenerationOwnership(
          params.sharedGatewaySessionGenerationState,
        );
        const previousRequired = params.sharedGatewaySessionGenerationState.required;
        const prepared = await tryPrepareRuntimeSecrets(
          prepareRuntimeCandidate(nextConfig, sourceConfig, transactionOwnership),
          transactionOwnership,
          {
            reason: "restart-check",
            publishFailureAsDegraded: true,
            ...(transactionOwnership.runtimeEnv
              ? { env: transactionOwnership.runtimeEnv.env }
              : {}),
          },
        );
        assertCurrent();
        const generationChanged = !isSharedGatewaySessionGenerationOwnershipCurrent(
          params.sharedGatewaySessionGenerationState,
          ownership,
        );
        if (!prepared || !isRuntimeSecretsPreparationCurrent(prepared) || generationChanged) {
          continue;
        }
        preparation = {
          ownership,
          previousRequired,
          previousCurrent: ownership.generation,
          nextGeneration: params.resolveSharedGatewaySessionGenerationForConfig(
            prepared.snapshot.config,
          ),
          runtimeConfig: prepared.snapshot.config,
        };
        break;
      }
    } catch (error) {
      restartLifecycle.settle("rejected");
      throw error;
    }
    const {
      ownership: preparationOwnership,
      previousRequired: previousRequiredSharedGatewaySessionGeneration,
      previousCurrent: previousSharedGatewaySessionGeneration,
      nextGeneration: nextSharedGatewaySessionGeneration,
      runtimeConfig: preparedRuntimeConfig,
    } = preparation;
    let restartTransaction: GatewayRestartTransactionResult | undefined;
    let requiredOwnership: SharedGatewaySessionGenerationOwnership | null = null;
    try {
      assertCurrent();
      await params.reconcileRuntimePolicy(preparedRuntimeConfig, "restart");
      assertCurrent();
      await beforeRestartRequest?.();
      assertCurrent();
      // Claim the shared-session requirement before creating any async restart
      // emission. A rejected generation owner must never leave a live deferral.
      requiredOwnership = setRequiredSharedGatewaySessionGenerationIfOwned(
        params.sharedGatewaySessionGenerationState,
        preparationOwnership,
        previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration
          ? nextSharedGatewaySessionGeneration
          : null,
      );
      if (!requiredOwnership) {
        throw new GatewayHotReloadStaleSecretsError();
      }
      // Restart successors inherit process.env. Publish the prepared layer at
      // the admission edge, then roll it back if this restart is rejected.
      transactionOwnership.publishRuntimeEnv();
      restartTransaction = requestGatewayRestart(plan, preparedRuntimeConfig, {
        ...restartOptions,
        debtConfig: sourceConfig,
        prepareRuntimeConfig: async () => {
          for (;;) {
            const prepared = await tryPrepareRuntimeSecrets(
              prepareRuntimeCandidate(preparedRuntimeConfig, sourceConfig, transactionOwnership),
              transactionOwnership,
              {
                reason: "restart-check",
                publishFailureAsDegraded: true,
                ...(transactionOwnership.runtimeEnv
                  ? { env: transactionOwnership.runtimeEnv.env }
                  : {}),
              },
            );
            assertCurrent();
            if (prepared && isRuntimeSecretsPreparationCurrent(prepared)) {
              return prepared.snapshot.config;
            }
          }
        },
      });
      if (restartTransaction.status === "recovery-pending") {
        throw new GatewayHotReloadRecoveryError("config restart");
      }
      if (previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration) {
        disconnectStaleSharedGatewayAuthClients({
          clients: params.clients,
          expectedGeneration: nextSharedGatewaySessionGeneration,
        });
      }
      restartTransaction.settle("committed");
      transactionOwnership.commitRuntimeEnv();
      restartLifecycle.settle("committed");
    } catch (error) {
      restartTransaction?.settle("rejected");
      restartLifecycle.settle("rejected");
      transactionOwnership.rollbackRuntimeEnv();
      if (requiredOwnership) {
        setRequiredSharedGatewaySessionGenerationIfOwned(
          params.sharedGatewaySessionGenerationState,
          requiredOwnership,
          previousRequiredSharedGatewaySessionGeneration,
        );
      }
      throw error;
    }
  };

  const { onEffectiveConfigUnchanged, onHotReload } = createManagedReloadSecretHandlers({
    params,
    prepareRuntimeCandidate,
    tryPrepareRuntimeSecrets,
    applyHotReload,
  });

  let lastCommittedRuntimeConfig: OpenClawConfig | undefined;
  const configReloader = startGatewayConfigReloader({
    initialConfig: params.initialConfig,
    initialCompareConfig: params.initialCompareConfig,
    initialSnapshotRawHash: params.initialSnapshotRawHash,
    initialAuthoredConfig: params.initialAuthoredConfig,
    initialIncludedPaths: params.initialIncludedPaths ?? [],
    initialSnapshotValid: params.initialSnapshotValid,
    initialSnapshotIssues: params.initialSnapshotIssues,
    // Single notification point for every persisted config change — gateway
    // RPC writes, agent/CLI config_set, doctor, and hand edits all land here
    // once the candidate is accepted. Hash-only; clients refresh via config.get.
    onConfigCandidateCommitted: (info) => {
      invalidateConfigGetResponseCache();
      params.broadcast(
        "config.changed",
        {
          path: info.path,
          hash: info.persistedHash
            ? params.configRevisionProjector.projectRawHash(info.persistedHash)
            : null,
          ts: Date.now(),
        },
        { dropIfSlow: true },
      );
    },
    onRuntimeConfigCommitted: (plan, committedRuntimeConfig) => {
      // Secret resolution can make the committed runtime config a different
      // object from the source-derived candidate. Record the committed one so a
      // rebuild below stamps owners with the identity readers actually supply.
      lastCommittedRuntimeConfig = committedRuntimeConfig;
      params.resolveGatewayContext?.()?.mentionInbox?.invalidate();
      if (canAdvancePreparedModelRuntimeConfigInPlace(plan)) {
        advancePreparedModelRuntimeConfig(committedRuntimeConfig);
      }
    },
    ...(params.prepareConfigCandidate
      ? { prepareConfigCandidate: params.prepareConfigCandidate }
      : {}),
    initialInternalWriteHash: params.initialInternalWriteHash,
    runTransaction: (run) => runWithGatewayIndependentRootWorkAdmission(run, "reload:config"),
    readSnapshot: params.readSnapshot,
    promoteSnapshot: async (snapshot, _reason) => await params.promoteSnapshot(snapshot),
    subscribeToWrites: params.subscribeToWrites,
    onConfigCandidateObserved: pauseGatewayRestartForConfigCandidate,
    onConfigChange: (plan, nextConfig) => {
      assertIrreversibleReloadPlanHasRecoveryOwner(plan, restartRecoveryAvailable);
      params.prepareTerminalConfig(plan, applyRuntimeConfigOverrides(nextConfig));
    },
    onConfigAccepted: async (nextConfig, transactionOwnership, sourceConfig, acceptance) => {
      const assertCurrent = () => {
        if (!transactionOwnership.isCurrent()) {
          throw new GatewayConfigReloadSupersededError();
        }
      };
      const createRestartTarget = (): AcceptedRestartTarget => ({
        runtimeConfig: prepareRuntimeCandidate(nextConfig, sourceConfig, transactionOwnership),
        sourceConfig,
        prepareRuntimeConfig: async () => {
          for (;;) {
            const prepared = await tryPrepareRuntimeSecrets(
              prepareRuntimeCandidate(nextConfig, sourceConfig, transactionOwnership),
              transactionOwnership,
              {
                reason: "restart-check",
                publishFailureAsDegraded: true,
                ...(transactionOwnership.runtimeEnv
                  ? { env: transactionOwnership.runtimeEnv.env }
                  : {}),
              },
            );
            assertCurrent();
            if (prepared && isRuntimeSecretsPreparationCurrent(prepared)) {
              return prepared.snapshot.config;
            }
          }
        },
      });
      let rollbackSource: (() => Promise<void>) | undefined;
      let acceptedTargetOwnership: AcceptedRestartTargetOwnership | undefined;
      let lateConservativeDebt: ReturnType<
        typeof publishAcceptedRestartTarget
      >["conservativeDebt"] = null;
      try {
        assertCurrent();
        const acceptedRestart = acceptRestartConfig(sourceConfig);
        if (!acceptance.runtimeApplied) {
          // acceptRestartConfig leaves returned debt in its paused/conservative owner.
          // This candidate explicitly skipped runtime application, so a later
          // runtime-applied acceptance—not this source-only write—may rearm it.
          assertCurrent();
          recordAcceptedRestartTarget(createRestartTarget());
          params.acceptTerminalConfig({
            retireRejectedRestart: acceptedRestart.retireRejectedRestart,
          });
          publishDeferredAppliedConfigHash();
          return undefined;
        }
        if (acceptedRestart.debt) {
          await runManagedRestart(
            acceptedRestart.debt.plan,
            nextConfig,
            transactionOwnership,
            sourceConfig,
            {
              retainDebtAcrossConfigChanges: acceptedRestart.debt.retainDebtAcrossConfigChanges,
            },
            async () => {
              rollbackSource = await acceptance.publishSource?.();
            },
          );
        } else {
          rollbackSource = await acceptance.publishSource?.();
        }
        assertCurrent();
        // Target publication clears the candidate pause. Take conservative debt
        // synchronously at the same edge so acceptance-window failures cannot strand it.
        const acceptedTarget = publishAcceptedRestartTarget(createRestartTarget());
        acceptedTargetOwnership = acceptedTarget.ownership;
        lateConservativeDebt = acceptedTarget.conservativeDebt;
        if (lateConservativeDebt && lateConservativeDebt !== acceptedRestart.debt) {
          await runManagedRestart(
            lateConservativeDebt.plan,
            nextConfig,
            transactionOwnership,
            sourceConfig,
            {
              retainDebtAcrossConfigChanges: lateConservativeDebt.retainDebtAcrossConfigChanges,
            },
          );
        }
        assertCurrent();
        params.acceptTerminalConfig({
          retireRejectedRestart: acceptedRestart.retireRejectedRestart && !lateConservativeDebt,
        });
        publishDeferredAppliedConfigHash();
        return rollbackSource;
      } catch (error) {
        if (lateConservativeDebt) {
          restoreConservativeRestartDebt(lateConservativeDebt);
        }
        acceptedTargetOwnership?.reject();
        await rollbackSource?.();
        throw error;
      }
    },
    onConfigApplied: (plan, nextConfig) => {
      // Applied runtime identity owns config-derived process memos; accepted
      // source-only changes must not evict caches for the still-active config.
      if (plan.changedPaths.some((path) => path === "logging" || path.startsWith("logging."))) {
        applyLoggingConfig(nextConfig.logging);
      }
      resetSkillSnapshotConfigFingerprintCache();
    },
    onConfigRevisionApplied: publishAppliedConfigHash,
    hasOutstandingGatewayRestart,
    onEffectiveConfigUnchanged,
    onNoopConfigCommit: async (plan, nextConfig, ownership, sourceConfig) => {
      // Cleared per transaction so a rebuild can never inherit a config committed
      // by an earlier one when this commit does not reach markRuntimeCommitted.
      lastCommittedRuntimeConfig = undefined;
      const applicationStatus = await onHotReload(plan, nextConfig, ownership, sourceConfig);
      if (isNoopGatewayReloadPlan(plan) && !canAdvancePreparedModelRuntimeConfigInPlace(plan)) {
        // Rebuild against the committed runtime config, not the source-derived
        // candidate. `secrets.providers.*` resolves to a different object, and
        // stamping the rebuilt owner with the pre-resolution identity makes every
        // strict catalog read reject it -- the failure this fix exists to remove.
        const pluginMetadataSnapshot = params.getPluginMetadataSnapshot?.();
        await refreshPreparedModelRuntimeSnapshots(lastCommittedRuntimeConfig ?? nextConfig, {
          gatewayLifecycle: true,
          catalogMode: "static",
          allowGatewaySubagentBinding: true,
          ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
        });
      }
      return applicationStatus;
    },
    onHotReload,
    onRestart: runManagedRestart,
    log: {
      info: (msg) => params.logReload.info(msg),
      warn: (msg) => params.logReload.warn(msg),
      error: (msg) => params.logReload.error(msg),
    },
    watchPath: params.watchPath,
  });
  return {
    stop: async () => {
      stopped = true;
      stopRestartRetries();
      // Release managed waiters before the base reloader joins every active transaction.
      abortPendingChannelReloads();
      abortActiveGmailRestart();
      await configReloader.stop();
    },
    hotReloadStatus: configReloader.hotReloadStatus,
    notifyPluginMetadataChanged: configReloader.notifyPluginMetadataChanged,
    // Equal config revisions can still owe a plugin/runtime restart.
    isConfigReloadSettled: () =>
      !stopped && !hasConfigCandidatePending() && !hasOutstandingGatewayRestart(),
  };
}
