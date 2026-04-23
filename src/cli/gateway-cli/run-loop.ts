import {
  abortEmbeddedPiRun,
  getActiveEmbeddedRunCount,
  waitForActiveEmbeddedRuns,
} from "../../agents/pi-embedded-runner/runs.js";
import { loadConfig } from "../../config/config.js";
import type { startGatewayServer } from "../../gateway/server.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { restartGatewayProcessWithFreshPid } from "../../infra/process-respawn.js";
import {
  consumeGatewaySigusr1RestartAuthorization,
  isGatewaySigusr1RestartExternallyAllowed,
  markGatewaySigusr1RestartHandled,
  scheduleGatewaySigusr1Restart,
} from "../../infra/restart.js";
import { detectRespawnSupervisor } from "../../infra/supervisor-markers.js";
import { writeDiagnosticStabilityBundleForFailureSync } from "../../logging/diagnostic-stability-bundle.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getActiveTaskCount,
  markGatewayDraining,
  resetAllLanes,
  waitForActiveTasks,
} from "../../process/command-queue.js";
import { createRestartIterationHook } from "../../process/restart-recovery.js";
import type { RuntimeEnv } from "../../runtime.js";

const gatewayLog = createSubsystemLogger("gateway");
const LAUNCHD_SUPERVISED_RESTART_EXIT_DELAY_MS = 1500;
const DEFAULT_RESTART_DRAIN_TIMEOUT_MS = 300_000;

type GatewayRunSignalAction = "stop" | "restart";

export async function runGatewayLoop(params: {
  start: (params?: {
    startupStartedAt?: number;
  }) => Promise<Awaited<ReturnType<typeof startGatewayServer>>>;
  runtime: RuntimeEnv;
  lockPort?: number;
}) {
  let startupStartedAt = Date.now();
  let lock = await acquireGatewayLock({ port: params.lockPort });
  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  let shuttingDown = false;
  let restartResolver: (() => void) | null = null;

  const cleanupSignals = () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGUSR1", onSigusr1);
  };
  const exitProcess = (code: number) => {
    cleanupSignals();
    params.runtime.exit(code);
  };
  const writeStabilityBundle = (reason: string, error?: unknown) => {
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
  const handleRestartAfterServerClose = async () => {
    const hadLock = await releaseLockIfHeld();
    // Release the lock BEFORE spawning so the child can acquire it immediately.
    const respawn = restartGatewayProcessWithFreshPid();
    if (respawn.mode === "spawned" || respawn.mode === "supervised") {
      const modeLabel =
        respawn.mode === "spawned"
          ? `spawned pid ${respawn.pid ?? "unknown"}`
          : "supervisor restart";
      gatewayLog.info(`restart mode: full process restart (${modeLabel})`);
      if (
        respawn.mode === "supervised" &&
        detectRespawnSupervisor(process.env, process.platform) === "launchd"
      ) {
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
      writeStabilityBundle("gateway.restart_respawn_failed");
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
  const resolveRestartDrainTimeoutMs = () => {
    try {
      const timeoutMs = loadConfig().gateway?.reload?.deferralTimeoutMs;
      return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0
        ? timeoutMs
        : DEFAULT_RESTART_DRAIN_TIMEOUT_MS;
    } catch {
      return DEFAULT_RESTART_DRAIN_TIMEOUT_MS;
    }
  };

  const request = (action: GatewayRunSignalAction, signal: string) => {
    if (shuttingDown) {
      gatewayLog.info(`received ${signal} during shutdown; ignoring`);
      return;
    }
    shuttingDown = true;
    const isRestart = action === "restart";
    const restartDrainTimeoutMs = isRestart ? resolveRestartDrainTimeoutMs() : 0;
    gatewayLog.info(`received ${signal}; ${isRestart ? "restarting" : "shutting down"}`);

    // Allow extra time for draining active turns on restart.
    const forceExitMs = isRestart
      ? restartDrainTimeoutMs + SHUTDOWN_TIMEOUT_MS
      : SHUTDOWN_TIMEOUT_MS;
    const forceExitTimer = setTimeout(() => {
      gatewayLog.error("shutdown timed out; exiting without full cleanup");
      writeStabilityBundle(
        isRestart ? "gateway.restart_shutdown_timeout" : "gateway.stop_shutdown_timeout",
      );
      // Keep the in-process watchdog below the supervisor stop budget so this
      // path wins before launchd/systemd escalates to a hard kill. Exit
      // non-zero on any timeout so supervised installs restart cleanly.
      exitProcess(1);
    }, forceExitMs);

    void (async () => {
      try {
        // On restart, wait for in-flight agent turns to finish before
        // tearing down the server so buffered messages are delivered.
        if (isRestart) {
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
            gatewayLog.info(
              `draining ${activeTasks} active task(s) and ${activeRuns} active embedded run(s) before restart (timeout ${restartDrainTimeoutMs}ms)`,
            );
            const [tasksDrain, runsDrain] = await Promise.all([
              activeTasks > 0
                ? waitForActiveTasks(restartDrainTimeoutMs)
                : Promise.resolve({ drained: true }),
              activeRuns > 0
                ? waitForActiveEmbeddedRuns(restartDrainTimeoutMs)
                : Promise.resolve({ drained: true }),
            ]);
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

        await server?.close({
          reason: isRestart ? "gateway restarting" : "gateway stopping",
          restartExpectedMs: isRestart ? 1500 : null,
        });
      } catch (err) {
        gatewayLog.error(`shutdown error: ${String(err)}`);
      } finally {
        clearTimeout(forceExitTimer);
        server = null;
        if (isRestart) {
          await handleRestartAfterServerClose();
        } else {
          await handleStopAfterServerClose();
        }
      }
    })();
  };

  const onSigterm = () => {
    gatewayLog.info("signal SIGTERM received");
    request("stop", "SIGTERM");
  };
  const onSigint = () => {
    gatewayLog.info("signal SIGINT received");
    request("stop", "SIGINT");
  };
  const onSigusr1 = () => {
    gatewayLog.info("signal SIGUSR1 received");
    const authorized = consumeGatewaySigusr1RestartAuthorization();
    if (!authorized) {
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
    markGatewaySigusr1RestartHandled();
    request("restart", "SIGUSR1");
  };

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("SIGUSR1", onSigusr1);

  try {
    const onIteration = createRestartIterationHook(() => {
      // After an in-process restart (SIGUSR1), reset command-queue lane state.
      // Interrupted tasks from the previous lifecycle may have left `active`
      // counts elevated (their finally blocks never ran), permanently blocking
      // new work from draining. This must happen here — at the restart
      // coordinator level — rather than inside individual subsystem init
      // functions, to avoid surprising cross-cutting side effects.
      resetAllLanes();
    });

    // Keep process alive; SIGUSR1 triggers an in-process restart (no supervisor required).
    // SIGTERM/SIGINT still exit after a graceful shutdown.
    let isFirstStart = true;
    for (;;) {
      onIteration();
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
        writeStabilityBundle("gateway.restart_startup_failed", err);
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
