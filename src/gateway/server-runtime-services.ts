// Gateway post-ready runtime services.
// Starts delayed maintenance, cron, heartbeat, recovery, and pricing refresh work.
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { computeBackoffMs } from "../infra/delivery-recovery.shared.js";
import {
  resolveHeartbeatAgents,
  startHeartbeatRunner,
  type HeartbeatRunner,
  runHeartbeatOnce,
} from "../infra/heartbeat-runner.js";
import { resolveHeartbeatIntervalMs } from "../infra/heartbeat-summary.js";
import type { DeliverOutboundPayloadsParams } from "../infra/outbound/deliver.js";
import {
  schedulePendingSessionDeliveries,
  startSessionDeliveryRuntime,
} from "../infra/session-delivery-queue-runtime.js";
import {
  isGatewayWorkAdmissionClosed,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { startSessionUpstreamMonitor } from "../sessions/session-upstream-monitor.js";
import { assertQueuedConversationDeliveryAttemptAuthorized } from "./conversation-route-ownership.js";
import { resolveGatewayPluginConfig } from "./runtime-plugin-config.js";
import {
  fenceScheduledGatewayContextResolver,
  runWithScheduledGatewayContext,
} from "./scheduled-run-gateway-context.js";
import type { GatewayCronReconciliation } from "./server-cron-reconciled.js";
import type { GatewayCronState } from "./server-cron.js";
import type { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import {
  createNoopHeartbeatRunner,
  type GatewayRuntimeServiceLogger,
} from "./server-runtime-service-shared.js";
export { scheduleGatewayIdleTask, type GatewayIdleTaskHandle } from "./server-idle-task.js";
export {
  startGatewayChannelHealthMonitor,
  startGatewayRuntimeServices,
  type GatewayChannelManager,
} from "./server-runtime-startup-services.js";

type GatewayPostReadyLogger = {
  warn: (message: string) => void;
};
export type GatewayMaintenanceHandles = NonNullable<
  Awaited<ReturnType<typeof startGatewayMaintenanceTimers>>
>;

/** Starts cron without making the surrounding startup or reload transaction wait. */
export function startGatewayCronWithLogging(params: {
  cronState: GatewayCronState;
  cronReconciliation: GatewayCronReconciliation;
  reason: "startup" | "reload";
  config: OpenClawConfig;
  afterStart?: () => Promise<void>;
  onStartError?: (error: unknown) => void;
  logCron: { error: (message: string) => void };
}): void {
  const reconciliation = params.cronReconciliation.arm({
    reason: params.reason,
    config: params.config,
    cronState: params.cronState,
  });
  void runWithGatewayIndependentRootWorkAdmission(async () => {
    try {
      await params.cronState.cron.start();
      await params.afterStart?.();
      await reconciliation.complete();
    } catch (err) {
      params.logCron.error(`failed to start: ${String(err)}`);
      // Recovery callbacks must run before this independent root releases its
      // admission fence; restart and suspension cannot race past this point.
      params.onStartError?.(err);
    }
  }).catch((err: unknown) => params.logCron.error(`failed to enter start root: ${String(err)}`));
}

async function clearGatewayMaintenanceHandles(
  maintenance: GatewayMaintenanceHandles | null,
): Promise<void> {
  if (!maintenance) {
    return;
  }
  // Maintenance startup can race shutdown. Stop every owner here and wait for
  // in-flight media work before discarding its state directory and SQLite handles.
  clearInterval(maintenance.tickInterval);
  clearInterval(maintenance.healthInterval);
  clearInterval(maintenance.dedupeCleanup);
  await maintenance.stopMediaCleanup();
  clearInterval(maintenance.worktreeCleanup);
  maintenance.skillCuratorCleanup();
}

/** Runs maintenance that is intentionally delayed until after the gateway is ready. */
export async function runGatewayPostReadyMaintenance(params: {
  startMaintenance: () => Promise<GatewayMaintenanceHandles | null>;
  applyMaintenance: (maintenance: GatewayMaintenanceHandles) => Promise<void> | void;
  shouldStartCron: () => boolean;
  markCronStartHandled: () => void;
  cronState: GatewayCronState;
  cronReconciliation: GatewayCronReconciliation;
  cronConfig: OpenClawConfig;
  logCron: { error: (message: string) => void };
  log: GatewayPostReadyLogger;
  recordPostReadyMemory: () => void;
}): Promise<void> {
  try {
    const maintenance = await params.startMaintenance();
    if (maintenance) {
      await params.applyMaintenance(maintenance);
    }
  } catch (err) {
    params.log.warn(`gateway post-ready maintenance startup failed: ${String(err)}`);
  }
  if (params.shouldStartCron()) {
    params.markCronStartHandled();
    startGatewayCronWithLogging({
      cronState: params.cronState,
      cronReconciliation: params.cronReconciliation,
      reason: "startup",
      config: params.cronConfig,
      logCron: params.logCron,
    });
  }
  params.recordPostReadyMemory();
}

/** Schedules post-ready maintenance and cancels/cleans handles if shutdown wins the race. */
export function scheduleGatewayPostReadyMaintenance(params: {
  delayMs: number;
  isClosing: () => boolean;
  onStarted?: () => void;
  startMaintenance: () => Promise<GatewayMaintenanceHandles | null>;
  applyMaintenance: (maintenance: GatewayMaintenanceHandles) => Promise<void> | void;
  shouldStartCron: () => boolean;
  markCronStartHandled: () => void;
  cronState: GatewayCronState;
  cronReconciliation: GatewayCronReconciliation;
  cronConfig: OpenClawConfig;
  logCron: { error: (message: string) => void };
  log: GatewayPostReadyLogger;
  recordPostReadyMemory: () => void;
}): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    params.onStarted?.();
    if (params.isClosing()) {
      return;
    }
    void runWithGatewayIndependentRootWorkAdmission(async () =>
      runGatewayPostReadyMaintenance({
        startMaintenance: async () => {
          if (params.isClosing()) {
            return null;
          }
          const maintenance = await params.startMaintenance();
          if (params.isClosing()) {
            // Maintenance can allocate intervals before shutdown is observed; clear them here
            // instead of handing live timers to a closing gateway.
            await clearGatewayMaintenanceHandles(maintenance);
            return null;
          }
          return maintenance;
        },
        applyMaintenance: async (maintenance) => {
          if (params.isClosing()) {
            await clearGatewayMaintenanceHandles(maintenance);
            return;
          }
          await params.applyMaintenance(maintenance);
        },
        shouldStartCron: () => !params.isClosing() && params.shouldStartCron(),
        markCronStartHandled: params.markCronStartHandled,
        cronState: params.cronState,
        cronReconciliation: params.cronReconciliation,
        cronConfig: params.cronConfig,
        logCron: params.logCron,
        log: params.log,
        recordPostReadyMemory: () => {
          if (!params.isClosing()) {
            params.recordPostReadyMemory();
          }
        },
      }),
    ).catch((err: unknown) =>
      params.log.warn(`gateway post-ready maintenance deferred task failed: ${String(err)}`),
    );
  }, params.delayMs);
  timer.unref?.();
  return timer;
}

const RECOVERY_SHUTDOWN_STILL_PENDING_WARN_MS = 5_000;

function startPendingOutboundDeliveryRecovery(params: {
  cfg: OpenClawConfig;
  log: GatewayRuntimeServiceLogger;
}): () => Promise<void> {
  let stopped = false;
  let migrationPending = true;
  let initialPass = true;
  let inFlight: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let logRecovery: ReturnType<GatewayRuntimeServiceLogger["child"]> | undefined;

  const recover = (): void => {
    if (stopped || inFlight || isGatewayWorkAdmissionClosed()) {
      return;
    }
    const recovery = runWithGatewayIndependentRootWorkAdmission(async () => {
      if (stopped) {
        return;
      }
      const { drainPendingDeliveriesCore, recoverPendingDeliveries } =
        await import("../infra/outbound/delivery-queue-recovery.js");
      const { deliverOutboundPayloadsInternal } = await import("../infra/outbound/deliver.js");
      if (stopped) {
        return;
      }
      const deliverWithCurrentConversationAuthority = async (
        deliveryParams: DeliverOutboundPayloadsParams,
      ) => {
        const completion = deliveryParams.deliveryCompletion;
        const attemptAuthority =
          completion?.kind === "conversation"
            ? completion
            : deliveryParams.conversationDeliveryAttemptAuthority;
        if (!attemptAuthority) {
          return await deliverOutboundPayloadsInternal(deliveryParams);
        }
        return await deliverOutboundPayloadsInternal({
          ...deliveryParams,
          onDeliveryAttempt: async () => {
            await deliveryParams.onDeliveryAttempt?.();
            if (!attemptAuthority.routeFingerprint) {
              return;
            }
            assertQueuedConversationDeliveryAttemptAuthorized({
              config: resolveGatewayPluginConfig({ config: getRuntimeConfig() }),
              agentId: attemptAuthority.agentId,
              operationId: attemptAuthority.operationId,
              ...(attemptAuthority.storePath ? { storePath: attemptAuthority.storePath } : {}),
              routeFingerprint: attemptAuthority.routeFingerprint,
            });
          },
        });
      };
      logRecovery ??= params.log.child("delivery-recovery");
      if (migrationPending) {
        const cfg = initialPass ? params.cfg : getRuntimeConfig();
        initialPass = false;
        const { migrateLegacyPendingOutboundDeliveries } =
          await import("../infra/outbound/delivery-queue-migration.js");
        const migration = await migrateLegacyPendingOutboundDeliveries({
          cfg,
          log: logRecovery,
        });
        // A new scheduled-service lifecycle starts unchecked. Latch only after
        // one pass neither skipped ownership nor left retired rows behind.
        migrationPending = migration.skipped > 0 || migration.remaining > 0;
        await recoverPendingDeliveries({
          deliver: deliverWithCurrentConversationAuthority,
          log: logRecovery,
          cfg,
        });
        return;
      }
      // Normal retries use fresh config so revoked accounts cannot inherit the
      // authority captured at gateway startup.
      await drainPendingDeliveriesCore({
        drainKey: "gateway:outbound",
        logLabel: "Outbound delivery retry",
        cfg: getRuntimeConfig(),
        log: logRecovery,
        deliver: deliverWithCurrentConversationAuthority,
        selectEntry: () => ({ match: true, bypassBackoff: false }),
      });
    }).catch((err: unknown) => params.log.error(`Delivery recovery failed: ${String(err)}`));
    const settled: Promise<void> = recovery.finally(() => {
      if (inFlight === settled) {
        inFlight = null;
      }
    });
    inFlight = settled;
  };

  // Match the queue's first backoff window without holding admission between
  // ticks; otherwise suspended/restarting gateways retain invisible work.
  const retryTimer = setInterval(recover, computeBackoffMs(1));
  retryTimer.unref?.();
  recover();
  return () => {
    stopped = true;
    clearInterval(retryTimer);
    if (stopPromise) {
      return stopPromise;
    }
    const recovery = inFlight;
    if (!recovery) {
      stopPromise = Promise.resolve();
      return stopPromise;
    }
    const stillPendingTimer = setTimeout(() => {
      (logRecovery ??= params.log.child("delivery-recovery")).warn(
        `delivery recovery is still pending after ${RECOVERY_SHUTDOWN_STILL_PENDING_WARN_MS}ms; waiting before runtime teardown`,
      );
    }, RECOVERY_SHUTDOWN_STILL_PENDING_WARN_MS);
    stillPendingTimer.unref?.();
    // Provider dispatch is not generically cancellable. Keep its runtime alive
    // until the admitted recovery settles; the process watchdog owns forced exit.
    stopPromise = recovery.finally(() => {
      clearTimeout(stillPendingTimer);
    });
    return stopPromise;
  };
}

function startPendingSessionDeliveryRuntime(params: {
  deps: import("../cli/deps.types.js").CliDeps;
  log: GatewayRuntimeServiceLogger;
  maxEnqueuedAt: number;
  resolveGatewayContext?: GatewayContextResolver;
}): () => void {
  let stopped = false;
  let stopRuntime: (() => void) | undefined;
  // Delay session continuation recovery so the gateway has time to publish ready state and
  // request routing before replaying restart-sentinel deliveries.
  const timer = setTimeout(() => {
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      const {
        deliverQueuedSessionDelivery,
        recoverPendingRestartContinuationDeliveries,
        settleQueuedSessionDelivery,
      } = await import("./server-restart-sentinel.js");
      if (stopped) {
        return;
      }
      const logRecovery = params.log.child("session-delivery-recovery");
      stopRuntime = startSessionDeliveryRuntime({
        deliver: (entry, context = {}) =>
          deliverQueuedSessionDelivery({
            deps: params.deps,
            entry,
            ...(context.stateDir !== undefined ? { stateDir: context.stateDir } : {}),
            ...(params.resolveGatewayContext
              ? { resolveGatewayContext: params.resolveGatewayContext }
              : {}),
          }),
        log: logRecovery,
        onSettled: settleQueuedSessionDelivery,
      });
      try {
        await recoverPendingRestartContinuationDeliveries({
          deps: params.deps,
          log: logRecovery,
          maxEnqueuedAt: params.maxEnqueuedAt,
          ...(params.resolveGatewayContext
            ? { resolveGatewayContext: params.resolveGatewayContext }
            : {}),
        });
      } finally {
        // Recovery and scheduling are independent safeguards. A transient
        // recovery failure must not leave persisted rows without timers.
        await schedulePendingSessionDeliveries();
      }
    }).catch((err: unknown) =>
      params.log.error(`Session delivery recovery failed: ${String(err)}`),
    );
  }, 1_250);
  timer.unref?.();
  return () => {
    stopped = true;
    clearTimeout(timer);
    stopRuntime?.();
    stopRuntime = undefined;
  };
}

/** Activates background gateway services after core runtime startup is ready. */
export function activateGatewayScheduledServices(params: {
  minimalTestGateway: boolean;
  cfgAtStart: OpenClawConfig;
  deps: import("../cli/deps.types.js").CliDeps;
  sessionDeliveryRecoveryMaxEnqueuedAt: number;
  cronState: GatewayCronState;
  cronReconciliation: GatewayCronReconciliation;
  startCron?: boolean;
  logCron: { error: (message: string) => void };
  log: GatewayRuntimeServiceLogger;
  resolveGatewayContext?: GatewayContextResolver;
}): { heartbeatRunner: HeartbeatRunner; stopOutboundDeliveryRecovery: () => Promise<void> } {
  if (params.minimalTestGateway) {
    // Minimal gateways keep handles callable but inert so tests can share shutdown paths with
    // production starts without launching background loops.
    return {
      heartbeatRunner: createNoopHeartbeatRunner(),
      stopOutboundDeliveryRecovery: async () => {},
    };
  }
  if (
    !params.cronState.cronEnabled &&
    resolveHeartbeatAgents(params.cfgAtStart).some((agent) =>
      Boolean(resolveHeartbeatIntervalMs(params.cfgAtStart, undefined, agent.heartbeat)),
    )
  ) {
    params.log
      .child("heartbeat")
      .warn(
        "scheduled heartbeats are disabled because the cron scheduler is disabled; enable cron and restart the gateway",
      );
  }
  // Scheduled heartbeat wakes fire from a timer with no Gateway request, so
  // without this the turn runs contextless and trusted built-in tools fail.
  const heartbeatGatewayContextResolver = fenceScheduledGatewayContextResolver(
    params.resolveGatewayContext,
  );
  const heartbeatRunner = startHeartbeatRunner({
    cfg: params.cfgAtStart,
    readCurrentConfig: getRuntimeConfig,
    ...(heartbeatGatewayContextResolver
      ? {
          runOnce: async (opts: Parameters<typeof runHeartbeatOnce>[0]) =>
            await runWithScheduledGatewayContext({
              resolveGatewayContext: heartbeatGatewayContextResolver,
              run: async () => await runHeartbeatOnce(opts),
            }),
        }
      : {}),
  });
  const sessionUpstreamMonitor = startSessionUpstreamMonitor();
  const stopSessionDeliveryRuntime = startPendingSessionDeliveryRuntime({
    deps: params.deps,
    log: params.log,
    maxEnqueuedAt: params.sessionDeliveryRecoveryMaxEnqueuedAt,
    ...(params.resolveGatewayContext
      ? { resolveGatewayContext: params.resolveGatewayContext }
      : {}),
  });
  if (params.startCron !== false) {
    startGatewayCronWithLogging({
      cronState: params.cronState,
      cronReconciliation: params.cronReconciliation,
      reason: "startup",
      config: params.cfgAtStart,
      logCron: params.logCron,
    });
  }
  const stopOutboundDeliveryRecovery = startPendingOutboundDeliveryRecovery({
    cfg: params.cfgAtStart,
    log: params.log,
  });
  const heartbeatRunnerWithUpstreamMonitor: HeartbeatRunner = {
    updateConfig: heartbeatRunner.updateConfig,
    stop: () => {
      void stopOutboundDeliveryRecovery();
      stopSessionDeliveryRuntime();
      sessionUpstreamMonitor.stop();
      heartbeatRunner.stop();
    },
  };
  return {
    heartbeatRunner: heartbeatRunnerWithUpstreamMonitor,
    stopOutboundDeliveryRecovery,
  };
}
