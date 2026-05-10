import { randomUUID } from "node:crypto";
import net from "node:net";
import type { startGatewayServer } from "../../gateway/server.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";

const gatewayLog = createSubsystemLogger("gateway");
const LAUNCHD_SUPERVISED_RESTART_EXIT_DELAY_MS = 1500;
const DEFAULT_RESTART_DRAIN_TIMEOUT_MS = 300_000;
const RESTART_DRAIN_STILL_PENDING_WARN_MS = 30_000;
const UPDATE_RESPAWN_HEALTH_TIMEOUT_MS = 10_000;
const UPDATE_RESPAWN_HEALTH_POLL_MS = 200;

type GatewayRunSignalAction = "stop" | "restart";
type RestartDrainTimeoutMs = number | undefined;
type RestartIntentOptions = {
  force?: boolean;
  waitMs?: number;
};

type GatewayLifecycleRuntimeModule = typeof import("./lifecycle.runtime.js");

const gatewayLifecycleRuntimeLoader = createLazyImportLoader<GatewayLifecycleRuntimeModule>(
  () => import("./lifecycle.runtime.js"),
);

const loadGatewayLifecycleRuntimeModule = () => gatewayLifecycleRuntimeLoader.load();

function createRestartIterationHook(onRestart: () => Promise<void> | void): () => Promise<boolean> {
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
  }) => Promise<Awaited<ReturnType<typeof startGatewayServer>>>;
  runtime: RuntimeEnv;
  lockPort?: number;
  healthHost?: string;
  waitForHealthyChild?: (port: number, pid?: number, host?: string) => Promise<boolean>;
}) {
  let startupStartedAt = Date.now();
  let lock = await acquireGatewayLock({ port: params.lockPort });
  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  let shuttingDown = false;
  let restartResolver: (() => void) | null = null;
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
      startupStartedAt = Date.now();
      lock = await acquireGatewayLock({ port: params.lockPort });
      return true;
    } catch (err) {
      gatewayLog.error(`failed to reacquire gateway lock for in-process restart: ${String(err)}`);
      exitProcess(1);
      return false;
    }
  };
  const handleRestartAfterServerClose = async (restartReason?: string) => {
    const hadLock = await releaseLockIfHeld();
    const isUpdateRestart = restartReason === "update.run";
    const {
      detectRespawnSupervisor,
      markUpdateRestartSentinelFailure,
      respawnGatewayProcessForUpdate,
      restartGatewayProcessWithFreshPid,
      writeGatewayRestartHandoffSync,
    } = await loadGatewayLifecycleRuntimeModule();

    if (isUpdateRestart) {
      const respawn = respawnGatewayProcessForUpdate();
      if (respawn.mode === "spawned") {
        const port = params.lockPort;
        const healthy =
          typeof port === "number"
            ? await waitForHealthyChild(port, respawn.pid, params.healthHost ?? "127.0.0.1")
            : false;
        if (healthy) {
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
        await markUpdateRestartSentinelFailure("restart-unhealthy").catch((err) => {
          gatewayLog.warn(`failed to mark update restart sentinel unhealthy: ${String(err)}`);
        });
        if (hadLock && !(await reacquireLockForInProcessRestart())) {
          return;
        }
        shuttingDown = false;
        restartResolver?.();
        return;
      }
      if (respawn.mode === "supervised") {
        const supervisorMode = detectRespawnSupervisor(process.env, process.platform);
        writeGatewayRestartHandoffSync({
          restartKind: "update-process",
          reason: restartReason,
          processInstanceId,
          supervisorMode: supervisorMode ?? "external",
        });
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
        await markUpdateRestartSentinelFailure("restart-unhealthy").catch((err) => {
          gatewayLog.warn(`failed to mark update restart sentinel unhealthy: ${String(err)}`);
        });
      } else {
        gatewayLog.info(
          `restart mode: in-process restart (${respawn.detail ?? "OPENCLAW_NO_RESPAWN"})`,
        );
      }
      if (hadLock && !(await reacquireLockForInProcessRestart())) {
        return;
      }
      shuttingDown = false;
      restartResolver?.();
      return;
    }

    // Release the lock BEFORE spawning so the child can acquire it immediately.
    const respawn = restartGatewayProcessWithFreshPid();
    if (respawn.mode === "spawned" || respawn.mode === "supervised") {
      const supervisorMode =
        respawn.mode === "supervised"
          ? detectRespawnSupervisor(process.env, process.platform)
          : null;
      const modeLabel =
        respawn.mode === "spawned"
          ? `spawned pid ${respawn.pid ?? "unknown"}`
          : "supervisor restart";
      if (respawn.mode === "supervised") {
        writeGatewayRestartHandoffSync({
          restartKind: "full-process",
          reason: restartReason,
          processInstanceId,
          supervisorMode: supervisorMode ?? "external",
        });
      }
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
    if (hadLock && !(await reacquireLockForInProcessRestart())) {
      return;
    }
    shuttingDown = false;
    restartResolver?.();
  };
  const handleStopAfterServerClose = async () => {
    await releaseLockIfHeld();
    exitProcess(0);
  };

  const SUPERVISOR_STOP_TIMEOUT_MS = 30_000;
  const SHUTDOWN_TIMEOUT_MS = SUPERVISOR_STOP_TIMEOUT_MS - 5_000;
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
      const { getRuntimeConfig, resolveGatewayRestartDeferralTimeoutMs } =
        await loadGatewayLifecycleRuntimeModule();
      const timeoutMs = getRuntimeConfig().gateway?.reload?.deferralTimeoutMs;
      return resolveGatewayRestartDeferralTimeoutMs(timeoutMs);
    } catch {
      return DEFAULT_RESTART_DRAIN_TIMEOUT_MS;
    }
  };

  const request = (
    action: GatewayRunSignalAction,
    signal: string,
    restartReason?: string,
    restartIntent?: RestartIntentOptions,
  ) => {
    if (shuttingDown) {
      gatewayLog.info(`received ${signal} during shutdown; ignoring`);
      return;
    }
    shuttingDown = true;
    const isRestart = action === "restart";
    gatewayLog.info(`received ${signal}; ${isRestart ? "restarting" : "shutting down"}`);

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

    void (async () => {
      const restartDrainTimeoutMs = isRestart
        ? await resolveRestartDrainTimeoutMs(restartIntent)
        : 0;
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

      try {
        // On restart, wait for in-flight agent turns to finish before
        // tearing down the server so buffered messages are delivered.
        if (isRestart) {
          const {
            abortEmbeddedPiRun,
            getInspectableActiveTaskRestartBlockers,
            getActiveEmbeddedRunCount,
            getActiveTaskCount,
            markGatewayDraining,
            waitForActiveEmbeddedRuns,
            waitForActiveTasks,
          } = await loadGatewayLifecycleRuntimeModule();
          const formatTaskBlockers = () => {
            const blockers = getInspectableActiveTaskRestartBlockers();
            if (blockers.length === 0) {
              return null;
            }
            const shown = blockers
              .slice(0, 8)
              .map((task) =>
                [
                  `taskId=${task.taskId}`,
                  task.runId ? `runId=${task.runId}` : null,
                  `status=${task.status}`,
                  `runtime=${task.runtime}`,
                  task.label ? `label=${task.label}` : null,
                  task.title ? `title=${task.title.slice(0, 80)}` : null,
                ]
                  .filter((value): value is string => Boolean(value))
                  .join(" "),
              );
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
          markGatewayDraining();
          const activeTasks = getActiveTaskCount();
          const activeRuns = getActiveEmbeddedRunCount();

          // Best-effort abort for compacting runs so long compaction operations
          // don't hold session write locks across restart boundaries.
          if (activeRuns > 0) {
            abortEmbeddedPiRun(undefined, { mode: "compacting" });
          }

          if (activeTasks > 0 || activeRuns > 0) {
            const taskBlockers = formatTaskBlockers();
            gatewayLog.info(
              `draining ${activeTasks} active task(s) and ${activeRuns} active embedded run(s) before restart ${formatRestartDrainBudget()}`,
            );
            if (taskBlockers) {
              gatewayLog.warn(`restart blocked by active background task run(s): ${taskBlockers}`);
            }
            if (restartIntent?.force) {
              gatewayLog.warn("forced restart requested; skipping active work drain");
              abortEmbeddedPiRun(undefined, { mode: "all" });
            } else {
              const stillPendingDrainLogger = createStillPendingDrainLogger();
              const [tasksDrain, runsDrain] = await Promise.all([
                activeTasks > 0
                  ? waitForActiveTasks(restartDrainTimeoutMs)
                  : Promise.resolve({ drained: true }),
                activeRuns > 0
                  ? waitForActiveEmbeddedRuns(restartDrainTimeoutMs)
                  : Promise.resolve({ drained: true }),
              ]).finally(() => clearInterval(stillPendingDrainLogger));
              if (tasksDrain.drained && runsDrain.drained) {
                gatewayLog.info("all active work drained");
              } else {
                gatewayLog.warn("drain timeout reached; proceeding with restart");
                // Final best-effort abort to avoid carrying active runs into the
                // next lifecycle when drain time budget is exhausted.
                abortEmbeddedPiRun(undefined, { mode: "all" });
              }
            }
          }
        }

        armCloseForceExitTimerForIndefiniteRestart();
        await server?.close({
          reason: isRestart ? "gateway restarting" : "gateway stopping",
          restartExpectedMs: isRestart ? 1500 : null,
        });
      } catch (err) {
        gatewayLog.error(`shutdown error: ${String(err)}`);
      } finally {
        clearForceExitTimer();
        server = null;
        if (isRestart) {
          await handleRestartAfterServerClose(restartReason);
        } else {
          await handleStopAfterServerClose();
        }
      }
    })();
  };

  const onSigterm = () => {
    gatewayLog.info("signal SIGTERM received");
    void (async () => {
      const { consumeGatewayRestartIntentPayloadSync } = await loadGatewayLifecycleRuntimeModule();
      const restartIntent = consumeGatewayRestartIntentPayloadSync();
      request(restartIntent ? "restart" : "stop", "SIGTERM", undefined, restartIntent ?? undefined);
    })();
  };
  const onSigint = () => {
    gatewayLog.info("signal SIGINT received");
    request("stop", "SIGINT");
  };
  const onSigusr1 = () => {
    gatewayLog.info("signal SIGUSR1 received");
    void (async () => {
      const {
        consumeGatewayRestartIntentPayloadSync,
        consumeGatewaySigusr1RestartAuthorization,
        isGatewaySigusr1RestartExternallyAllowed,
        markGatewaySigusr1RestartHandled,
        peekGatewaySigusr1RestartReason,
        scheduleGatewaySigusr1Restart,
      } = await loadGatewayLifecycleRuntimeModule();
      const restartIntent = consumeGatewayRestartIntentPayloadSync();
      if (restartIntent) {
        request("restart", "SIGUSR1", "gateway.restart", restartIntent);
        return;
      }
      const authorized = consumeGatewaySigusr1RestartAuthorization();
      if (!authorized) {
        markGatewaySigusr1RestartHandled();
        if (!isGatewaySigusr1RestartExternallyAllowed()) {
          gatewayLog.warn(
            "SIGUSR1 restart ignored (not authorized; commands.restart=false or use gateway tool).",
          );
          return;
        }
        if (shuttingDown) {
          gatewayLog.info("received SIGUSR1 during shutdown; ignoring");
          return;
        }
        // External SIGUSR1 requests should still reuse the in-process restart
        // scheduler so idle drain and restart coalescing stay consistent.
        scheduleGatewaySigusr1Restart({ delayMs: 0, reason: "SIGUSR1" });
        return;
      }
      const restartReason = peekGatewaySigusr1RestartReason();
      markGatewaySigusr1RestartHandled();
      request("restart", "SIGUSR1", restartReason);
    })();
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
        reloadTaskRegistryFromStore,
        resetAllLanes,
        resetGatewayRestartStateForInProcessRestart,
      } = await loadGatewayLifecycleRuntimeModule();
      resetAllLanes();
      resetGatewayRestartStateForInProcessRestart();
      reloadTaskRegistryFromStore();
    });

    // Keep process alive; SIGUSR1 triggers an in-process restart (no supervisor required).
    // SIGTERM/SIGINT still exit after a graceful shutdown.
    let isFirstStart = true;
    for (;;) {
      await onIteration();
      try {
        server = await params.start({ startupStartedAt });
        isFirstStart = false;
      } catch (err) {
        // On initial startup, let the error propagate so the outer handler
        // can report "Gateway failed to start" and exit non-zero. Only
        // swallow errors on subsequent in-process restarts to keep the
        // process alive (a crash would lose macOS TCC permissions). (#35862)
        if (isFirstStart) {
          throw err;
        }
        server = null;
        // Release the gateway lock so that `daemon restart/stop` (which
        // discovers PIDs via the gateway port) can still manage the process.
        // Without this, the process holds the lock but is not listening,
        // forcing manual cleanup. (#35862)
        await releaseLockIfHeld();
        const errMsg = formatErrorMessage(err);
        const errStack = err instanceof Error && err.stack ? `\n${err.stack}` : "";
        await writeStabilityBundle("gateway.restart_startup_failed", err);
        gatewayLog.error(
          `gateway startup failed: ${errMsg}. ` +
            `Process will stay alive; fix the issue and restart.${errStack}`,
        );
      }
      await new Promise<void>((resolve) => {
        restartResolver = resolve;
      });
    }
  } finally {
    await releaseLockIfHeld();
    cleanupSignals();
  }
}
