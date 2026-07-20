// In-process gateway run loop, restart signaling, drain, and update respawn handling.
import { randomUUID } from "node:crypto";
import net from "node:net";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  captureGatewayRestartTraceHandoff,
  createGatewayRestartTraceHandoffEnv,
  measureGatewayRestartTrace,
  markGatewayRestartTrace,
  startGatewayRestartTrace,
} from "../../gateway/restart-trace.js";
import type { startGatewayServer } from "../../gateway/server.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayBootLifecycleCompletion } from "../../infra/gateway-boot-lifecycle.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import type { GatewayRestartEmitter } from "../../infra/restart.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { formatActiveTaskRestartBlocker } from "../../tasks/task-restart-blocker.js";
const gatewayLog = createSubsystemLogger("gateway");
const LAUNCHD_SUPERVISED_RESTART_EXIT_DELAY_MS = 1500;
const DEFAULT_RESTART_DRAIN_TIMEOUT_MS = 300_000;
const RESTART_DRAIN_STILL_PENDING_WARN_MS = 30_000;
const RESTART_CLOSE_REPLY_DRAIN_SHUTDOWN_RESERVE_MS = 10_000;
const UPDATE_RESPAWN_HEALTH_TIMEOUT_MS = 10_000;
const UPDATE_RESPAWN_HEALTH_POLL_MS = 200;

type GatewayRunSignalAction = "stop" | "restart";
type RestartDrainTimeoutMs = number | undefined;
type RestartIntentOptions = {
  reason?: string;
  force?: boolean;
  waitMs?: number;
};
type GatewayRunSignalRequest = {
  action: GatewayRunSignalAction;
  signal: string;
  restartReason?: string;
  restartIntent?: RestartIntentOptions;
};

type GatewayLifecycleRuntimeModule = typeof import("./lifecycle.runtime.js");

function isUpdateProcessRestartReason(reason: string | undefined): boolean {
  return reason === "update.run" || reason === "update.auto";
}

const gatewayLifecycleRuntimeLoader = createLazyImportLoader<GatewayLifecycleRuntimeModule>(
  () => import("./lifecycle.runtime.js"),
);

const loadGatewayLifecycleRuntimeModule = () => gatewayLifecycleRuntimeLoader.load();

function createRestartIterationHook(onRestart: () => Promise<void> | void): () => Promise<boolean> {
  // The first loop starts fresh; subsequent iterations are in-process restarts.
  let isFirstIteration = true;
  return async () => {
    if (isFirstIteration) {
      isFirstIteration = false;
      return false;
    }
    await onRestart();
    return true;
  };
}

async function waitForGatewayPortReady(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, UPDATE_RESPAWN_HEALTH_POLL_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForHealthyGatewayChild(
  port: number,
  _pid?: number,
  host = "127.0.0.1",
  timeoutMs = UPDATE_RESPAWN_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await waitForGatewayPortReady(host, port)) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, UPDATE_RESPAWN_HEALTH_POLL_MS);
    });
  }
  return false;
}

export async function runGatewayLoop(params: {
  start: (params?: {
    startupStartedAt?: number;
    requestHotReloadRecovery?: GatewayRestartEmitter;
  }) => Promise<Awaited<ReturnType<typeof startGatewayServer>>>;
  runtime: RuntimeEnv;
  lockPort?: number;
  healthHost?: string;
  waitForHealthyChild?: (port: number, pid?: number, host?: string) => Promise<boolean>;
  beginBoot?: (startedAtMs: number) => void | Promise<void>;
  completeBoot?: (completion: GatewayBootLifecycleCompletion) => void;
}) {
  // macOS/BSD process inspection reports process.title instead of the original
  // argv. Give the long-running Gateway a verifiable identity for lock readers.
  if (process.title === "openclaw") {
    process.title = "openclaw-gateway";
  }
  let startupStartedAt: number;
  // Eagerly resolve the lifecycle runtime module before installing signal
  // listeners. Without this, every subsequent lifecycle path (SIGUSR1,
  // SIGTERM-with-intent, restart iteration hook, stability bundle writer)
  // depends on a dynamic import() call. After an in-place package upgrade
  // (e.g. `npm install -g openclaw@latest` triggered via update.run),
  // dist/ chunk hashes rotate while the process is still running. The next
  // SIGUSR1 — including the one update.run schedules for itself — would
  // hit ERR_MODULE_NOT_FOUND from inside its async IIFE, reject silently,
  // and leave restart.ts's emittedRestartToken permanently unconsumed.
  // From that point every scheduleGatewaySigusr1Restart() returns
  // { coalesced: true } and the gateway never restarts. Priming the loader
  // here pulls the whole re-export graph (lifecycle.runtime.ts is a 36-line
  // re-export hub) into memory, immune to later disk rotation.
  const eagerLifecycleRuntime = await loadGatewayLifecycleRuntimeModule();
  let lock = await acquireGatewayLock({ port: params.lockPort });
  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  let shuttingDown = false;
  let restartResolver: (() => void) | null = null;
  // The HTTP server can report ready before params.start returns its close handle.
  // Defer lifecycle signals from that window until the loop can close and advance.
  let pendingStartupRequest: GatewayRunSignalRequest | null = null;
  let activeRestartRequest: GatewayRunSignalRequest | null = null;
  let forceActiveRestartExit: (() => void) | null = null;
  let pendingStartupForceExitTimer: ReturnType<typeof setTimeout> | null = null;
  let restartDrainingMarked = false;
  let startupFailedWithoutServerHandle = false;
  const processInstanceId = randomUUID();
  const waitForHealthyChild = params.waitForHealthyChild ?? waitForHealthyGatewayChild;

  const cleanupSignals = () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGUSR1", onSigusr1);
  };
  const exitProcess = (code: number) => {
    cleanupSignals();
    params.runtime.exit(code);
  };
  const completeForcedStop = (reason: string) => {
    params.completeBoot?.({ outcome: "forced_stop", reason });
  };
  const writeStabilityBundle = async (reason: string, error?: unknown) => {
    const { writeDiagnosticStabilityBundleForFailureSync } =
      await loadGatewayLifecycleRuntimeModule();
    const result = writeDiagnosticStabilityBundleForFailureSync(reason, error);
    if ("message" in result) {
      gatewayLog.warn(result.message);
    }
  };
  const releaseLockIfHeld = async (): Promise<boolean> => {
    if (!lock) {
      return false;
    }
    await lock.release();
    lock = null;
    return true;
  };
  const reacquireLockForInProcessRestart = async (): Promise<boolean> => {
    try {
      lock = await acquireGatewayLock({ port: params.lockPort });
      return true;
    } catch (err) {
      gatewayLog.error(`failed to reacquire gateway lock for in-process restart: ${String(err)}`);
      exitProcess(1);
      return false;
    }
  };
  const handleRestartAfterServerClose = async () => {
    await releaseLockIfHeld();
    const {
      detectGatewayRespawnSupervisor,
      markUpdateRestartSentinelFailure,
      respawnGatewayProcessForUpdate,
      restartGatewayProcessWithFreshPid,
      writeGatewayRestartHandoffSync,
    } = await loadGatewayLifecycleRuntimeModule();
    // Lock release and lazy lifecycle loading may yield while a managed update
    // upgrades this restart. Keep the request live until a restart path commits.
    const restartReason = activeRestartRequest?.restartReason;
    params.completeBoot?.({
      outcome: "planned_restart",
      reason: restartReason ?? "gateway.restart",
    });
    const isUpdateRestart = isUpdateProcessRestartReason(restartReason);

    if (isUpdateRestart) {
      const restartTraceHandoff = captureGatewayRestartTraceHandoff();
      const respawn = respawnGatewayProcessForUpdate({
        env: createGatewayRestartTraceHandoffEnv(restartTraceHandoff),
      });
      if (respawn.mode === "spawned") {
        const port = params.lockPort;
        const healthy =
          typeof port === "number"
            ? await waitForHealthyChild(port, respawn.pid, params.healthHost ?? "127.0.0.1")
            : false;
        if (healthy) {
          activeRestartRequest = null;
          gatewayLog.info(
            `restart mode: update process respawn (spawned pid ${respawn.pid ?? "unknown"})`,
          );
          exitProcess(0);
          return;
        }
        gatewayLog.warn(
          `update respawn child did not become healthy (${respawn.pid ?? "unknown"}); falling back to in-process restart`,
        );
        try {
          respawn.child?.kill();
        } catch {
          // Best-effort; parent fallback keeps the gateway reachable for recovery.
        }
        await markUpdateRestartSentinelFailure("restart-unhealthy").catch((err: unknown) => {
          gatewayLog.warn(`failed to mark update restart sentinel unhealthy: ${String(err)}`);
        });
        if (!(await reacquireLockForInProcessRestart())) {
          return;
        }
        shuttingDown = false;
        restartResolver?.();
        return;
      }
      if (respawn.mode === "supervised") {
        const supervisorMode = detectGatewayRespawnSupervisor(process.env, process.platform);
        markGatewayRestartTrace("restart.full-process-handoff", [
          ["kind", "update-process"],
          ["mode", respawn.mode],
          ["supervisorMode", supervisorMode ?? "external"],
        ]);
        const handoff = writeGatewayRestartHandoffSync({
          restartKind: "update-process",
          reason: restartReason,
          processInstanceId,
          supervisorMode: supervisorMode ?? "external",
          restartTrace: captureGatewayRestartTraceHandoff(),
        });
        if (supervisorMode === "external" && !handoff) {
          gatewayLog.warn(
            "external supervisor restart handoff could not be persisted; falling back to in-process restart",
          );
          await markUpdateRestartSentinelFailure("restart-handoff-unavailable").catch(
            (err: unknown) => {
              gatewayLog.warn(`failed to mark update restart handoff unavailable: ${String(err)}`);
            },
          );
          if (!(await reacquireLockForInProcessRestart())) {
            return;
          }
          activeRestartRequest = null;
          shuttingDown = false;
          restartResolver?.();
          return;
        }
        activeRestartRequest = null;
        gatewayLog.info("restart mode: update process respawn (supervisor restart)");
        if (supervisorMode === "launchd") {
          await new Promise((resolve) => {
            setTimeout(resolve, LAUNCHD_SUPERVISED_RESTART_EXIT_DELAY_MS);
          });
        }
        exitProcess(0);
        return;
      }
      if (respawn.mode === "failed") {
        gatewayLog.warn(
          `update respawn failed (${respawn.detail ?? "unknown error"}); falling back to in-process restart`,
        );
        await markUpdateRestartSentinelFailure("restart-unhealthy").catch((err: unknown) => {
          gatewayLog.warn(`failed to mark update restart sentinel unhealthy: ${String(err)}`);
        });
      } else {
        gatewayLog.info(
          `restart mode: in-process restart (${respawn.detail ?? "OPENCLAW_NO_RESPAWN"})`,
        );
      }
      if (!(await reacquireLockForInProcessRestart())) {
        return;
      }
      activeRestartRequest = null;
      shuttingDown = false;
      restartResolver?.();
      return;
    }

    // Release the lock BEFORE spawning so the child can acquire it immediately.
    const restartTraceHandoff = captureGatewayRestartTraceHandoff();
    const respawn = restartGatewayProcessWithFreshPid({
      env: createGatewayRestartTraceHandoffEnv(restartTraceHandoff),
    });
    if (respawn.mode === "spawned" || respawn.mode === "supervised") {
      const supervisorMode =
        respawn.mode === "supervised"
          ? detectGatewayRespawnSupervisor(process.env, process.platform)
          : null;
      const modeLabel =
        respawn.mode === "spawned"
          ? `spawned pid ${respawn.pid ?? "unknown"}`
          : "supervisor restart";
      markGatewayRestartTrace("restart.full-process-handoff", [
        ["kind", "full-process"],
        ["mode", respawn.mode],
        ["pid", respawn.mode === "spawned" ? (respawn.pid ?? "unknown") : "none"],
        ["supervisorMode", supervisorMode ?? "none"],
      ]);
      if (respawn.mode === "supervised") {
        const handoff = writeGatewayRestartHandoffSync({
          restartKind: "full-process",
          reason: restartReason,
          processInstanceId,
          supervisorMode: supervisorMode ?? "external",
          restartTrace: captureGatewayRestartTraceHandoff(),
        });
        if (supervisorMode === "external" && !handoff) {
          gatewayLog.warn(
            "external supervisor restart handoff could not be persisted; falling back to in-process restart",
          );
          if (!(await reacquireLockForInProcessRestart())) {
            return;
          }
          activeRestartRequest = null;
          shuttingDown = false;
          restartResolver?.();
          return;
        }
      }
      activeRestartRequest = null;
      gatewayLog.info(`restart mode: full process restart (${modeLabel})`);
      if (supervisorMode === "launchd") {
        // A short clean-exit pause keeps rapid SIGUSR1/config restarts from
        // tripping launchd crash-loop throttling before KeepAlive relaunches.
        await new Promise((resolve) => {
          setTimeout(resolve, LAUNCHD_SUPERVISED_RESTART_EXIT_DELAY_MS);
        });
      }
      exitProcess(0);
      return;
    }
    if (respawn.mode === "failed") {
      await writeStabilityBundle("gateway.restart_respawn_failed");
      gatewayLog.warn(
        `full process restart failed (${respawn.detail ?? "unknown error"}); falling back to in-process restart`,
      );
    } else {
      gatewayLog.info(
        `restart mode: in-process restart (${respawn.detail ?? "OPENCLAW_NO_RESPAWN"})`,
      );
    }
    if (isUpdateProcessRestartReason(activeRestartRequest?.restartReason)) {
      await handleRestartAfterServerClose();
      return;
    }
    if (!(await reacquireLockForInProcessRestart())) {
      return;
    }
    if (isUpdateProcessRestartReason(activeRestartRequest?.restartReason)) {
      await handleRestartAfterServerClose();
      return;
    }
    activeRestartRequest = null;
    shuttingDown = false;
    restartResolver?.();
  };
  const handleStopAfterServerClose = async () => {
    params.completeBoot?.({ outcome: "clean_stop", reason: "gateway.stop" });
    await releaseLockIfHeld();
    exitProcess(0);
  };

  const SUPERVISOR_STOP_TIMEOUT_MS = 30_000;
  const SHUTDOWN_TIMEOUT_MS = SUPERVISOR_STOP_TIMEOUT_MS - 5_000;
  const clearPendingStartupForceExitTimer = () => {
    if (!pendingStartupForceExitTimer) {
      return;
    }
    clearTimeout(pendingStartupForceExitTimer);
    pendingStartupForceExitTimer = null;
  };
  const armPendingStartupForceExitTimer = () => {
    if (pendingStartupForceExitTimer) {
      return;
    }
    pendingStartupForceExitTimer = setTimeout(() => {
      pendingStartupForceExitTimer = null;
      gatewayLog.error(
        "startup restart request timed out before gateway returned a close handle; exiting for supervisor recovery",
      );
      void (async () => {
        try {
          await writeStabilityBundle("gateway.restart_startup_request_timeout");
        } finally {
          completeForcedStop("gateway.restart_startup_request_timeout");
          exitProcess(1);
        }
      })();
    }, SHUTDOWN_TIMEOUT_MS);
    pendingStartupForceExitTimer.unref?.();
  };
  const resolveRestartDrainTimeoutMs = async (
    restartIntent?: RestartIntentOptions,
  ): Promise<RestartDrainTimeoutMs> => {
    if (restartIntent?.force) {
      return 0;
    }
    if (typeof restartIntent?.waitMs === "number" && Number.isFinite(restartIntent.waitMs)) {
      return restartIntent.waitMs > 0 ? Math.floor(restartIntent.waitMs) : undefined;
    }
    try {
      const { resolveGatewayRestartDeferralTimeoutMs } = await loadGatewayLifecycleRuntimeModule();
      return resolveGatewayRestartDeferralTimeoutMs();
    } catch {
      return DEFAULT_RESTART_DRAIN_TIMEOUT_MS;
    }
  };
  const markRestartDraining = () => {
    if (restartDrainingMarked) {
      return;
    }
    // The lifecycle module is primed before listeners are installed. Keep this
    // transition synchronous so an accepted signal cannot yield between token
    // handling and closing process-wide root admission.
    eagerLifecycleRuntime.markGatewayDraining();
    restartDrainingMarked = true;
  };

  const runAcceptedRequest = (acceptedRequest: GatewayRunSignalRequest) => {
    const { action, restartIntent } = acceptedRequest;
    const isRestart = action === "restart";
    if (isRestart) {
      activeRestartRequest = acceptedRequest;
    }
    let forceExitTimer: ReturnType<typeof setTimeout> | null = null;
    const armForceExitTimer = (forceExitMs: number) => {
      if (forceExitTimer) {
        return;
      }
      forceExitTimer = setTimeout(() => {
        gatewayLog.error("shutdown timed out; exiting without full cleanup");
        void (async () => {
          try {
            await writeStabilityBundle(
              isRestart ? "gateway.restart_shutdown_timeout" : "gateway.stop_shutdown_timeout",
            );
          } finally {
            // Keep the in-process watchdog below the supervisor stop budget so this
            // path wins before launchd/systemd escalates to a hard kill. Exit
            // non-zero on any timeout so supervised installs restart cleanly.
            completeForcedStop(
              isRestart ? "gateway.restart_shutdown_timeout" : "gateway.stop_shutdown_timeout",
            );
            exitProcess(1);
          }
        })();
      }, forceExitMs);
    };
    const clearForceExitTimer = () => {
      if (!forceExitTimer) {
        return;
      }
      clearTimeout(forceExitTimer);
      forceExitTimer = null;
    };
    if (isRestart) {
      forceActiveRestartExit = () => {
        clearForceExitTimer();
        armForceExitTimer(SHUTDOWN_TIMEOUT_MS);
      };
    }

    void (async () => {
      const restartDrainTimeoutMs = isRestart
        ? await resolveRestartDrainTimeoutMs(restartIntent)
        : 0;
      const restartDrainDeadlineAt =
        isRestart && restartDrainTimeoutMs !== undefined
          ? Date.now() + restartDrainTimeoutMs
          : undefined;
      if (!isRestart) {
        armForceExitTimer(SHUTDOWN_TIMEOUT_MS);
      } else if (restartDrainTimeoutMs !== undefined) {
        // Allow extra time for draining active turns on explicitly capped restarts.
        armForceExitTimer(restartDrainTimeoutMs + SHUTDOWN_TIMEOUT_MS);
      }

      const formatRestartDrainBudget = () =>
        restartDrainTimeoutMs === undefined
          ? "without a timeout"
          : `with timeout ${restartDrainTimeoutMs}ms`;
      const armCloseForceExitTimerForIndefiniteRestart = () => {
        if (isRestart && restartDrainTimeoutMs === undefined) {
          armForceExitTimer(SHUTDOWN_TIMEOUT_MS);
        }
      };
      const resolveRestartCloseDrainTimeoutMs = () => {
        if (!isRestart) {
          return null;
        }
        if (restartDrainTimeoutMs === undefined) {
          return Math.max(0, SHUTDOWN_TIMEOUT_MS - RESTART_CLOSE_REPLY_DRAIN_SHUTDOWN_RESERVE_MS);
        }
        return Math.max(0, (restartDrainDeadlineAt ?? Date.now()) - Date.now());
      };

      try {
        // On restart, wait for in-flight agent turns to finish before
        // tearing down the server so buffered messages are delivered.
        if (isRestart) {
          let activeTasksAtDrainStart = 0;
          let activeRunsAtDrainStart = 0;
          let drainTimedOut = false;
          await measureGatewayRestartTrace(
            "restart.drain",
            async () => {
              const {
                abortEmbeddedAgentRun,
                getRuntimeConfig,
                getInspectableActiveTaskRestartBlockers,
                getActiveEmbeddedRunCount,
                getActiveTaskCount,
                listActiveEmbeddedRunSessionIds,
                listActiveEmbeddedRunSessionKeys,
                markRestartAbortedMainSessions,
                waitForActiveGatewayRootWork,
                waitForActiveEmbeddedRuns,
                waitForActiveTasks,
              } = await loadGatewayLifecycleRuntimeModule();
              const collectActiveRestartSessionKeys = () => {
                return new Set<string>(listActiveEmbeddedRunSessionKeys());
              };
              const collectActiveRestartSessionIds = () => {
                return new Set<string>(listActiveEmbeddedRunSessionIds());
              };
              let activeRestartSessionKeysAtDrainStart = new Set<string>();
              let activeRestartSessionIdsAtDrainStart = new Set<string>();
              const markActiveMainSessionsForRestart = async (reason: string) => {
                const sessionKeys = new Set<string>([
                  ...activeRestartSessionKeysAtDrainStart,
                  ...collectActiveRestartSessionKeys(),
                ]);
                const sessionIds = new Set<string>([
                  ...activeRestartSessionIdsAtDrainStart,
                  ...collectActiveRestartSessionIds(),
                ]);
                if (sessionKeys.size === 0 && sessionIds.size === 0) {
                  return;
                }
                try {
                  await markRestartAbortedMainSessions({
                    cfg: getRuntimeConfig(),
                    sessionKeys,
                    sessionIds,
                    reason,
                  });
                } catch (err) {
                  gatewayLog.warn(
                    `failed to mark interrupted main sessions for restart recovery: ${String(err)}`,
                  );
                }
              };
              const formatTaskBlockers = () => {
                const blockers = getInspectableActiveTaskRestartBlockers();
                if (blockers.length === 0) {
                  return null;
                }
                const shown = blockers.slice(0, 8).map(formatActiveTaskRestartBlocker);
                const omitted = blockers.length - shown.length;
                return omitted > 0 ? `${shown.join("; ")}; +${omitted} more` : shown.join("; ");
              };
              const createStillPendingDrainLogger = () =>
                setInterval(() => {
                  gatewayLog.warn(
                    `still draining ${getActiveTaskCount()} active task(s) and ${getActiveEmbeddedRunCount()} active embedded run(s) before restart`,
                  );
                }, RESTART_DRAIN_STILL_PENDING_WARN_MS);

              // Reject new enqueues immediately during the drain window so
              // sessions get an explicit restart error instead of silent task loss.
              markRestartDraining();
              const rootDrainTimeoutMs =
                restartDrainDeadlineAt === undefined
                  ? undefined
                  : Math.max(0, restartDrainDeadlineAt - Date.now());
              const rootDrainPromise = restartIntent?.force
                ? Promise.resolve({ drained: true, active: 0 })
                : waitForActiveGatewayRootWork(rootDrainTimeoutMs);
              const activeTasks = getActiveTaskCount();
              const activeRuns = getActiveEmbeddedRunCount();
              activeTasksAtDrainStart = activeTasks;
              activeRunsAtDrainStart = activeRuns;
              activeRestartSessionKeysAtDrainStart = collectActiveRestartSessionKeys();
              activeRestartSessionIdsAtDrainStart = collectActiveRestartSessionIds();

              // Best-effort abort for compacting runs so long compaction operations
              // don't hold session write locks across restart boundaries.
              if (activeRuns > 0) {
                await markActiveMainSessionsForRestart("gateway restart drain");
                abortEmbeddedAgentRun(undefined, { mode: "compacting", reason: "restart" });
              }

              if (activeTasks > 0 || activeRuns > 0) {
                const taskBlockers = formatTaskBlockers();
                gatewayLog.info(
                  `draining ${activeTasks} active task(s) and ${activeRuns} active embedded run(s) before restart ${formatRestartDrainBudget()}`,
                );
                if (taskBlockers) {
                  gatewayLog.warn(
                    `restart blocked by active background task run(s): ${taskBlockers}`,
                  );
                }
                if (restartIntent?.force) {
                  gatewayLog.warn("forced restart requested; skipping active work drain");
                  await markActiveMainSessionsForRestart(
                    restartIntent.reason ?? "forced gateway restart",
                  );
                  abortEmbeddedAgentRun(undefined, { mode: "all", reason: "restart" });
                } else {
                  const stillPendingDrainLogger = createStillPendingDrainLogger();
                  let abortedAfterRunTimeout = false;
                  let tasksDrain: { drained: boolean } = { drained: true };
                  let runsDrain: { drained: boolean } = { drained: true };
                  try {
                    const tasksDrainPromise =
                      activeTasks > 0
                        ? waitForActiveTasks(restartDrainTimeoutMs)
                        : Promise.resolve({ drained: true });
                    runsDrain =
                      activeRuns > 0
                        ? await waitForActiveEmbeddedRuns(restartDrainTimeoutMs)
                        : { drained: true };
                    if (!runsDrain.drained && activeRuns > 0) {
                      gatewayLog.warn(
                        "active embedded run drain timeout reached; aborting active run(s) before restart",
                      );
                      abortEmbeddedAgentRun(undefined, { mode: "all", reason: "restart" });
                      abortedAfterRunTimeout = true;
                    }
                    tasksDrain = await tasksDrainPromise;
                  } finally {
                    clearInterval(stillPendingDrainLogger);
                  }
                  if (tasksDrain.drained && runsDrain.drained) {
                    gatewayLog.info("all active work drained");
                  } else {
                    drainTimedOut = true;
                    gatewayLog.warn("drain timeout reached; proceeding with restart");
                    await markActiveMainSessionsForRestart("gateway restart drain timeout");
                    // Final best-effort abort to avoid carrying active runs into the
                    // next lifecycle when drain time budget is exhausted.
                    if (!abortedAfterRunTimeout) {
                      abortEmbeddedAgentRun(undefined, { mode: "all", reason: "restart" });
                    }
                  }
                }
              }
              const rootDrain = await rootDrainPromise;
              if (!rootDrain.drained) {
                drainTimedOut = true;
                gatewayLog.warn(
                  `gateway root transaction drain timeout reached with ${rootDrain.active} root(s) still active; proceeding with restart`,
                );
              }
            },
            () => [
              ["activeTasks", activeTasksAtDrainStart],
              ["activeRuns", activeRunsAtDrainStart],
              ["timedOut", drainTimedOut],
              ["force", restartIntent?.force === true],
            ],
          );
        }

        armCloseForceExitTimerForIndefiniteRestart();
        const closeDrainTimeoutMs = resolveRestartCloseDrainTimeoutMs();
        await server?.close({
          reason: isRestart ? "gateway restarting" : "gateway stopping",
          restartExpectedMs: isRestart ? 1500 : null,
          ...(closeDrainTimeoutMs !== null ? { drainTimeoutMs: closeDrainTimeoutMs } : {}),
        });
      } catch (err) {
        gatewayLog.error(`shutdown error: ${String(err)}`);
      } finally {
        server = null;
        if (isRestart) {
          try {
            await handleRestartAfterServerClose();
          } finally {
            clearForceExitTimer();
            forceActiveRestartExit = null;
          }
        } else {
          clearForceExitTimer();
          await handleStopAfterServerClose();
        }
      }
    })();
  };
  const flushPendingStartupRequest = (opts: { allowMissingServer?: boolean } = {}) => {
    if (!pendingStartupRequest || !restartResolver) {
      return;
    }
    if (!server && opts.allowMissingServer !== true) {
      return;
    }
    const request = pendingStartupRequest;
    pendingStartupRequest = null;
    clearPendingStartupForceExitTimer();
    startupFailedWithoutServerHandle = false;
    runAcceptedRequest(request);
  };
  const request = (
    action: GatewayRunSignalAction,
    signal: string,
    restartReason?: string,
    restartIntent?: RestartIntentOptions,
  ) => {
    const acceptedRequest = { action, signal, restartReason, restartIntent };
    if (shuttingDown) {
      const currentRestartRequest = pendingStartupRequest ?? activeRestartRequest;
      if (
        action === "restart" &&
        isUpdateProcessRestartReason(restartReason) &&
        currentRestartRequest?.action === "restart" &&
        !isUpdateProcessRestartReason(currentRestartRequest.restartReason)
      ) {
        const upgradedRequest = {
          ...currentRestartRequest,
          signal,
          restartReason,
          restartIntent: {
            ...currentRestartRequest.restartIntent,
            ...restartIntent,
            force: true,
            reason: restartReason,
          },
        };
        if (pendingStartupRequest) {
          pendingStartupRequest = upgradedRequest;
        } else {
          activeRestartRequest = upgradedRequest;
          forceActiveRestartExit?.();
        }
        gatewayLog.info(`received ${signal} during shutdown; upgrading to ${restartReason}`);
        return;
      }
      if (action === "stop" && pendingStartupRequest && !server) {
        gatewayLog.info(`received ${signal}; overriding pending startup restart with shutdown`);
        pendingStartupRequest = null;
        clearPendingStartupForceExitTimer();
        startupFailedWithoutServerHandle = false;
        runAcceptedRequest(acceptedRequest);
        return;
      }
      gatewayLog.info(`received ${signal} during shutdown; ignoring`);
      return;
    }
    const isRestart = action === "restart";
    if (isRestart) {
      markRestartDraining();
    }
    shuttingDown = true;
    gatewayLog.info(`received ${signal}; ${isRestart ? "restarting" : "shutting down"}`);
    if (isRestart) {
      startGatewayRestartTrace("restart.signal.received", [
        ["signal", signal],
        ["reason", restartReason ?? signal],
        ["force", restartIntent?.force === true],
        ["waitMs", restartIntent?.waitMs ?? "default"],
      ]);
    }
    if (action === "stop") {
      runAcceptedRequest(acceptedRequest);
      return;
    }
    if (!server && restartResolver && startupFailedWithoutServerHandle) {
      startupFailedWithoutServerHandle = false;
      runAcceptedRequest(acceptedRequest);
      return;
    }
    if (!server || !restartResolver) {
      pendingStartupRequest = acceptedRequest;
      armPendingStartupForceExitTimer();
      return;
    }
    runAcceptedRequest(acceptedRequest);
  };

  const onSigterm = () => {
    // Debug-level: every accepted signal is announced by request()'s
    // "received <signal>; ..." line, so an info pre-log would double up.
    gatewayLog.debug("signal SIGTERM received");
    void (async () => {
      const { consumeGatewayRestartIntentPayloadSync } = await loadGatewayLifecycleRuntimeModule();
      const restartIntent = consumeGatewayRestartIntentPayloadSync();
      request(
        restartIntent ? "restart" : "stop",
        "SIGTERM",
        restartIntent?.reason,
        restartIntent ?? undefined,
      );
    })().catch((err: unknown) => {
      gatewayLog.error(`failed to handle SIGTERM: ${String(err)}`);
      request("stop", "SIGTERM");
    });
  };
  const onSigint = () => {
    gatewayLog.debug("signal SIGINT received");
    request("stop", "SIGINT");
  };
  const onSigusr1 = () => {
    gatewayLog.debug("signal SIGUSR1 received");
    void (async () => {
      const {
        abortPendingChannelReloads,
        consumeGatewayRestartIntentPayloadSync,
        consumeGatewaySigusr1RestartIntent,
        consumeGatewaySigusr1RestartAuthorization,
        isGatewaySigusr1RestartExternallyAllowed,
        markGatewaySigusr1RestartHandled,
        peekGatewaySigusr1RestartReason,
        scheduleGatewaySigusr1Restart,
      } = await loadGatewayLifecycleRuntimeModule();
      const restartIntent = consumeGatewayRestartIntentPayloadSync();
      if (restartIntent) {
        abortPendingChannelReloads();
        const authorized = consumeGatewaySigusr1RestartAuthorization();
        markRestartDraining();
        if (authorized) {
          markGatewaySigusr1RestartHandled();
        }
        request("restart", "SIGUSR1", restartIntent.reason ?? "gateway.restart", restartIntent);
        return;
      }
      const authorized = consumeGatewaySigusr1RestartAuthorization();
      if (!authorized) {
        markGatewaySigusr1RestartHandled();
        if (!isGatewaySigusr1RestartExternallyAllowed()) {
          gatewayLog.warn("SIGUSR1 restart ignored (not authorized; commands.restart=false).");
          gatewayLog.warn(
            "An unauthorized SIGUSR1 restart signal was received and ignored. " +
              "If a pending gateway restart needs to be applied, run `openclaw gateway restart` " +
              "or restart the gateway through your service manager.",
          );
          return;
        }
        if (shuttingDown) {
          gatewayLog.info("received SIGUSR1 during shutdown; ignoring");
          return;
        }
        // External SIGUSR1 requests should still reuse the in-process restart
        // scheduler so idle drain and restart coalescing stay consistent.
        abortPendingChannelReloads();
        scheduleGatewaySigusr1Restart({ delayMs: 0, reason: "SIGUSR1" });
        return;
      }
      abortPendingChannelReloads();
      const sigusr1RestartIntent = consumeGatewaySigusr1RestartIntent();
      const restartReason = peekGatewaySigusr1RestartReason();
      markRestartDraining();
      markGatewaySigusr1RestartHandled();
      request(
        "restart",
        "SIGUSR1",
        sigusr1RestartIntent?.reason ?? restartReason,
        sigusr1RestartIntent ?? undefined,
      );
    })().catch((err: unknown) => {
      // Defense in depth: if anything in the listener body rejects, the
      // SIGUSR1 emit has already advanced emittedRestartToken but no one
      // called markGatewaySigusr1RestartHandled. Without unsticking the
      // token here, every subsequent scheduleGatewaySigusr1Restart() would
      // silently coalesce into the dead in-flight signal and the gateway
      // would never restart again until manually kickstarted.
      gatewayLog.error(`SIGUSR1 handler failed: ${formatErrorMessage(err)}`);
      try {
        eagerLifecycleRuntime.markGatewaySigusr1RestartHandled();
      } catch {
        // Best-effort: the eager reference itself is the recovery path.
      }
      try {
        eagerLifecycleRuntime.rollbackGatewayRestartSignalAdmission();
        // A later signal must repeat the synchronous close transition even if
        // this handler failed after marking the one-way drain.
        restartDrainingMarked = false;
      } catch {
        // Keep admission recovery independent from restart-token recovery.
      }
    });
  };

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("SIGUSR1", onSigusr1);

  try {
    const onIteration = createRestartIterationHook(async () => {
      // After an in-process restart (SIGUSR1), reset command-queue lane state.
      // Interrupted tasks from the previous lifecycle may have left `active`
      // counts elevated (their finally blocks never ran), permanently blocking
      // new work from draining. The same boundary also discards stale restart
      // deferral timers and reloads the task registry from durable state so
      // cancelled/completed work is not kept alive by old in-memory maps.
      const {
        abortActiveCronTaskRuns,
        advanceCronActiveJobGeneration,
        reloadTaskRuntimeStateFromStore,
        retireActiveCronTaskRunTracking,
        resetCronActiveJobs,
        resetAllLanes,
        resetGatewayRestartStateForInProcessRestart,
        resetGatewaySuspendCoordinatorForLifecycleRestart,
        rotateAgentEventLifecycleGeneration,
        waitForActiveCronJobs,
        waitForActiveCronTaskRuns,
      } = await loadGatewayLifecycleRuntimeModule();
      // Rotate ownership before reset pumps preserved queue entries.
      rotateAgentEventLifecycleGeneration();
      advanceCronActiveJobGeneration();
      abortActiveCronTaskRuns("Gateway restarting.");
      const cronTaskDrain = await waitForActiveCronTaskRuns(1_000);
      const cronDrain = await waitForActiveCronJobs(1_000);
      if (!cronTaskDrain.drained || !cronDrain.drained) {
        gatewayLog.warn(
          `cron run drain timed out during restart lifecycle reset after retiring old cron admission; ${cronTaskDrain.active} task handle(s) and ${cronDrain.active} active marker(s) remain after aborting old cron runs`,
        );
      }
      retireActiveCronTaskRunTracking();
      resetCronActiveJobs();
      // Resume the retired scheduler before resetAllLanes invalidates its
      // suspension admission callback and discards the coordinator entry.
      resetGatewaySuspendCoordinatorForLifecycleRestart();
      resetAllLanes();
      clearRuntimeConfigSnapshot();
      resetGatewayRestartStateForInProcessRestart();
      reloadTaskRuntimeStateFromStore();
      markGatewayRestartTrace("restart.next-start");
    });

    // Keep process alive; SIGUSR1 triggers an in-process restart (no supervisor required).
    // SIGTERM/SIGINT still exit after a graceful shutdown.
    let isFirstStart = true;
    for (;;) {
      // The restart hook reopens admission before reloading durable state. Clear
      // its local mirror first so a failed reload cannot skip the next drain.
      restartDrainingMarked = false;
      let startupFailedBeforeServerHandle = false;
      try {
        await onIteration();
        startupStartedAt = Date.now();
        await params.beginBoot?.(startupStartedAt);
        server = await params.start({
          startupStartedAt,
          requestHotReloadRecovery: eagerLifecycleRuntime.requestGatewayRestartWithSignalAdmission,
        });
        startupFailedWithoutServerHandle = false;
        isFirstStart = false;
      } catch (err) {
        params.completeBoot?.({
          outcome: "startup_failed",
          reason: truncateUtf16Safe(formatErrorMessage(err), 500),
        });
        // On initial startup, let the error propagate so the outer handler
        // can report "Gateway failed to start" and exit non-zero. Only
        // swallow errors on subsequent in-process restarts to keep the
        // process alive (a crash would lose macOS TCC permissions). (#35862)
        if (isFirstStart) {
          throw err;
        }
        server = null;
        startupFailedWithoutServerHandle = true;
        startupFailedBeforeServerHandle = true;
        if (!pendingStartupRequest) {
          // Release the gateway lock so that `daemon restart/stop` (which
          // discovers PIDs via the gateway port) can still manage the process.
          // Without this, the process holds the lock but is not listening,
          // forcing manual cleanup. (#35862)
          await releaseLockIfHeld();
        }
        const errMsg = formatErrorMessage(err);
        const errStack = err instanceof Error && err.stack ? `\n${err.stack}` : "";
        await writeStabilityBundle("gateway.restart_startup_failed", err);
        gatewayLog.error(
          `gateway startup failed: ${errMsg}. ` +
            `Process will stay alive; fix the issue and restart.${errStack}`,
        );
      }
      await new Promise<void>((resolve) => {
        restartResolver = () => {
          restartResolver = null;
          resolve();
        };
        flushPendingStartupRequest({ allowMissingServer: startupFailedBeforeServerHandle });
      });
    }
  } finally {
    await releaseLockIfHeld();
    cleanupSignals();
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
