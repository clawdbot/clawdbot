// Restart health probes for gateway service restarts and port listener recovery.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PluginHealthErrorSummary } from "../../commands/health.types.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayService } from "../../daemon/service.js";
import { classifyPortListener, inspectPortUsage, type PortUsage } from "../../infra/ports.js";
import {
  hasActiveStartupMigrationLease,
  STARTUP_MIGRATION_LEASE_TTL_MS,
} from "../../infra/startup-migration-checkpoint.js";
import { sleep } from "../../utils.js";
import {
  confirmGatewayReachable,
  resolveGatewayRestartProbeAuth,
  type GatewayReachability,
  type GatewayRestartProbeAuth,
} from "./restart-health-probe.js";
import {
  DEFAULT_RESTART_HEALTH_ATTEMPTS,
  DEFAULT_RESTART_HEALTH_DELAY_MS,
} from "./restart-health.constants.js";
import type { GatewayRestartSnapshot, GatewayRestartWaitOutcome } from "./restart-health.types.js";
import { hasListenerAttributionGap, listenerOwnedByRuntimePid } from "./restart-port-ownership.js";
export {
  DEFAULT_RESTART_HEALTH_ATTEMPTS,
  DEFAULT_RESTART_HEALTH_DELAY_MS,
} from "./restart-health.constants.js";
export {
  renderGatewayPortHealthDiagnostics,
  renderRestartDiagnostics,
} from "./restart-health-diagnostics.js";
export { waitForGatewayHealthyListener } from "./restart-health-external.js";
export type {
  GatewayPortHealthSnapshot,
  GatewayRestartSnapshot,
  GatewayRestartWaitOutcome,
} from "./restart-health.types.js";
export { terminateStaleGatewayPids } from "./restart-stale-pids.js";

const STARTUP_MIGRATION_ACTIVITY_POLL_MS = 5_000;
const STOPPED_FREE_EARLY_EXIT_GRACE_MS = 10_000;
const WINDOWS_STOPPED_FREE_EARLY_EXIT_GRACE_MS = 90_000;

function applyExpectedVersion(
  snapshot: GatewayRestartSnapshot,
  expectedVersion: string | undefined,
): GatewayRestartSnapshot {
  if (!expectedVersion) {
    return snapshot;
  }
  if (snapshot.gatewayVersion === expectedVersion) {
    return { ...snapshot, expectedVersion };
  }
  if (snapshot.gatewayVersion == null) {
    return { ...snapshot, healthy: false, expectedVersion };
  }
  return {
    ...snapshot,
    healthy: false,
    expectedVersion,
    versionMismatch: {
      expected: expectedVersion,
      actual: snapshot.gatewayVersion ?? null,
    },
  };
}

function applyActivatedPluginErrors(snapshot: GatewayRestartSnapshot): GatewayRestartSnapshot {
  if (!snapshot.activatedPluginErrors?.length) {
    return snapshot;
  }
  return { ...snapshot, healthy: false };
}

function applyChannelProbeErrors(snapshot: GatewayRestartSnapshot): GatewayRestartSnapshot {
  if (!snapshot.channelProbeErrors?.length) {
    return snapshot;
  }
  return { ...snapshot, healthy: false };
}

export async function inspectGatewayRestart(params: {
  service: GatewayService;
  port: number;
  env?: NodeJS.ProcessEnv;
  expectedVersion?: string | null;
  includeUnknownListenersAsStale?: boolean;
  probeAuth?: GatewayRestartProbeAuth;
}): Promise<GatewayRestartSnapshot> {
  const env = params.env ?? process.env;
  const expectedVersion = normalizeOptionalString(params.expectedVersion);
  let reachability: GatewayReachability | null = null;
  let activatedPluginErrors: PluginHealthErrorSummary[] = [];
  let channelProbeErrors: Array<{ id: string; error: string }> = [];
  const loadReachability = async () => {
    if (!reachability) {
      reachability = await confirmGatewayReachable({
        port: params.port,
        includeHealthDetails: Boolean(expectedVersion),
        auth: params.probeAuth,
        env,
      });
      activatedPluginErrors = reachability.activatedPluginErrors;
      channelProbeErrors = reachability.channelProbeErrors;
    }
    return reachability;
  };
  let runtime: GatewayServiceRuntime = { status: "unknown" };
  try {
    runtime = await params.service.readRuntime(env);
  } catch (err) {
    runtime = { status: "unknown", detail: String(err) };
  }

  let portUsage: PortUsage;
  try {
    portUsage = await inspectPortUsage(params.port);
  } catch (err) {
    portUsage = {
      port: params.port,
      status: "unknown",
      listeners: [],
      hints: [],
      errors: [String(err)],
    };
  }

  if (portUsage.status === "busy" && runtime.status !== "running") {
    try {
      const reachable = await loadReachability();
      if (reachable.reachable) {
        return applyChannelProbeErrors(
          applyActivatedPluginErrors(
            applyExpectedVersion(
              {
                runtime,
                portUsage,
                healthy: true,
                staleGatewayPids: [],
                gatewayVersion: reachable.gatewayVersion,
                ...(reachable.activatedPluginErrors.length > 0
                  ? { activatedPluginErrors: reachable.activatedPluginErrors }
                  : {}),
                ...(reachable.channelProbeErrors.length > 0
                  ? { channelProbeErrors: reachable.channelProbeErrors }
                  : {}),
              },
              expectedVersion,
            ),
          ),
        );
      }
    } catch {
      // Probe is best-effort; keep the ownership-based diagnostics.
    }
  }

  const gatewayListeners =
    portUsage.status === "busy"
      ? portUsage.listeners.filter(
          (listener) => classifyPortListener(listener, params.port) === "gateway",
        )
      : [];
  const fallbackListenerPids =
    params.includeUnknownListenersAsStale &&
    process.platform === "win32" &&
    runtime.status !== "running" &&
    portUsage.status === "busy"
      ? portUsage.listeners
          .filter((listener) => classifyPortListener(listener, params.port) === "unknown")
          .map((listener) => listener.pid)
          .filter((pid): pid is number => Number.isFinite(pid))
      : [];
  const running = runtime.status === "running";
  const runtimePid = runtime.pid;
  const listenerAttributionGap = hasListenerAttributionGap(portUsage);
  const ownsPort =
    runtimePid != null
      ? portUsage.listeners.some((listener) =>
          listenerOwnedByRuntimePid({ listener, runtimePid }),
        ) || listenerAttributionGap
      : gatewayListeners.length > 0 || listenerAttributionGap;
  let healthy = running && ownsPort;
  let gatewayVersion: string | null | undefined;
  if (expectedVersion && healthy && portUsage.status === "busy") {
    try {
      const reachable = await loadReachability();
      healthy = reachable.reachable;
      gatewayVersion = reachable.gatewayVersion;
      if (reachable.activatedPluginErrors.length > 0) {
        healthy = false;
      }
      if (reachable.channelProbeErrors.length > 0) {
        healthy = false;
      }
    } catch {
      healthy = false;
    }
  }
  if (!healthy && running && portUsage.status === "busy" && !expectedVersion) {
    try {
      const reachable = await loadReachability();
      healthy = reachable.reachable;
      gatewayVersion = reachable.gatewayVersion;
    } catch {
      // best-effort probe
    }
  }
  const staleGatewayPids = Array.from(
    new Set([
      ...gatewayListeners
        .filter((listener) => Number.isFinite(listener.pid))
        .filter((listener) => {
          if (!running) {
            return true;
          }
          if (runtimePid == null) {
            return false;
          }
          return !listenerOwnedByRuntimePid({ listener, runtimePid });
        })
        .map((listener) => listener.pid as number),
      ...fallbackListenerPids.filter(
        (pid) => runtime.pid == null || pid !== runtime.pid || !running,
      ),
    ]),
  );

  return applyChannelProbeErrors(
    applyActivatedPluginErrors(
      applyExpectedVersion(
        {
          runtime,
          portUsage,
          healthy,
          staleGatewayPids,
          ...(gatewayVersion !== undefined ? { gatewayVersion } : {}),
          ...(activatedPluginErrors.length ? { activatedPluginErrors } : {}),
          ...(channelProbeErrors.length ? { channelProbeErrors } : {}),
        },
        expectedVersion,
      ),
    ),
  );
}

function shouldEarlyExitStoppedFree(
  snapshot: GatewayRestartSnapshot,
  attempt: number,
  minAttempt: number,
): boolean {
  return (
    attempt >= minAttempt &&
    snapshot.runtime.status === "stopped" &&
    snapshot.portUsage.status === "free"
  );
}

function stoppedFreeEarlyExitGraceMs(): number {
  return process.platform === "win32"
    ? WINDOWS_STOPPED_FREE_EARLY_EXIT_GRACE_MS
    : STOPPED_FREE_EARLY_EXIT_GRACE_MS;
}

function withWaitContext(
  snapshot: GatewayRestartSnapshot,
  waitOutcome: GatewayRestartWaitOutcome,
  elapsedMs: number,
): GatewayRestartSnapshot {
  return { ...snapshot, waitOutcome, elapsedMs };
}

export async function waitForGatewayHealthyRestart(params: {
  service: GatewayService;
  port: number;
  attempts?: number;
  delayMs?: number;
  env?: NodeJS.ProcessEnv;
  expectedVersion?: string | null;
  includeUnknownListenersAsStale?: boolean;
  requireRunningService?: boolean;
  supervisorKeepsAlive?: boolean;
  isStartupMigrationActive?: typeof hasActiveStartupMigrationLease;
}): Promise<GatewayRestartSnapshot> {
  const startedAtMs = performance.now();
  const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
  const delayMs = params.delayMs ?? DEFAULT_RESTART_HEALTH_DELAY_MS;
  const standardDeadlineMs = attempts * delayMs;

  const probeAuth = await resolveGatewayRestartProbeAuth(params.env).catch(() => undefined);
  let snapshot = await inspectGatewayRestart({
    service: params.service,
    port: params.port,
    env: params.env,
    expectedVersion: params.expectedVersion,
    includeUnknownListenersAsStale: params.includeUnknownListenersAsStale,
    probeAuth,
  });

  let consecutiveStoppedFreeCount = 0;
  const STOPPED_FREE_THRESHOLD = 6;
  const minAttemptForEarlyExit = Math.min(
    Math.ceil(stoppedFreeEarlyExitGraceMs() / delayMs),
    Math.floor(attempts / 2),
  );
  let migrationDeadlineMs: number | undefined;
  let postMigrationDeadlineMs: number | undefined;
  let migrationActive = false;
  let nextMigrationActivityPollMs = 0;

  for (let attempt = 0; ; attempt += 1) {
    // Health probes and state-DB reads are part of the operator-visible wait. A monotonic clock
    // keeps both the normal deadline and migration watchdog bounded when those operations stall.
    const elapsedMs = Math.max(0, performance.now() - startedAtMs);
    const healthy =
      snapshot.healthy && (!params.requireRunningService || snapshot.runtime.status === "running");
    if (healthy) {
      return withWaitContext(snapshot, "healthy", elapsedMs);
    }
    if (snapshot.activatedPluginErrors?.length) {
      return withWaitContext(snapshot, "plugin-errors", elapsedMs);
    }
    if (snapshot.channelProbeErrors?.length) {
      return withWaitContext(snapshot, "channel-errors", elapsedMs);
    }
    if (snapshot.versionMismatch) {
      return withWaitContext(snapshot, "version-mismatch", elapsedMs);
    }
    if (snapshot.staleGatewayPids.length > 0 && snapshot.runtime.status !== "running") {
      return withWaitContext(snapshot, "stale-pids", elapsedMs);
    }
    // launchd KeepAlive can report a transient stopped state while its throttle window runs.
    // Let the bounded standard deadline decide failure when the caller knows supervision persists.
    if (
      !params.supervisorKeepsAlive &&
      shouldEarlyExitStoppedFree(snapshot, attempt, minAttemptForEarlyExit)
    ) {
      consecutiveStoppedFreeCount += 1;
      if (consecutiveStoppedFreeCount >= STOPPED_FREE_THRESHOLD) {
        return withWaitContext(snapshot, "stopped-free", elapsedMs);
      }
    } else if (snapshot.runtime.status !== "stopped" || snapshot.portUsage.status !== "free") {
      consecutiveStoppedFreeCount = 0;
    }

    if (snapshot.runtime.status !== "running") {
      migrationActive = false;
    } else if (elapsedMs >= nextMigrationActivityPollMs) {
      migrationActive = (() => {
        try {
          return (params.isStartupMigrationActive ?? hasActiveStartupMigrationLease)({
            env: params.env,
          });
        } catch {
          return false;
        }
      })();
      nextMigrationActivityPollMs = elapsedMs + STARTUP_MIGRATION_ACTIVITY_POLL_MS;
      if (migrationActive && migrationDeadlineMs === undefined) {
        // Startup owns migration truth through its renewable shared-state lease. Extend only
        // while the supervisor still reports the process running, and cap the extension at one
        // lease TTL so a wedged migration cannot hold restart/update callers indefinitely.
        migrationDeadlineMs = elapsedMs + STARTUP_MIGRATION_LEASE_TTL_MS;
      } else if (!migrationActive && migrationDeadlineMs !== undefined) {
        postMigrationDeadlineMs ??= elapsedMs + standardDeadlineMs;
      }
    }

    if (elapsedMs >= standardDeadlineMs || migrationDeadlineMs !== undefined) {
      const deadlineMs = migrationActive
        ? migrationDeadlineMs
        : (postMigrationDeadlineMs ?? standardDeadlineMs);
      if (deadlineMs === undefined || elapsedMs >= deadlineMs) {
        return withWaitContext(snapshot, "timeout", elapsedMs);
      }
    }
    await sleep(delayMs);
    snapshot = await inspectGatewayRestart({
      service: params.service,
      port: params.port,
      env: params.env,
      expectedVersion: params.expectedVersion,
      includeUnknownListenersAsStale: params.includeUnknownListenersAsStale,
      probeAuth,
    });
  }
}
