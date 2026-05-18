import { randomUUID } from "node:crypto";
import net from "node:net";
import {
  captureGatewayRestartTraceHandoff,
  createGatewayRestartTraceHandoffEnv,
  measureGatewayRestartTrace,
  markGatewayRestartTrace,
  startGatewayRestartTrace,
} from "../../gateway/restart-trace.js";
import type { startGatewayServer } from "../../gateway/server.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";

const gatewayLog = createSubsystemLogger("gateway");
const LAUNCHD_SUPERVISED_RESTART_EXIT_DELAY_MS = 1500;
const DEFAULT_RESTART_DRAIN_TIMEOUT_MS = 300_000;
const RESTART_ACTIVE_EMBEDDED_RUN_ABORT_GRACE_MS = 30_000;
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
  // The HTTP server can report ready before params.start returns its close handle.
  // Defer lifecycle signals from that window until the loop can close and advance.
  let pendingStartupRequest: GatewayRunSignalRequest | null = null;
  let pendingStartupForceExitTimer: ReturnType<typeof setTimeout> | null = null;
  let restartDrainingMarkPromise: Promise<void> | null = null;
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
        markGatewayRestartTrace("restart.full-process-handoff", [
          ["kind", "update-process"],
          ["mode", respawn.mode],
          ["supervisorMode", supervisorMode ?? "external"],
        ]);
        writeGatewayRestartHandoffSync({
          restartKind: "update-process",
          reason: restartReason,
          processInstanceId,
          supervisorMode: supervisorMode ?? "external",
          restartTrace: captureGatewayRestartTraceHandoff(),
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
      if (!(await reacquireLockForInProcessRestart())) {
        return;
      }
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
          ? detectRespawnSupervisor(process.env, process.platform)
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
        writeGatewayRestartHandoffSync({
          restartKind: "full-process",
          reason: restartReason,
          processInstanceId,
          supervisorMode: supervisorMode ?? "external",
          restartTrace: captureGatewayRestartTraceHandoff(),
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
    if (!(await reacquireLockForInProcessRestart())) {
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
      const { getRuntimeConfig, resolveGatewayRestartDeferralTimeoutMs } =
        await loadGatewayLifecycleRuntimeModule();
      const timeoutMs = getRuntimeConfig().gateway?.reload?.deferralTimeoutMs;
      return resolveGatewayRestartDeferralTimeoutMs(timeoutMs);
    } catch {
      return DEFAULT_RESTART_DRAIN_TIMEOUT_MS;
    }
  };
  const markRestartDraining = async () => {
    if (!restartDrainingMarkPromise) {
      restartDrainingMarkPromise = (async () => {
        const { markGatewayDraining } = await loadGatewayLifecycleRuntimeModule();
        markGatewayDraining();
      })().catch((err) => {
        restartDrainingMarkPromise = null;
        throw err;
      });
    }
    await restartDrainingMarkPromise;
  };

  const runAcceptedRequest = ({
    action,
    restartReason,
    restartIntent,
  }: GatewayRunSignalRequest) => {
    const isRestart = action === "restart";
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
      const resolveActiveRunDrainWaitMs = (activeRuns: number): RestartDrainTimeoutMs => {
        if (activeRuns <= 0) {
          return restartDrainTimeoutMs;
        }
        if (restartDrainTimeoutMs === undefined) {
          return RESTART_ACTIVE_EMBEDDED_RUN_ABORT_GRACE_MS;
        }
        return Math.min(restartDrainTimeoutMs, RESTART_ACTIVE_EMBEDDED_RUN_ABORT_GRACE_MS);
      };
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
                abortEmbeddedPiRun,
                getRuntimeConfig,
                getInspectableActiveTaskRestartBlockers,
                getActiveEmbeddedRunCount,
                getActiveTaskCount,
                listActiveEmbeddedRunSessionIds,
                listActiveEmbeddedRunSessionKeys,
                markRestartAbortedMainSessions,
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
              await markRestartDraining();
              const activeTasks = getActiveTaskCount();
              const activeRuns = getActiveEmbeddedRunCount();
              activeTasksAtDrainStart = activeTasks;
              activeRunsAtDrainStart = activeRuns;
              activeRestartSessionKeysAtDrainStart = collectActiveRestartSessionKeys();
              activeRestartSessionIdsAtDrainStart = collectActiveRestartSessionIds();

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
                  gatewayLog.warn(
                    `restart blocked by active background task run(s): ${taskBlockers}`,
                  );
                }
                if (restartIntent?.force) {
                  gatewayLog.warn("forced restart requested; skipping active work drain");
                  await markActiveMainSessionsForRestart("forced gateway restart");
                  abortEmbeddedPiRun(undefined, { mode: "all" });
                } else {
                  const activeRunDrainWaitMs = resolveActiveRunDrainWaitMs(activeRuns);
                  const stillPendingDrainLogger = createStillPendingDrainLogger();
                  let abortedAfterRunGrace = false;
                  let tasksDrain: { drained: boolean } = { drained: true };
                  let runsDrain: { drained: boolean } = { drained: true };
                  try {
                    const tasksDrainPromise =
                      activeTasks > 0
                        ? waitForActiveTasks(restartDrainTimeoutMs)
                        : Promise.resolve({ drained: true });
                    runsDrain =
                      activeRuns > 0
                        ? await waitForActiveEmbeddedRuns(activeRunDrainWaitMs)
                        : { drained: true };
                    if (!runsDrain.drained && activeRuns > 0) {
                      gatewayLog.warn(
                        "active embedded run drain grace reached; aborting active run(s) before restart",
                      );
                      abortEmbeddedPiRun(undefined, { mode: "all" });
                      abortedAfterRunGrace = true;
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
                    if (!abortedAfterRunGrace) {
                      abortEmbeddedPiRun(undefined, { mode: "all" });
                    }
                  }
                }
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
    shuttingDown = true;
    const isRestart = action === "restart";
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
      void markRestartDraining().catch((err) => {
        gatewayLog.warn(`failed to mark gateway draining for startup restart: ${String(err)}`);
      });
      armPendingStartupForceExitTimer();
      return;
    }
    runAcceptedRequest(acceptedRequest);
  };

  const onSigterm = () => {
    gatewayLog.info("signal SIGTERM received");
    void (async () => {
      const { consumeGatewayRestartIntentPayloadSync } = await loadGatewayLifecycleRuntimeModule();
      const restartIntent = consumeGatewayRestartIntentPayloadSync();
      request(
        restartIntent ? "restart" : "stop",
        "SIGTERM",
        restartIntent?.reason,
        restartIntent ?? undefined,
      );
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
        request("restart", "SIGUSR1", restartIntent.reason ?? "gateway.restart", restartIntent);
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
      markGatewayRestartTrace("restart.next-start");
    });

    // Keep process alive; SIGUSR1 triggers an in-process restart (no supervisor required).
    // SIGTERM/SIGINT still exit after a graceful shutdown.
    let isFirstStart = true;
    for (;;) {
      await onIteration();
      restartDrainingMarkPromise = null;
      let startupFailedBeforeServerHandle = false;
      try {
        server = await params.start({ startupStartedAt });
        startupFailedWithoutServerHandle = false;
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
