import { expectDefined } from "@openclaw/normalization-core";
// Gateway service lifecycle runners, including unmanaged-process fallbacks and restart health checks.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { isRestartEnabled } from "../../config/commands.flags.js";
import { readBestEffortConfig, resolveGatewayPort } from "../../config/config.js";
import { mergeGatewayServiceEnv } from "../../daemon/service-env-merge.js";
import { resolveGatewayService } from "../../daemon/service.js";
import {
  findInstalledSystemdGatewayScope,
  restartSystemdService,
  stopSystemdService,
} from "../../daemon/systemd.js";
import { callGatewayCli } from "../../gateway/call.js";
import { probeGateway } from "../../gateway/probe.js";
import {
  type GatewayLockIdentity,
  isSameGatewayLockIdentity,
  readActiveGatewayLockIdentity,
  readActiveGatewayLockPort,
} from "../../infra/gateway-lock.js";
import {
  findVerifiedGatewayListenerPidsOnPortSync,
  formatGatewayPidList,
  signalVerifiedGatewayPidSync,
} from "../../infra/gateway-processes.js";
import {
  assertGatewayServiceMutationAllowed,
  formatExternalSupervisorActionRequired,
  isGatewayExternallySupervised,
} from "../../infra/gateway-supervision.js";
import {
  clearGatewayRestartIntentSync,
  type GatewayRestartIntent,
  writeGatewayRestartIntentSync,
} from "../../infra/restart-intent.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "../../infra/restart.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import {
  isTerminalInteractive,
  NON_INTERACTIVE_GATEWAY_STOP_MESSAGE,
} from "../terminal-interactivity.js";
import { recoverInstalledLaunchAgent } from "./launchd-recovery.js";
import {
  appendGatewayLifecycleAudit,
  createGatewayLifecycleMutationAudit,
} from "./lifecycle-audit.js";
import {
  runServiceRestart,
  runServiceStart,
  runServiceStop,
  runServiceUninstall,
} from "./lifecycle-core.js";
import {
  requestSafeGatewayRestart,
  resolveGatewayRestartIntentOptions,
} from "./lifecycle-safe-restart.js";
import { createDaemonActionContext, createNullWriter } from "./response.js";
import {
  DEFAULT_RESTART_HEALTH_ATTEMPTS,
  DEFAULT_RESTART_HEALTH_DELAY_MS,
  type GatewayRestartSnapshot,
  renderGatewayPortHealthDiagnostics,
  renderRestartDiagnostics,
  terminateStaleGatewayPids,
  waitForGatewayHealthyListener,
  waitForGatewayHealthyRestart,
} from "./restart-health.js";
import { parsePortFromArgs, renderGatewayServiceStartHints } from "./shared.js";
import { repairLoadedGatewayServiceForStart } from "./start-repair.js";
import type { DaemonLifecycleOptions } from "./types.js";

const POST_RESTART_HEALTH_ATTEMPTS = DEFAULT_RESTART_HEALTH_ATTEMPTS;
const POST_RESTART_HEALTH_DELAY_MS = DEFAULT_RESTART_HEALTH_DELAY_MS;
const WINDOWS_POST_RESTART_HEALTH_TIMEOUT_MS = 180_000;

function postRestartHealthAttempts(): number {
  return process.platform === "win32"
    ? Math.ceil(WINDOWS_POST_RESTART_HEALTH_TIMEOUT_MS / POST_RESTART_HEALTH_DELAY_MS)
    : POST_RESTART_HEALTH_ATTEMPTS;
}

function formatRestartFailure(params: {
  health: GatewayRestartSnapshot;
  port: number;
  defaultTimeoutSeconds: number;
}): { statusLine: string; failMessage: string } {
  if (params.health.waitOutcome === "stopped-free") {
    const elapsedSeconds = Math.max(1, Math.round((params.health.elapsedMs ?? 0) / 1000));
    return {
      statusLine: `Gateway restart failed after ${elapsedSeconds}s: service stayed stopped and port ${params.port} stayed free.`,
      failMessage: `Gateway restart failed after ${elapsedSeconds}s: service stayed stopped and health checks never came up.`,
    };
  }

  const timeoutSeconds = Math.max(
    1,
    Math.round(
      params.health.elapsedMs === undefined
        ? params.defaultTimeoutSeconds
        : params.health.elapsedMs / 1000,
    ),
  );
  return {
    statusLine: `Timed out after ${timeoutSeconds}s waiting for gateway port ${params.port} to become healthy.`,
    failMessage: `Gateway restart timed out after ${timeoutSeconds}s waiting for health checks.`,
  };
}

async function resolveGatewayLifecycleContext(service = resolveGatewayService()): Promise<{
  port: number;
  env: NodeJS.ProcessEnv;
}> {
  const command = await service.readCommand(process.env).catch(() => null);
  const mergedEnv = mergeGatewayServiceEnv(process.env, command);

  const portFromArgs = parsePortFromArgs(command?.programArguments);
  const config = await readBestEffortConfig().catch(() => undefined);
  return {
    port: portFromArgs ?? resolveGatewayPort(config, mergedEnv),
    env: mergedEnv,
  };
}

async function resolveGatewayLifecyclePort(service = resolveGatewayService()) {
  return (await resolveGatewayLifecycleContext(service)).port;
}

function resolveGatewayPortFallback(): Promise<number> {
  return readBestEffortConfig()
    .then((cfg) => resolveGatewayPort(cfg, process.env))
    .catch(() => resolveGatewayPort(undefined, process.env));
}

async function resolveExplicitGatewayConfigPort(): Promise<number | undefined> {
  const cfg = await readBestEffortConfig().catch(() => undefined);
  return cfg?.gateway?.port;
}

async function assertUnmanagedGatewayRestartEnabled(port: number): Promise<void> {
  const cfg = await readBestEffortConfig().catch(() => undefined);
  const tlsEnabled = Boolean(cfg?.gateway?.tls?.enabled);
  const scheme = tlsEnabled ? "wss" : "ws";
  const probe = await probeGateway({
    url: `${scheme}://127.0.0.1:${port}`,
    auth: {
      token: normalizeOptionalString(process.env.OPENCLAW_GATEWAY_TOKEN),
      password: normalizeOptionalString(process.env.OPENCLAW_GATEWAY_PASSWORD),
    },
    timeoutMs: 1_000,
  }).catch(() => null);

  if (!probe?.ok) {
    return;
  }
  if (!isRestartEnabled(probe.configSnapshot as { commands?: unknown } | undefined)) {
    throw new Error(
      "Gateway restart is disabled in the running gateway config (commands.restart=false); unmanaged SIGUSR1 restart would be ignored",
    );
  }
}

function resolveVerifiedGatewayListenerPids(port: number): number[] {
  return findVerifiedGatewayListenerPidsOnPortSync(port).filter(
    (pid): pid is number => Number.isFinite(pid) && pid > 0,
  );
}

async function handleSystemScopeSystemdGateway(
  action: "stop",
): Promise<{ result: "stopped"; message: string } | null>;
async function handleSystemScopeSystemdGateway(
  action: "restart",
): Promise<{ result: "restarted"; message: string } | null>;
async function handleSystemScopeSystemdGateway(
  action: "stop" | "restart",
): Promise<{ result: "stopped" | "restarted"; message: string } | null> {
  if (process.platform !== "linux") {
    return null;
  }
  const installed = await findInstalledSystemdGatewayScope(process.env).catch(() => null);
  if (installed?.scope !== "system") {
    return null;
  }
  const stdout = createNullWriter();
  if (action === "stop") {
    await stopSystemdService({
      stdout,
      env: process.env,
      onMutation: createGatewayLifecycleMutationAudit({ action: "stop" }),
    });
    return {
      result: "stopped",
      message: `Gateway stopped via system-scope systemd unit ${installed.unitName}.`,
    };
  }
  await restartSystemdService({
    stdout,
    env: process.env,
    onMutation: createGatewayLifecycleMutationAudit({ action: "restart" }),
  });
  return {
    result: "restarted",
    message: `Gateway restarted via system-scope systemd unit ${installed.unitName}.`,
  };
}

async function stopGatewayWithoutServiceManager(port: number, lockOwnerPid: number | undefined) {
  const managed = await handleSystemScopeSystemdGateway("stop");
  if (managed) {
    return managed;
  }
  const listenerPids = resolveVerifiedGatewayListenerPids(port);
  // Listener discovery needs lsof, which minimal containers omit. The gateway
  // lock already names the verified owner of this port, so signal it instead of
  // reporting the gateway as not running while it keeps serving.
  const pids = listenerPids.length > 0 ? listenerPids : lockOwnerPid ? [lockOwnerPid] : [];
  if (pids.length === 0) {
    return null;
  }
  for (const pid of pids) {
    signalVerifiedGatewayPidSync(pid, "SIGTERM");
    appendGatewayLifecycleAudit({
      action: "stop",
      source: "cli",
      mode: "sigterm",
      pid,
    });
  }
  return {
    result: "stopped" as const,
    message: `Gateway stop signal sent to unmanaged process${pids.length === 1 ? "" : "es"} on port ${port}: ${formatGatewayPidList(pids)}.`,
  };
}

async function resolveRestartListenerHealthWait(
  restartIntent: GatewayRestartIntent | undefined,
): Promise<{
  attempts: number;
  waitIndefinitelyForPreviousOwner: boolean;
  timeoutSeconds: number;
}> {
  let drainTimeoutMs: number | undefined;
  if (restartIntent?.force) {
    drainTimeoutMs = 0;
  } else if (typeof restartIntent?.waitMs === "number" && Number.isFinite(restartIntent.waitMs)) {
    drainTimeoutMs = restartIntent.waitMs > 0 ? Math.floor(restartIntent.waitMs) : undefined;
  } else {
    drainTimeoutMs = resolveGatewayRestartDeferralTimeoutMs();
  }

  const replacementHealthAttempts = postRestartHealthAttempts();
  if (drainTimeoutMs === undefined) {
    return {
      attempts: replacementHealthAttempts,
      waitIndefinitelyForPreviousOwner: true,
      timeoutSeconds: Math.round((replacementHealthAttempts * POST_RESTART_HEALTH_DELAY_MS) / 1000),
    };
  }
  const attempts =
    replacementHealthAttempts + Math.ceil(drainTimeoutMs / POST_RESTART_HEALTH_DELAY_MS);
  return {
    attempts,
    waitIndefinitelyForPreviousOwner: false,
    timeoutSeconds: Math.round((attempts * POST_RESTART_HEALTH_DELAY_MS) / 1000),
  };
}

async function signalGatewayRestart(
  port: number,
  params: {
    restartIntent?: GatewayRestartIntent;
    enforceRestartConfig: boolean;
    processLabel: string;
    requireLockIdentity?: boolean;
    auditSource: "cli" | "supervisor";
  },
) {
  if (params.enforceRestartConfig) {
    await assertUnmanagedGatewayRestartEnabled(port);
  }
  const pids = resolveVerifiedGatewayListenerPids(port);
  if (pids.length === 0) {
    return null;
  }
  if (pids.length > 1) {
    throw new Error(
      `multiple gateway processes are listening on port ${port}: ${formatGatewayPidList(pids)}; use "openclaw gateway status --deep" before retrying restart`,
    );
  }
  const pid = expectDefined(pids[0], "pids entry at 0");
  const isWindows = process.platform === "win32";
  const requiresTargetedDelivery = params.requireLockIdentity === true || isWindows;
  const previousLockIdentity = requiresTargetedDelivery
    ? await readActiveGatewayLockIdentity()
    : undefined;
  if (
    requiresTargetedDelivery &&
    (!previousLockIdentity ||
      previousLockIdentity.pid !== pid ||
      previousLockIdentity.port !== port)
  ) {
    throw new Error(
      `gateway lock identity does not match the verified listener on port ${port}; refusing an ambiguous restart`,
    );
  }
  const usesTargetedWindowsRpc = isWindows && Boolean(previousLockIdentity?.ownerId);
  const intentWritten = usesTargetedWindowsRpc
    ? false
    : writeGatewayRestartIntentSync({
        targetPid: pid,
        reason: "gateway.restart",
        ...(params.restartIntent ? { intent: params.restartIntent } : {}),
      });
  if (requiresTargetedDelivery && !usesTargetedWindowsRpc && !intentWritten) {
    throw new Error("failed to persist the gateway restart intent");
  }
  try {
    if (previousLockIdentity) {
      const currentLockIdentity = await readActiveGatewayLockIdentity();
      if (
        !currentLockIdentity ||
        !isSameGatewayLockIdentity(previousLockIdentity, currentLockIdentity)
      ) {
        throw new Error(
          `gateway lock owner changed before the restart request could be delivered on port ${port}`,
        );
      }
    }
    if (isWindows) {
      if (previousLockIdentity?.ownerId) {
        await callGatewayCli<{ ok: true; status: "emitted" | "coalesced"; pid: number }>({
          method: "gateway.restart.request",
          params: {
            reason: "gateway.restart",
            target: {
              pid,
              ownerId: previousLockIdentity.ownerId,
              port,
            },
            ...(params.restartIntent ? { restartIntent: params.restartIntent } : {}),
          },
          localPortOverride: port,
          ignoreEnvUrlOverride: true,
          timeoutMs: 10_000,
        });
      } else {
        // Gateways started before lock owner IDs were introduced do not understand the
        // targeted payload. The exact loopback port plus the revalidated legacy lock is
        // the strongest available target; the PID-bound persisted intent carries options.
        await callGatewayCli({
          method: "gateway.restart.request",
          params: {
            reason: "gateway.restart",
            skipDeferral: true,
          },
          localPortOverride: port,
          ignoreEnvUrlOverride: true,
          timeoutMs: 10_000,
        });
      }
    } else {
      signalVerifiedGatewayPidSync(pid, "SIGUSR1");
    }
  } catch (err) {
    if (intentWritten) {
      clearGatewayRestartIntentSync();
    }
    throw err;
  }
  appendGatewayLifecycleAudit({
    action: "restart",
    source: params.auditSource,
    mode: isWindows ? "rpc" : "sigusr1",
    pid,
  });
  return {
    result: "restarted" as const,
    pid,
    previousLockIdentity,
    message: `Gateway restart request sent to ${params.processLabel} process on port ${port}: ${pid}.`,
  };
}

async function restartGatewayWithoutServiceManager(
  port: number,
  restartIntent?: GatewayRestartIntent,
) {
  const managed = await handleSystemScopeSystemdGateway("restart");
  if (managed) {
    return managed;
  }
  return await signalGatewayRestart(port, {
    restartIntent,
    enforceRestartConfig: true,
    processLabel: "unmanaged",
    auditSource: "cli",
  });
}

type GatewaySignalRestartResult = NonNullable<Awaited<ReturnType<typeof signalGatewayRestart>>>;

function isGatewaySignalRestartResult(
  result: Awaited<ReturnType<typeof restartGatewayWithoutServiceManager>>,
): result is GatewaySignalRestartResult {
  return result !== null && "pid" in result && typeof result.pid === "number";
}

async function runExternalSupervisorRestart(opts: DaemonLifecycleOptions): Promise<boolean> {
  const json = Boolean(opts.json);
  const { emit, fail } = createDaemonActionContext({ action: "restart", json });
  const restartIntent = resolveGatewayRestartIntentOptions(opts);
  const configuredPort = await resolveExplicitGatewayConfigPort();
  const port =
    (await readActiveGatewayLockPort().catch(() => undefined)) ??
    configuredPort ??
    (await resolveGatewayPortFallback());

  let signaled: Awaited<ReturnType<typeof signalGatewayRestart>>;
  try {
    signaled = await signalGatewayRestart(port, {
      restartIntent,
      enforceRestartConfig: false,
      processLabel: "externally supervised",
      requireLockIdentity: true,
      auditSource: "supervisor",
    });
  } catch (err) {
    fail(`Gateway restart failed: ${String(err)}`);
    return false;
  }
  if (!signaled) {
    fail(
      `No verified gateway process is listening on port ${port}. ${formatExternalSupervisorActionRequired("start the gateway")}`,
    );
    return false;
  }

  const healthWait = await resolveRestartListenerHealthWait(restartIntent);
  const health = await waitForGatewayHealthyListener({
    port,
    attempts: healthWait.attempts,
    delayMs: POST_RESTART_HEALTH_DELAY_MS,
    previousLockIdentity: signaled.previousLockIdentity,
    waitIndefinitelyForPreviousOwner: healthWait.waitIndefinitelyForPreviousOwner,
  });
  if (!health.healthy) {
    const message = `Gateway restart timed out after ${healthWait.timeoutSeconds}s waiting for health checks.`;
    fail(message, renderGatewayPortHealthDiagnostics(health));
    return false;
  }

  emit({
    ok: true,
    result: signaled.result,
    message: signaled.message,
  });
  if (!json) {
    defaultRuntime.log(signaled.message);
  }
  return true;
}

/** Uninstall the managed Gateway service after stopping it. */
export async function runDaemonUninstall(opts: DaemonLifecycleOptions = {}) {
  assertGatewayServiceMutationAllowed("uninstall the gateway service");
  return await runServiceUninstall({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    opts,
    stopBeforeUninstall: true,
    assertNotLoadedAfterUninstall: true,
  });
}

/** Start the managed Gateway service, repairing stale service definitions when possible. */
export async function runDaemonStart(opts: DaemonLifecycleOptions = {}) {
  assertGatewayServiceMutationAllowed("start the gateway");
  const service = resolveGatewayService();
  const expectedPort = await resolveExplicitGatewayConfigPort();
  return await runServiceStart({
    serviceNoun: "Gateway",
    service,
    renderStartHints: renderGatewayServiceStartHints,
    onNotLoaded:
      process.platform === "darwin"
        ? async () => {
            const recovered = await recoverInstalledLaunchAgent({ result: "started" });
            if (recovered) {
              appendGatewayLifecycleAudit({
                action: "start",
                source: "cli",
                mode: "launchd-bootstrap",
              });
            }
            return recovered;
          }
        : undefined,
    repairLoadedService: async ({ json, stdout, warn, state, issues }) =>
      await repairLoadedGatewayServiceForStart({
        service,
        port: expectedPort,
        json,
        stdout,
        warn,
        state,
        issues,
      }),
    expectedPort,
    opts,
  });
}

/** Stop the managed Gateway service or verified unmanaged listener fallback. */
export async function runDaemonStop(opts: DaemonLifecycleOptions = {}) {
  if (!isTerminalInteractive() && !opts.force) {
    const { fail } = createDaemonActionContext({ action: "stop", json: Boolean(opts.json) });
    fail(NON_INTERACTIVE_GATEWAY_STOP_MESSAGE);
    return;
  }
  assertGatewayServiceMutationAllowed("stop the gateway");
  const service = resolveGatewayService();
  return await runServiceStop({
    serviceNoun: "Gateway",
    service,
    opts,
    stopWhenNotLoaded: process.platform === "darwin" && Boolean(opts.disable),
    onNotLoaded: async ({ stdout }) => {
      if (process.platform === "linux") {
        const runtime = await service.readRuntime(process.env).catch(() => null);
        if (runtime?.status === "running") {
          // systemd can run a disabled unit with Restart=always. Stop it through
          // systemctl so a process-level SIGTERM cannot trigger a respawn.
          await service.stop({
            env: process.env,
            stdout,
            onMutation: createGatewayLifecycleMutationAudit({ action: "stop" }),
          });
          return { result: "stopped" };
        }
      }
      // An unmanaged run loop keeps its lock port across config edits, so use it
      // for discovery the way restart already does; otherwise a valid port
      // override makes the running gateway look like it is already stopped.
      const lockIdentity = await readActiveGatewayLockIdentity().catch(() => undefined);
      const port =
        lockIdentity?.port ??
        (await resolveGatewayLifecyclePort(service).catch(() => resolveGatewayPortFallback()));
      return await stopGatewayWithoutServiceManager(port, lockIdentity?.pid);
    },
  });
}

/** Restart the Gateway service or a verified unmanaged listener, then prove health. */
export async function runDaemonRestart(opts: DaemonLifecycleOptions = {}): Promise<boolean> {
  if (opts.skipDeferral && !opts.safe) {
    throw new Error("--skip-deferral requires --safe");
  }
  if (opts.safe) {
    return await requestSafeGatewayRestart(opts);
  }
  if (isGatewayExternallySupervised()) {
    return await runExternalSupervisorRestart(opts);
  }
  const jsonOutput = Boolean(opts.json);
  const service = resolveGatewayService();
  let restartedWithoutServiceManager = false;
  let unmanagedPreviousLockIdentity: GatewayLockIdentity | undefined;
  const restartIntent = resolveGatewayRestartIntentOptions(opts);
  const configuredPort = await resolveExplicitGatewayConfigPort();
  let managedRestartContext = await resolveGatewayLifecycleContext(service).catch(async () => ({
    port: await resolveGatewayPortFallback(),
    env: process.env,
  }));
  let managedRestartPort = configuredPort ?? managedRestartContext.port;
  // An unmanaged run loop keeps its lock port across in-process restarts, even
  // when config changes underneath it. Use that port for both the signal and
  // health proof or a valid CLI/env override looks like a failed restart.
  const unmanagedPort =
    (await readActiveGatewayLockPort().catch(() => undefined)) ?? managedRestartPort;
  const restartHealthAttempts = postRestartHealthAttempts();
  const restartWaitMs = restartHealthAttempts * POST_RESTART_HEALTH_DELAY_MS;
  const restartWaitSeconds = Math.round(restartWaitMs / 1000);
  let unmanagedRestartHealthAttempts = restartHealthAttempts;
  let unmanagedRestartWaitIndefinitely = false;
  let unmanagedRestartWaitSeconds = restartWaitSeconds;

  return await runServiceRestart({
    serviceNoun: "Gateway",
    service,
    renderStartHints: renderGatewayServiceStartHints,
    opts: {
      ...opts,
      ...(restartIntent ? { restartIntent } : {}),
    },
    checkTokenDrift: true,
    expectedPort: configuredPort,
    repairLoadedService: async ({ json, stdout, warn, state, issues }) => {
      const result = await repairLoadedGatewayServiceForStart({
        action: "restart",
        service,
        port: configuredPort,
        json,
        stdout,
        warn,
        state,
        issues,
      });
      // Repair rewrites the service definition, so the old command environment
      // no longer identifies where the restarted gateway publishes readiness.
      managedRestartContext = await resolveGatewayLifecycleContext(service);
      managedRestartPort = configuredPort ?? managedRestartContext.port;
      return result;
    },
    onNotLoaded: async () => {
      if (process.platform === "darwin") {
        const recovered = await recoverInstalledLaunchAgent({ result: "restarted" });
        if (recovered) {
          appendGatewayLifecycleAudit({
            action: "restart",
            source: "cli",
            mode: "launchd-bootstrap",
          });
          return recovered;
        }
      }
      const handled = await restartGatewayWithoutServiceManager(unmanagedPort, restartIntent);
      if (handled) {
        restartedWithoutServiceManager = true;
        if (isGatewaySignalRestartResult(handled) && handled.previousLockIdentity) {
          unmanagedPreviousLockIdentity = handled.previousLockIdentity;
          const healthWait = await resolveRestartListenerHealthWait(restartIntent);
          unmanagedRestartHealthAttempts = healthWait.attempts;
          unmanagedRestartWaitIndefinitely = healthWait.waitIndefinitelyForPreviousOwner;
          unmanagedRestartWaitSeconds = healthWait.timeoutSeconds;
        }
        return handled;
      }
      return null;
    },
    postRestartCheck: async ({ warnings, fail, stdout, warn }) => {
      if (restartedWithoutServiceManager) {
        // Unmanaged restarts have no service-manager state to watch; use listener health and,
        // when targeted delivery required it, prove the previous lock owner was replaced.
        const health = await waitForGatewayHealthyListener({
          port: unmanagedPort,
          attempts: unmanagedRestartHealthAttempts,
          delayMs: POST_RESTART_HEALTH_DELAY_MS,
          ...(unmanagedPreviousLockIdentity
            ? {
                previousLockIdentity: unmanagedPreviousLockIdentity,
                waitIndefinitelyForPreviousOwner: unmanagedRestartWaitIndefinitely,
              }
            : {}),
        });
        if (health.healthy) {
          return undefined;
        }

        const diagnostics = renderGatewayPortHealthDiagnostics(health);
        const timeoutLine = `Timed out after ${unmanagedRestartWaitSeconds}s waiting for gateway port ${unmanagedPort} to become healthy.`;
        if (!jsonOutput) {
          defaultRuntime.log(theme.warn(timeoutLine));
          for (const line of diagnostics) {
            defaultRuntime.log(theme.muted(line));
          }
        } else {
          warnings.push(timeoutLine);
          warnings.push(...diagnostics);
        }

        fail(
          `Gateway restart timed out after ${unmanagedRestartWaitSeconds}s waiting for health checks.`,
          [formatCliCommand("openclaw gateway status --deep"), formatCliCommand("openclaw doctor")],
        );
        throw new Error("unreachable after gateway restart health failure");
      }

      let health = await waitForGatewayHealthyRestart({
        service,
        port: managedRestartPort,
        attempts: restartHealthAttempts,
        delayMs: POST_RESTART_HEALTH_DELAY_MS,
        env: managedRestartContext.env,
        includeUnknownListenersAsStale: process.platform === "win32",
        supervisorKeepsAlive: process.platform === "darwin",
      });

      if (!health.healthy && health.staleGatewayPids.length > 0) {
        // On Windows service restarts can leave stale listeners behind; kill verified stale
        // Gateway pids once, restart again, then re-run the same health proof.
        const staleMsg = `Found stale gateway process(es): ${health.staleGatewayPids.join(", ")}.`;
        warnings.push(staleMsg);
        if (!jsonOutput) {
          defaultRuntime.log(theme.warn(staleMsg));
          defaultRuntime.log(theme.muted("Stopping stale process(es) and retrying restart..."));
        }

        await terminateStaleGatewayPids(health.staleGatewayPids);
        const retryRestart = await service.restart({
          env: process.env,
          stdout,
          warn,
          onMutation: createGatewayLifecycleMutationAudit({ action: "restart" }),
        });
        if (retryRestart.outcome === "scheduled") {
          return retryRestart;
        }
        health = await waitForGatewayHealthyRestart({
          service,
          port: managedRestartPort,
          attempts: restartHealthAttempts,
          delayMs: POST_RESTART_HEALTH_DELAY_MS,
          env: managedRestartContext.env,
          includeUnknownListenersAsStale: process.platform === "win32",
          supervisorKeepsAlive: process.platform === "darwin",
        });
      }

      if (health.healthy) {
        return undefined;
      }

      const diagnostics = renderRestartDiagnostics(health);
      const failure = formatRestartFailure({
        health,
        port: managedRestartPort,
        defaultTimeoutSeconds: restartWaitSeconds,
      });
      const runningNoPortLine =
        health.runtime.status === "running" && health.portUsage.status === "free"
          ? `Gateway process is running but port ${managedRestartPort} is still free (startup hang/crash loop or very slow VM startup).`
          : null;
      if (!jsonOutput) {
        defaultRuntime.log(theme.warn(failure.statusLine));
        if (runningNoPortLine) {
          defaultRuntime.log(theme.warn(runningNoPortLine));
        }
        for (const line of diagnostics) {
          defaultRuntime.log(theme.muted(line));
        }
      } else {
        warnings.push(failure.statusLine);
        if (runningNoPortLine) {
          warnings.push(runningNoPortLine);
        }
        warnings.push(...diagnostics);
      }

      fail(failure.failMessage, [
        formatCliCommand("openclaw gateway status --deep"),
        formatCliCommand("openclaw doctor"),
      ]);
      throw new Error("unreachable after gateway restart failure");
    },
  });
}
