// Gateway channel health monitor.
// Periodically evaluates channel account health and restarts stale runtimes.
import type { ChannelId } from "../channels/plugins/types.public.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
  resolveChannelRestartReason,
  type ChannelHealthPolicy,
} from "./channel-health-policy.js";
import type { ChannelManager } from "./server-channels.js";

const log = createSubsystemLogger("gateway/health-monitor");

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MONITOR_STARTUP_GRACE_MS = 60_000;
const DEFAULT_COOLDOWN_CYCLES = 2;
const DEFAULT_MAX_RESTARTS_PER_HOUR = 10;
const CHANNEL_HEALTH_MONITOR_HANDOFF_TIMEOUT_MS = 5_000;
const ONE_HOUR_MS = 60 * 60_000;

/**
 * How long a connected channel can go without proven transport activity before
 * the health monitor treats it as a "stale socket" and triggers a restart.
 * Providers should only publish that timestamp from transport/heartbeat/poll
 * signals, not from ordinary app messages.
 */
type ChannelHealthTimingPolicy = {
  monitorStartupGraceMs: number;
  channelConnectGraceMs: number;
  staleEventThresholdMs: number;
};

type ChannelHealthMonitorDeps = {
  channelManager: ChannelManager;
  checkIntervalMs?: number;
  timing?: Partial<ChannelHealthTimingPolicy>;
  cooldownCycles?: number;
  maxRestartsPerHour?: number;
  abortSignal?: AbortSignal;
};

export type ChannelHealthMonitor = {
  stop: () => void;
  shutdown: () => void;
  waitForIdle: () => Promise<void>;
};

type RestartRecord = {
  lastRestartAt: number;
  restartsThisHour: { at: number }[];
  // True once the free pending-continuation pass ran; cleared when the account
  // leaves the pending-restart state so the next recovery earns a new pass.
  pendingContinuationUsed?: boolean;
};

function resolveTimingPolicy(
  deps: Pick<ChannelHealthMonitorDeps, "timing">,
): ChannelHealthTimingPolicy {
  return {
    monitorStartupGraceMs: deps.timing?.monitorStartupGraceMs ?? DEFAULT_MONITOR_STARTUP_GRACE_MS,
    channelConnectGraceMs: deps.timing?.channelConnectGraceMs ?? DEFAULT_CHANNEL_CONNECT_GRACE_MS,
    staleEventThresholdMs:
      deps.timing?.staleEventThresholdMs ?? DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  };
}

/** Start the periodic channel health monitor and return its stop handle. */
export function startChannelHealthMonitor(deps: ChannelHealthMonitorDeps): ChannelHealthMonitor {
  const {
    channelManager,
    cooldownCycles = DEFAULT_COOLDOWN_CYCLES,
    maxRestartsPerHour = DEFAULT_MAX_RESTARTS_PER_HOUR,
    abortSignal,
  } = deps;
  const checkIntervalMs = resolveTimerTimeoutMs(deps.checkIntervalMs, DEFAULT_CHECK_INTERVAL_MS);
  const timing = resolveTimingPolicy(deps);

  const cooldownMs = cooldownCycles * checkIntervalMs;
  const restartRecords = new Map<string, RestartRecord>();
  const startedAt = Date.now();
  let stopped = false;
  let abandonInFlightRestart = false;
  let activeCheck: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const suppressedAccounts = new Set<string>();

  const rKey = (channelId: string, accountId: string) => `${channelId}:${accountId}`;

  function pruneOldRestarts(record: RestartRecord, now: number) {
    record.restartsThisHour = record.restartsThisHour.filter((r) => now - r.at < ONE_HOUR_MS);
  }

  async function runCheckWork() {
    try {
      const now = Date.now();
      if (now - startedAt < timing.monitorStartupGraceMs) {
        return;
      }

      const snapshot = channelManager.getRuntimeSnapshot();
      const globalAutostartSuppression = channelManager.getAutostartSuppression();

      for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
        if (!accounts) {
          continue;
        }
        const autostartSuppressed =
          globalAutostartSuppression !== null ||
          channelManager.isAmbientAutostartSuppressed(channelId);
        for (const [accountId, status] of Object.entries(accounts)) {
          // A replacement monitor owns future accounts. The retired monitor may
          // only finish the restart it had already begun.
          if (stopped) {
            return;
          }
          if (!status) {
            continue;
          }
          if (!channelManager.isHealthMonitorEnabled(channelId as ChannelId, accountId)) {
            continue;
          }
          if (channelManager.isManuallyStopped(channelId as ChannelId, accountId)) {
            continue;
          }
          const key = rKey(channelId, accountId);
          if (autostartSuppressed) {
            if (status.running !== true && !suppressedAccounts.has(key)) {
              log.info?.(
                `[${channelId}:${accountId}] health-monitor: channel autostart suppressed; treating as expected stopped`,
              );
              suppressedAccounts.add(key);
            }
            continue;
          }
          suppressedAccounts.delete(key);
          const pendingRestartState =
            status.running !== true &&
            status.restartPending === true &&
            (status.reconnectAttempts ?? 0) === 0;
          // Clear only on genuine recovery (running or pending flag dropped);
          // a transient reconnectAttempts bump while still stuck pending must
          // not re-arm the free continuation pass.
          const leftPendingRestart = status.running === true || status.restartPending !== true;
          const trackedRecord = restartRecords.get(key);
          if (trackedRecord?.pendingContinuationUsed && leftPendingRestart) {
            trackedRecord.pendingContinuationUsed = false;
          }
          const healthPolicy: ChannelHealthPolicy = {
            channelId,
            now,
            staleEventThresholdMs: timing.staleEventThresholdMs,
            channelConnectGraceMs: timing.channelConnectGraceMs,
          };
          const health = evaluateChannelHealth(status, healthPolicy);
          if (health.healthy) {
            continue;
          }
          if (health.reason === "terminal-disconnect") {
            log.info?.(
              `[${channelId}:${accountId}] health-monitor: skipping restart, terminal disconnect`,
            );
            continue;
          }
          // The channel supervisor owns the account while its own backoff restart
          // is in flight. Restarting here cannot start anything (the supervisor
          // still holds the account task) and only resets the attempt ladder, so
          // a crash-looping channel would never reach its give-up terminal state.
          if (channelManager.isAutoRestartScheduled(channelId as ChannelId, accountId)) {
            continue;
          }

          const record = restartRecords.get(key) ?? {
            lastRestartAt: 0,
            restartsThisHour: [],
          };

          // A timed-out recovery stop uses the first start request to mark
          // restartPending; the next monitor pass must finish that same recovery
          // instead of waiting behind this monitor's fresh-restart cooldown.
          // Only one continuation is free: an account stuck in restartPending
          // rejoins cooldown + hourly budget so it cannot thrash forever (#105189).
          const continuingPendingRestart =
            pendingRestartState && record.pendingContinuationUsed !== true;

          if (!continuingPendingRestart && now - record.lastRestartAt <= cooldownMs) {
            continue;
          }

          pruneOldRestarts(record, now);
          if (!continuingPendingRestart && record.restartsThisHour.length >= maxRestartsPerHour) {
            log.warn?.(
              `[${channelId}:${accountId}] health-monitor: hit ${maxRestartsPerHour} restarts/hour limit, skipping`,
            );
            continue;
          }

          const reason = resolveChannelRestartReason(status, health);

          log.info?.(`[${channelId}:${accountId}] health-monitor: restarting (reason: ${reason})`);

          if (continuingPendingRestart) {
            record.pendingContinuationUsed = true;
          } else {
            record.lastRestartAt = now;
            record.restartsThisHour.push({ at: now });
          }
          restartRecords.set(key, record);

          try {
            if (status.running) {
              await channelManager.stopChannel(channelId as ChannelId, accountId, {
                manual: false,
              });
            }
            // Shutdown owns channel teardown, so a stop that completes after the
            // shutdown handoff must not resurrect the channel.
            if (abandonInFlightRestart) {
              return;
            }
            channelManager.resetRestartAttempts(channelId as ChannelId, accountId);
            await channelManager.startChannel(channelId as ChannelId, accountId);
          } catch (err) {
            log.error?.(
              `[${channelId}:${accountId}] health-monitor: restart failed: ${String(err)}`,
            );
          }
        }
      }
    } catch (err) {
      log.error?.(`health-monitor: check failed: ${String(err)}`);
    }
  }

  function runCheck(): Promise<void> {
    if (stopped) {
      return Promise.resolve();
    }
    if (activeCheck) {
      return activeCheck;
    }
    const check = runCheckWork().finally(() => {
      if (activeCheck === check) {
        activeCheck = null;
      }
      if (stopped) {
        abortSignal?.removeEventListener("abort", shutdown);
      }
    });
    activeCheck = check;
    return check;
  }

  function scheduleCheck(delayMs: number) {
    timer = setTimeout(() => {
      timer = null;
      void runCheck().finally(() => {
        if (!stopped) {
          scheduleCheck(checkIntervalMs);
        }
      });
    }, delayMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  }

  function retire(abandonRestart: boolean) {
    stopped = true;
    abandonInFlightRestart ||= abandonRestart;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!activeCheck) {
      abortSignal?.removeEventListener("abort", shutdown);
    }
  }

  const stop = () => retire(false);
  const shutdown = () => retire(true);
  const waitForIdle = async () => {
    const check = activeCheck;
    if (!check) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      check.then(() => "idle" as const),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), CHANNEL_HEALTH_MONITOR_HANDOFF_TIMEOUT_MS);
        if (typeof timeout === "object" && "unref" in timeout) {
          timeout.unref();
        }
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (outcome === "timeout") {
      // A late provider stop must not block lifecycle ownership or restart after
      // the replacement/shutdown handoff has already continued.
      shutdown();
      log.warn?.(
        `health-monitor handoff exceeded ${CHANNEL_HEALTH_MONITOR_HANDOFF_TIMEOUT_MS}ms; abandoning delayed restart`,
      );
    }
  };

  if (abortSignal?.aborted) {
    stopped = true;
    abandonInFlightRestart = true;
  } else {
    abortSignal?.addEventListener("abort", shutdown, { once: true });
    // One lifecycle-owned timer runs first when startup grace expires, then rearms only after
    // each check settles so slow provider recovery cannot overlap the next evaluation.
    scheduleCheck(resolveTimerTimeoutMs(timing.monitorStartupGraceMs, 0, 0));
    log.info?.(
      `started (interval: ${Math.round(checkIntervalMs / 1000)}s, startup-grace: ${Math.round(timing.monitorStartupGraceMs / 1000)}s, channel-connect-grace: ${Math.round(timing.channelConnectGraceMs / 1000)}s)`,
    );
  }

  return { stop, shutdown, waitForIdle };
}
