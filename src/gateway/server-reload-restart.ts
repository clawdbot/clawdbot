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

type RestartRequestDetails = {
  plan: GatewayReloadPlan;
  nextConfig: OpenClawConfig;
  restartOwnedPaths: string[];
  retainDebtAcrossConfigChanges: boolean;
};

type GatewayRestartOperation =
  | { kind: "idle" }
  | {
      kind: "lifecycle";
      transaction: { state: GatewayRestartTransactionState };
    }
  | {
      kind: "request";
      transaction: { state: GatewayRestartTransactionState };
      details: RestartRequestDetails;
      emissionSettled: boolean;
    };

type AcceptedRestartTargetState =
  | { kind: "empty"; generation: number }
  | {
      kind: "candidate-pending";
      generation: number;
      previousTarget: AcceptedRestartTarget | undefined;
    }
  | {
      kind: "accepted";
      generation: number;
      target: AcceptedRestartTarget;
    };

type GatewayRestartCoordinatorParams = Pick<
  GatewayReloadHandlerParams,
  "assertRestartReady" | "logReload" | "requestRecoveryRestart"
>;

type GatewayRestartCoordinatorOptions = {
  params: GatewayRestartCoordinatorParams;
  myGeneration: number;
  restartRecoveryAvailable: boolean;
  getActiveCounts: () => GatewayActiveCounts;
  formatActiveDetails: (counts: GatewayActiveCounts) => string[];
  formatDeferredWorkStatus: (status: "active" | "still active") => string;
  formatTaskBlockers: () => string | null;
};

class GatewayRestartTransaction {
  private restartPending = false;
  private retryStopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private restartDeferral: RestartDeferralHandle | null = null;
  private requestGeneration = 0;
  // onReady/onTimeout precede async restart preparation. Keep committed details
  // debt-eligible until the emitter confirms this generation won.
  private operation: GatewayRestartOperation = { kind: "idle" };
  private pausedDebt: RestartRequestDetails | null = null;
  // Post-commit recovery is satisfied only by an accepted restart emission.
  // Keep it separate from config-owned debt that later baselines may retire.
  private conservativeDebt: RestartRequestDetails | null = null;
  private acceptedTargetState: AcceptedRestartTargetState = { kind: "empty", generation: 0 };

  readonly appliedConfigHashPublisher = createAppliedConfigHashPublisher({
    hasPendingRestart: () =>
      this.operation.kind === "request" ||
      this.pausedDebt !== null ||
      this.conservativeDebt !== null,
    publish: setRuntimeConfigAppliedHash,
  });

  constructor(private readonly options: GatewayRestartCoordinatorOptions) {}

  readonly isStopped = () => this.retryStopped;
  readonly hasPendingConfigCandidate = () => this.acceptedTargetState.kind === "candidate-pending";
  readonly hasOperation = () => this.operation.kind !== "idle";
  readonly getAcceptedTarget = (): AcceptedRestartTarget | null =>
    this.acceptedTargetState.kind === "accepted" ? this.acceptedTargetState.target : null;

  recordAcceptedTarget(target: AcceptedRestartTarget): AcceptedRestartTargetOwnership {
    const generation = this.acceptedTargetState.generation + 1;
    const acceptedTarget: AcceptedRestartTarget = {
      ...target,
      prepareRuntimeConfig: async () => {
        if (this.acceptedTargetState !== acceptedState) {
          throw new GatewayConfigReloadSupersededError();
        }
        const prepared = await target.prepareRuntimeConfig();
        if (this.acceptedTargetState !== acceptedState) {
          throw new GatewayConfigReloadSupersededError();
        }
        return prepared;
      },
    };
    const acceptedState = { kind: "accepted", generation, target: acceptedTarget } as const;
    this.acceptedTargetState = acceptedState;
    return {
      reject: () => {
        const state = this.acceptedTargetState;
        const ownsAcceptedTarget =
          (state.kind === "accepted" && state.target === acceptedTarget) ||
          (state.kind === "candidate-pending" && state.previousTarget === acceptedTarget);
        if (!ownsAcceptedTarget) {
          return;
        }
        this.acceptedTargetState = {
          kind: "candidate-pending",
          generation: generation + 1,
          previousTarget: undefined,
        };
      },
    };
  }

  publishAcceptedTarget(target: AcceptedRestartTarget) {
    return {
      ownership: this.recordAcceptedTarget(target),
      conservativeDebt: this.takeConservativeDebt(),
    };
  }

  restoreConservativeDebt(debt: RestartRequestDetails): void {
    this.conservativeDebt ??= debt;
  }

  deferDebt(
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    options?: GatewayRestartRequestOptions,
  ): void {
    this.preserveDebt(this.createRequestDetails(plan, nextConfig, options));
  }

  acceptConfig(acceptedConfig?: OpenClawConfig) {
    if (this.operation.kind === "idle" || this.operation.transaction.state !== "rejected") {
      return { retireRejectedRestart: false };
    }
    if (this.operation.kind === "request" && !this.operation.emissionSettled) {
      this.preserveDebt(this.operation.details);
    }
    this.supersedeRequest();
    const configDebt = this.pausedDebt;
    const retainsConfigDebt =
      configDebt &&
      acceptedConfig &&
      configDebt.restartOwnedPaths.every((path) =>
        isDeepStrictEqual(
          getConfigValueAtPath({ ...configDebt.nextConfig }, path.split(".")),
          getConfigValueAtPath({ ...acceptedConfig }, path.split(".")),
        ),
      );
    if (!retainsConfigDebt) {
      this.pausedDebt = null;
    }
    const debt = (retainsConfigDebt ? configDebt : null) ?? this.conservativeDebt;
    return debt ? { retireRejectedRestart: false, debt } : { retireRejectedRestart: true };
  }

  retireRejectedRequest(): boolean {
    return this.acceptConfig().retireRejectedRestart;
  }

  beginLifecycle() {
    // A newer restart candidate owns the disk config now. Cancel any older
    // emission before async preflight so it cannot restart into stale secrets.
    if (
      this.operation.kind === "request" &&
      !this.operation.emissionSettled &&
      this.operation.transaction.state !== "pending"
    ) {
      this.preserveDebt(this.operation.details);
    }
    this.supersedeRequest();
    const transaction = { state: "pending" as GatewayRestartTransactionState };
    this.operation = { kind: "lifecycle", transaction };
    return {
      settle: (state: Exclude<GatewayRestartTransactionState, "pending">) => {
        if (transaction.state === "pending") {
          transaction.state = state;
          if (state === "committed") {
            this.pausedDebt = null;
          }
        }
      },
    };
  }

  pauseForConfigCandidate(): void {
    const state = this.acceptedTargetState;
    const previousTarget =
      state.kind === "accepted"
        ? state.target
        : state.kind === "candidate-pending"
          ? state.previousTarget
          : undefined;
    this.acceptedTargetState = {
      kind: "candidate-pending",
      generation: state.generation,
      previousTarget,
    };
    // Candidate acceptance owns debt rearm. Until then, invalid/failed config
    // must leave the prior committed restart paused.
    this.beginLifecycle().settle("rejected");
  }

  request(
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    options?: GatewayRestartRequestOptions,
  ): GatewayRestartTransactionResult {
    if (this.retryStopped) {
      return { status: "recovery-pending", settle: () => {} };
    }
    // Only another restart requirement supersedes accepted restart work. A
    // duplicate, hot-only, or failed config transaction must preserve it.
    this.supersedeRequest();
    const transaction = { state: "pending" as GatewayRestartTransactionState };
    this.operation = {
      kind: "request",
      transaction,
      details: this.createRequestDetails(plan, nextConfig, options),
      emissionSettled: false,
    };
    const requestGeneration = this.requestGeneration;
    const accepted = this.requestForGeneration(plan, nextConfig, requestGeneration, options);
    return {
      status: accepted ? "accepted" : "recovery-pending",
      settle: (state) => {
        if (transaction.state === "pending") {
          transaction.state = state;
        }
      },
    };
  }

  stop(): void {
    this.retryStopped = true;
    this.pausedDebt = null;
    this.conservativeDebt = null;
    this.supersedeRequest();
  }

  private createRequestDetails(
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    options?: GatewayRestartRequestOptions,
  ): RestartRequestDetails {
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
  }

  private preserveDebt(details: RestartRequestDetails): void {
    if (details.retainDebtAcrossConfigChanges) {
      this.conservativeDebt = details;
    } else {
      this.pausedDebt = details;
    }
  }

  private takeConservativeDebt(): RestartRequestDetails | null {
    const debt = this.conservativeDebt;
    this.conservativeDebt = null;
    return debt;
  }

  private markEmissionSettled(): void {
    if (this.operation.kind === "request") {
      this.operation.emissionSettled = true;
    }
    this.conservativeDebt = null;
  }

  private isCurrentRequest(requestGeneration: number): boolean {
    return (
      !this.retryStopped &&
      requestGeneration === this.requestGeneration &&
      isCurrentGatewayReloadGeneration(this.options.myGeneration)
    );
  }

  private supersedeRequest(): void {
    this.requestGeneration += 1;
    this.restartPending = false;
    this.restartDeferral?.cancel();
    this.restartDeferral = null;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.operation = { kind: "idle" };
  }

  private scheduleEmissionRetry(retry: {
    reason: string;
    intent?: GatewayRestartIntent;
    requestGeneration: number;
    prepareForEmit?: () => Promise<boolean>;
  }): void {
    if (this.retryTimer || !this.isCurrentRequest(retry.requestGeneration)) {
      return;
    }
    // Retry the exact failed emission. Re-entering request planning would start
    // a fresh idle deferral and discard a timeout's force/deadline decision.
    this.restartPending = true;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.isCurrentRequest(retry.requestGeneration)) {
        return;
      }
      // Timer callbacks outlive the config transaction root. Re-enter process
      // admission so prepared host suspension cannot race signal delivery.
      void runWithGatewayIndependentRootWorkAdmission(async () => {
        if (!this.isCurrentRequest(retry.requestGeneration)) {
          return;
        }
        this.restartPending = false;
        if (retry.prepareForEmit && !(await retry.prepareForEmit())) {
          this.scheduleEmissionRetry(retry);
          return;
        }
        const emitResult = this.options.params.requestRecoveryRestart?.(retry.reason, retry.intent);
        if (emitResult && emitResult.status !== "failed") {
          this.markEmissionSettled();
        }
        if (!emitResult || emitResult.status === "failed") {
          this.scheduleEmissionRetry(retry);
        }
      }).catch((err: unknown) => {
        if (this.isCurrentRequest(retry.requestGeneration)) {
          this.options.params.logReload.warn(
            `gateway restart recovery retry stopped: ${String(err)}`,
          );
        }
      });
    }, RESTART_EMISSION_RETRY_MS);
    this.retryTimer.unref?.();
  }

  private requestForGeneration(
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    requestGeneration: number,
    options?: GatewayRestartRequestOptions,
  ): boolean {
    const { params } = this.options;
    const reasons = plan.restartReasons.length
      ? plan.restartReasons.join(", ")
      : plan.changedPaths.join(", ");
    const restartReason = `config reload: ${reasons}`;

    if (!this.options.restartRecoveryAvailable) {
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
        await params.assertRestartReady?.();
        if (!this.isCurrentRequest(requestGeneration)) {
          return false;
        }
        const preparedConfig = options?.prepareRuntimeConfig
          ? await options.prepareRuntimeConfig()
          : nextConfig;
        if (!this.isCurrentRequest(requestGeneration)) {
          return false;
        }
        emissionPrepared = true;
        setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(preparedConfig) });
        return this.isCurrentRequest(requestGeneration);
      } catch (err) {
        emissionPrepared = false;
        params.logReload.warn(`gateway restart preflight failed: ${String(err)}`);
        return false;
      }
    };

    const active = this.options.getActiveCounts();

    if (active.totalActive > 0 || options?.prepareRuntimeConfig || params.assertRestartReady) {
      // Avoid spinning up duplicate polling loops from repeated config changes.
      if (this.restartPending) {
        params.logReload.info(
          `config change requires gateway restart (${reasons}) — already waiting for operations to complete`,
        );
        return true;
      }
      this.restartPending = true;
      if (active.totalActive > 0) {
        const initialDetails = this.options.formatActiveDetails(active);
        params.logReload.warn(
          `config change requires gateway restart (${reasons}) — deferring until ${initialDetails.join(", ")} complete`,
        );
        const taskBlockers = this.options.formatTaskBlockers();
        if (taskBlockers) {
          params.logReload.warn(
            `restart blocked by active background task run(s): ${taskBlockers}`,
          );
        }
      } else {
        params.logReload.warn(`config change requires gateway restart (${reasons}) — preparing`);
      }

      let failedEmission: { reason: string; intent?: GatewayRestartIntent } | undefined;
      this.restartDeferral = deferGatewayRestartUntilIdle({
        getPendingCount: () => this.options.getActiveCounts().totalActive,
        maxWaitMs: resolveGatewayRestartDeferralTimeoutMs(undefined),
        timeoutIntent: { force: true, reason: "config reload forced restart" },
        reason: restartReason,
        emitHooks: {
          beforeEmit: async () => {
            emissionPrepared = await prepareForEmit();
          },
          emitRestart: (reason, intent) => {
            if (!this.isCurrentRequest(requestGeneration)) {
              return { status: "coalesced" };
            }
            const resolvedReason = reason ?? restartReason;
            if (!emissionPrepared) {
              failedEmission = { reason: resolvedReason, intent };
              return { status: "failed" };
            }
            const emitResult = requestRecoveryRestart(resolvedReason, intent);
            if (emitResult.status !== "failed") {
              this.markEmissionSettled();
            }
            failedEmission =
              emitResult.status === "failed" ? { reason: resolvedReason, intent } : undefined;
            return emitResult;
          },
          afterEmitFailed: async () => {
            if (!this.isCurrentRequest(requestGeneration) || !failedEmission) {
              return;
            }
            if (!this.options.restartRecoveryAvailable) {
              params.logReload.warn("gateway restart recovery unavailable; retry skipped");
              return;
            }
            params.logReload.warn("gateway restart recovery emission failed; retrying");
            this.scheduleEmissionRetry({
              ...failedEmission,
              requestGeneration,
              prepareForEmit,
            });
          },
        },
        hooks: {
          onReady: () => {
            this.restartPending = false;
            this.restartDeferral = null;
            params.logReload.info("all operations and replies completed; restarting gateway now");
          },
          onStillPending: (_pending, elapsedMs) => {
            params.logReload.warn(
              `restart still deferred after ${elapsedMs}ms with ${this.options.formatDeferredWorkStatus("active")}`,
            );
          },
          onTimeout: (_pending, elapsedMs) => {
            this.restartPending = false;
            this.restartDeferral = null;
            params.logReload.warn(
              `restart timeout after ${elapsedMs}ms with ${this.options.formatDeferredWorkStatus("still active")}; forcing restart`,
            );
          },
          onCheckError: (err) => {
            this.restartPending = false;
            this.restartDeferral = null;
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
      this.markEmissionSettled();
    }
    if (emitResult.status === "failed") {
      params.logReload.warn("gateway restart recovery emission failed");
      if (this.options.restartRecoveryAvailable) {
        this.scheduleEmissionRetry({
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
  }
}

export function createGatewayRestartCoordinator(options: GatewayRestartCoordinatorOptions) {
  const transaction = new GatewayRestartTransaction(options);
  return {
    acceptRestartConfig: (config?: OpenClawConfig) => transaction.acceptConfig(config),
    ...transaction.appliedConfigHashPublisher,
    beginGatewayRestartLifecycle: () => transaction.beginLifecycle(),
    pauseGatewayRestartForConfigCandidate: () => transaction.pauseForConfigCandidate(),
    publishAcceptedRestartTarget: (target: AcceptedRestartTarget) =>
      transaction.publishAcceptedTarget(target),
    recordAcceptedRestartTarget: (target: AcceptedRestartTarget) =>
      transaction.recordAcceptedTarget(target),
    requestGatewayRestart: (
      plan: GatewayReloadPlan,
      nextConfig: OpenClawConfig,
      requestOptions?: GatewayRestartRequestOptions,
    ) => transaction.request(plan, nextConfig, requestOptions),
    restoreConservativeRestartDebt: (debt: RestartRequestDetails) =>
      transaction.restoreConservativeDebt(debt),
    retireRejectedRestartRequest: () => transaction.retireRejectedRequest(),
    stopRestartRetries: () => transaction.stop(),
    deferGatewayRestartDebt: (
      plan: GatewayReloadPlan,
      nextConfig: OpenClawConfig,
      requestOptions?: GatewayRestartRequestOptions,
    ) => transaction.deferDebt(plan, nextConfig, requestOptions),
    getLatestAcceptedRestartTarget: transaction.getAcceptedTarget,
    hasConfigCandidatePending: transaction.hasPendingConfigCandidate,
    hasRestartRequestTransaction: transaction.hasOperation,
    isRestartRetryStopped: transaction.isStopped,
  };
}
