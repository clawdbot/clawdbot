import { isDeepStrictEqual } from "node:util";
import { isRestartEnabled } from "../config/commands.flags.js";
import { getConfigValueAtPath } from "../config/config-paths.js";
import { setRuntimeConfigAppliedHash } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRestartIntent } from "../infra/restart-intent.js";
import {
  deferGatewayRestartUntilIdle,
  type RestartDeferralHandle,
  resolveGatewayRestartDeferralTimeoutMs,
  setGatewaySigusr1RestartPolicy,
} from "../infra/restart.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { createAppliedConfigHashPublisher } from "./applied-config-hash-publisher.js";
import type { GatewayReloadPlan } from "./config-reload.js";
import {
  GatewayConfigReloadSupersededError,
  isCurrentGatewayReloadGeneration,
  type AcceptedRestartTarget,
  type AcceptedRestartTargetOwnership,
  type GatewayReloadHandlerParams,
  type GatewayRestartRequestOptions,
  type GatewayRestartTransactionResult,
  type GatewayRestartTransactionState,
} from "./server-reload-contracts.js";

const RESTART_EMISSION_RETRY_MS = 1_000;

type GatewayActiveCounts = {
  queueSize: number;
  pendingReplies: number;
  embeddedRuns: number;
  backgroundExecSessions: number;
  rootRequests: number;
  activeTasks: number;
  totalActive: number;
};

export function createGatewayRestartCoordinator(coordinatorOptions: {
  params: GatewayReloadHandlerParams;
  myGeneration: number;
  restartRecoveryAvailable: boolean;
  getActiveCounts: () => GatewayActiveCounts;
  formatActiveDetails: (counts: GatewayActiveCounts) => string[];
  formatTaskBlockers: () => string | null;
}) {
  const {
    params,
    myGeneration,
    restartRecoveryAvailable,
    getActiveCounts,
    formatActiveDetails,
    formatTaskBlockers,
  } = coordinatorOptions;
  let restartPending = false;
  let restartRetryStopped = false;
  let restartRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let restartDeferral: RestartDeferralHandle | null = null;
  let restartRequestGeneration = 0;
  let restartRequestTransaction: { state: GatewayRestartTransactionState } | null = null;
  // onReady/onTimeout precede async restart preparation. Keep committed details
  // debt-eligible until the emitter confirms this generation won.
  let restartEmissionSettled = false;
  type RestartRequestDetails = {
    plan: GatewayReloadPlan;
    nextConfig: OpenClawConfig;
    restartOwnedPaths: string[];
    retainDebtAcrossConfigChanges: boolean;
  };
  let restartRequestDetails: RestartRequestDetails | null = null;
  let pausedRestartDebt: RestartRequestDetails | null = null;
  // Post-commit recovery is satisfied only by an accepted restart emission.
  // Keep it separate from config-owned debt that later baselines may retire.
  let conservativeRestartDebt: RestartRequestDetails | null = null;
  let latestAcceptedRestartTarget: AcceptedRestartTarget | null = null;
  let acceptedRestartTargetGeneration = 0;
  let configCandidatePending = false;

  const recordAcceptedRestartTarget = (target: AcceptedRestartTarget) => {
    const generation = ++acceptedRestartTargetGeneration;
    const acceptedTarget: AcceptedRestartTarget = {
      ...target,
      prepareRuntimeConfig: async () => {
        if (
          configCandidatePending ||
          generation !== acceptedRestartTargetGeneration ||
          latestAcceptedRestartTarget !== acceptedTarget
        ) {
          throw new GatewayConfigReloadSupersededError();
        }
        const prepared = await target.prepareRuntimeConfig();
        if (
          configCandidatePending ||
          generation !== acceptedRestartTargetGeneration ||
          latestAcceptedRestartTarget !== acceptedTarget
        ) {
          throw new GatewayConfigReloadSupersededError();
        }
        return prepared;
      },
    };
    latestAcceptedRestartTarget = acceptedTarget;
    configCandidatePending = false;
    return {
      reject: () => {
        if (latestAcceptedRestartTarget !== acceptedTarget) {
          return;
        }
        acceptedRestartTargetGeneration += 1;
        latestAcceptedRestartTarget = null;
        configCandidatePending = true;
      },
    } satisfies AcceptedRestartTargetOwnership;
  };

  const createRestartRequestDetails = (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    options?: GatewayRestartRequestOptions,
  ): RestartRequestDetails => {
    const explicitRestartPaths = plan.restartReasons.filter((path) =>
      plan.changedPaths.includes(path),
    );
    return {
      plan,
      nextConfig: options?.debtConfig ?? nextConfig,
      restartOwnedPaths:
        explicitRestartPaths.length > 0 ? explicitRestartPaths : [...plan.changedPaths],
      retainDebtAcrossConfigChanges: options?.retainDebtAcrossConfigChanges === true,
    };
  };

  const deferGatewayRestartDebt = (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    options?: GatewayRestartRequestOptions,
  ) => {
    const details = createRestartRequestDetails(plan, nextConfig, options);
    if (details.retainDebtAcrossConfigChanges) {
      conservativeRestartDebt = details;
    } else {
      pausedRestartDebt = details;
    }
  };

  const preserveRestartDebt = (details: RestartRequestDetails) => {
    if (details.retainDebtAcrossConfigChanges) {
      conservativeRestartDebt = details;
    } else {
      pausedRestartDebt = details;
    }
  };

  const takeConservativeRestartDebt = (): RestartRequestDetails | null => {
    const debt = conservativeRestartDebt;
    conservativeRestartDebt = null;
    return debt;
  };

  const restoreConservativeRestartDebt = (debt: RestartRequestDetails) => {
    conservativeRestartDebt ??= debt;
  };

  const publishAcceptedRestartTarget = (target: AcceptedRestartTarget) => ({
    ownership: recordAcceptedRestartTarget(target),
    conservativeDebt: takeConservativeRestartDebt(),
  });

  const markRestartEmissionSettled = () => {
    restartEmissionSettled = true;
    conservativeRestartDebt = null;
  };

  const isCurrentRestartRetry = (retry: { requestGeneration: number }) =>
    !restartRetryStopped &&
    retry.requestGeneration === restartRequestGeneration &&
    isCurrentGatewayReloadGeneration(myGeneration);

  const supersedeRestartRequest = () => {
    restartRequestGeneration += 1;
    restartPending = false;
    restartDeferral?.cancel();
    restartDeferral = null;
    if (restartRetryTimer) {
      clearTimeout(restartRetryTimer);
      restartRetryTimer = null;
    }
    restartRequestTransaction = null;
    restartRequestDetails = null;
    restartEmissionSettled = false;
  };

  const stopRestartRetries = () => {
    restartRetryStopped = true;
    pausedRestartDebt = null;
    conservativeRestartDebt = null;
    supersedeRestartRequest();
  };

  const appliedConfigHashPublisher = createAppliedConfigHashPublisher({
    hasPendingRestart: () =>
      restartRequestDetails !== null ||
      pausedRestartDebt !== null ||
      conservativeRestartDebt !== null,
    publish: setRuntimeConfigAppliedHash,
  });

  const scheduleRestartEmissionRetry = (retry: {
    reason: string;
    intent?: GatewayRestartIntent;
    requestGeneration: number;
    prepareForEmit?: () => Promise<boolean>;
  }) => {
    if (restartRetryTimer || !isCurrentRestartRetry(retry)) {
      return;
    }
    // Retry the exact failed emission. Re-entering request planning would start
    // a fresh idle deferral and discard a timeout's force/deadline decision.
    restartPending = true;
    restartRetryTimer = setTimeout(() => {
      restartRetryTimer = null;
      if (!isCurrentRestartRetry(retry)) {
        return;
      }
      // Timer callbacks outlive the config transaction root. Re-enter process
      // admission so prepared host suspension cannot race signal delivery.
      void runWithGatewayIndependentRootWorkAdmission(async () => {
        if (!isCurrentRestartRetry(retry)) {
          return;
        }
        restartPending = false;
        if (retry.prepareForEmit && !(await retry.prepareForEmit())) {
          scheduleRestartEmissionRetry(retry);
          return;
        }
        const emitResult = params.requestRecoveryRestart?.(retry.reason, retry.intent);
        if (emitResult && emitResult.status !== "failed") {
          markRestartEmissionSettled();
        }
        if (!emitResult || emitResult.status === "failed") {
          scheduleRestartEmissionRetry(retry);
        }
      }).catch((err: unknown) => {
        if (isCurrentRestartRetry(retry)) {
          params.logReload.warn(`gateway restart recovery retry stopped: ${String(err)}`);
        }
      });
    }, RESTART_EMISSION_RETRY_MS);
    restartRetryTimer.unref?.();
  };

  const acceptRestartConfig = (acceptedConfig?: OpenClawConfig) => {
    if (restartRequestTransaction?.state !== "rejected") {
      return { retireRejectedRestart: false };
    }
    const rejectedDebt = !restartEmissionSettled ? restartRequestDetails : null;
    if (rejectedDebt) {
      preserveRestartDebt(rejectedDebt);
    }
    supersedeRestartRequest();
    const configDebt = pausedRestartDebt;
    const retainsConfigDebt =
      configDebt &&
      acceptedConfig &&
      configDebt.restartOwnedPaths.every((path) =>
        isDeepStrictEqual(
          getConfigValueAtPath(
            configDebt.nextConfig as unknown as Record<string, unknown>,
            path.split("."),
          ),
          getConfigValueAtPath(
            acceptedConfig as unknown as Record<string, unknown>,
            path.split("."),
          ),
        ),
      );
    if (!retainsConfigDebt) {
      pausedRestartDebt = null;
    }
    const debt = (retainsConfigDebt ? configDebt : null) ?? conservativeRestartDebt;
    if (debt) {
      return { retireRejectedRestart: false, debt };
    }
    return { retireRejectedRestart: true };
  };
  const retireRejectedRestartRequest = () => acceptRestartConfig().retireRejectedRestart;

  const beginGatewayRestartLifecycle = () => {
    // A newer restart candidate owns the disk config now. Cancel any older
    // emission before async preflight so it cannot restart into stale secrets.
    if (
      !restartEmissionSettled &&
      restartRequestTransaction?.state !== "pending" &&
      restartRequestDetails
    ) {
      preserveRestartDebt(restartRequestDetails);
    }
    supersedeRestartRequest();
    const transaction = { state: "pending" as GatewayRestartTransactionState };
    restartRequestTransaction = transaction;
    return {
      settle: (state: Exclude<GatewayRestartTransactionState, "pending">) => {
        if (transaction.state === "pending") {
          transaction.state = state;
          if (state === "committed") {
            pausedRestartDebt = null;
          }
        }
      },
    };
  };

  const pauseGatewayRestartForConfigCandidate = () => {
    configCandidatePending = true;
    const lifecycle = beginGatewayRestartLifecycle();
    // Candidate acceptance owns debt rearm. Until then, invalid/failed config
    // must leave the prior committed restart paused.
    lifecycle.settle("rejected");
  };

  const requestGatewayRestartForGeneration = (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    requestGeneration: number,
    options?: GatewayRestartRequestOptions,
  ): boolean => {
    const reasons = plan.restartReasons.length
      ? plan.restartReasons.join(", ")
      : plan.changedPaths.join(", ");
    const restartReason = `config reload: ${reasons}`;

    if (!restartRecoveryAvailable) {
      params.logReload.warn(
        "gateway restart recovery unavailable; restart-required reload rejected",
      );
      return false;
    }
    if (!params.requestRecoveryRestart) {
      params.logReload.warn("gateway restart recovery handler unavailable; restart skipped");
      return false;
    }
    const requestRecoveryRestart = params.requestRecoveryRestart;
    let emissionPrepared = true;
    const prepareForEmit = async () => {
      try {
        const preparedConfig = options?.prepareRuntimeConfig
          ? await options.prepareRuntimeConfig()
          : nextConfig;
        if (requestGeneration !== restartRequestGeneration) {
          return false;
        }
        emissionPrepared = true;
        setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(preparedConfig) });
        return requestGeneration === restartRequestGeneration;
      } catch (err) {
        emissionPrepared = false;
        params.logReload.warn(`gateway restart secrets preflight failed: ${String(err)}`);
        return false;
      }
    };

    const active = getActiveCounts();

    if (active.totalActive > 0 || options?.prepareRuntimeConfig) {
      // Avoid spinning up duplicate polling loops from repeated config changes.
      if (restartPending) {
        params.logReload.info(
          `config change requires gateway restart (${reasons}) — already waiting for operations to complete`,
        );
        return true;
      }
      restartPending = true;
      if (active.totalActive > 0) {
        const initialDetails = formatActiveDetails(active);
        params.logReload.warn(
          `config change requires gateway restart (${reasons}) — deferring until ${initialDetails.join(", ")} complete`,
        );
        const taskBlockers = formatTaskBlockers();
        if (taskBlockers) {
          params.logReload.warn(
            `restart blocked by active background task run(s): ${taskBlockers}`,
          );
        }
      } else {
        params.logReload.warn(`config change requires gateway restart (${reasons}) — preparing`);
      }

      let failedEmission: { reason: string; intent?: GatewayRestartIntent } | undefined;
      restartDeferral = deferGatewayRestartUntilIdle({
        getPendingCount: () => getActiveCounts().totalActive,
        maxWaitMs: resolveGatewayRestartDeferralTimeoutMs(undefined),
        timeoutIntent: { force: true, reason: "config reload forced restart" },
        reason: restartReason,
        emitHooks: {
          beforeEmit: async () => {
            emissionPrepared = await prepareForEmit();
          },
          emitRestart: (reason, intent) => {
            if (requestGeneration !== restartRequestGeneration) {
              return { status: "coalesced" };
            }
            const resolvedReason = reason ?? restartReason;
            if (!emissionPrepared) {
              failedEmission = { reason: resolvedReason, intent };
              return { status: "failed" };
            }
            const emitResult = requestRecoveryRestart(resolvedReason, intent);
            if (emitResult.status !== "failed") {
              markRestartEmissionSettled();
            }
            failedEmission =
              emitResult.status === "failed" ? { reason: resolvedReason, intent } : undefined;
            return emitResult;
          },
          afterEmitFailed: async () => {
            if (requestGeneration !== restartRequestGeneration || !failedEmission) {
              return;
            }
            if (!restartRecoveryAvailable) {
              params.logReload.warn("gateway restart recovery unavailable; retry skipped");
              return;
            }
            params.logReload.warn("gateway restart recovery emission failed; retrying");
            scheduleRestartEmissionRetry({
              ...failedEmission,
              requestGeneration,
              prepareForEmit,
            });
          },
        },
        hooks: {
          onReady: () => {
            restartPending = false;
            restartDeferral = null;
            params.logReload.info("all operations and replies completed; restarting gateway now");
          },
          onStillPending: (_pending, elapsedMs) => {
            const remaining = formatActiveDetails(getActiveCounts());
            const taskBlockersValue = formatTaskBlockers();
            params.logReload.warn(
              `restart still deferred after ${elapsedMs}ms with ${remaining.join(", ")} active${
                taskBlockersValue ? ` (${taskBlockersValue})` : ""
              }`,
            );
          },
          onTimeout: (_pending, elapsedMs) => {
            const remaining = formatActiveDetails(getActiveCounts());
            const taskBlockersLocal = formatTaskBlockers();
            restartPending = false;
            restartDeferral = null;
            params.logReload.warn(
              `restart timeout after ${elapsedMs}ms with ${remaining.join(", ")} still active${
                taskBlockersLocal ? ` (${taskBlockersLocal})` : ""
              }; forcing restart`,
            );
          },
          onCheckError: (err) => {
            restartPending = false;
            restartDeferral = null;
            params.logReload.warn(
              `restart deferral check failed (${String(err)}); restarting gateway now`,
            );
          },
        },
      });
      setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
      return true;
    }
    // No active operations or pending replies, restart immediately
    params.logReload.warn(`config change requires gateway restart (${reasons})`);
    // The managed reloader owns independent root admission until onRestart
    // returns. Extend that fence across signal delivery until the run loop
    // atomically promotes it to one-way restart drain.
    const emitResult = requestRecoveryRestart(restartReason);
    if (emitResult.status !== "failed") {
      markRestartEmissionSettled();
    }
    if (emitResult.status === "failed") {
      params.logReload.warn("gateway restart recovery emission failed");
      if (restartRecoveryAvailable) {
        scheduleRestartEmissionRetry({
          reason: restartReason,
          requestGeneration,
          prepareForEmit,
        });
      }
      return false;
    }
    if (emitResult.status === "coalesced") {
      params.logReload.info("gateway restart already scheduled; skipping duplicate signal");
    }
    setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
    return true;
  };

  const requestGatewayRestart = (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    options?: GatewayRestartRequestOptions,
  ): GatewayRestartTransactionResult => {
    if (restartRetryStopped) {
      return { status: "recovery-pending", settle: () => {} };
    }
    // Only another restart requirement supersedes accepted restart work. A
    // duplicate, hot-only, or failed config transaction must preserve it.
    supersedeRestartRequest();
    const transaction = { state: "pending" as GatewayRestartTransactionState };
    restartRequestTransaction = transaction;
    restartEmissionSettled = false;
    restartRequestDetails = createRestartRequestDetails(plan, nextConfig, options);
    const accepted = requestGatewayRestartForGeneration(
      plan,
      nextConfig,
      restartRequestGeneration,
      options,
    );
    return {
      status: accepted ? "accepted" : "recovery-pending",
      settle: (state) => {
        if (transaction.state === "pending") {
          transaction.state = state;
        }
      },
    };
  };

  return {
    acceptRestartConfig,
    ...appliedConfigHashPublisher,
    beginGatewayRestartLifecycle,
    pauseGatewayRestartForConfigCandidate,
    publishAcceptedRestartTarget,
    recordAcceptedRestartTarget,
    requestGatewayRestart,
    restoreConservativeRestartDebt,
    retireRejectedRestartRequest,
    stopRestartRetries,
    deferGatewayRestartDebt,
    getLatestAcceptedRestartTarget: () => latestAcceptedRestartTarget,
    hasConfigCandidatePending: () => configCandidatePending,
    hasRestartRequestTransaction: () => restartRequestTransaction !== null,
    isRestartRetryStopped: () => restartRetryStopped,
  };
}
