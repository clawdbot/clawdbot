/** LaunchAgent bootstrap recovery plus start and restart lifecycle controls. */
import { spawnSync } from "node:child_process";
import { formatPortDiagnostics } from "../infra/ports-format.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import { cleanStaleGatewayProcessesSync } from "../infra/restart-stale-pids.js";
import { isCurrentProcessLaunchdServiceLabel } from "./launchd-current-service.js";
import {
  execLaunchctl,
  formatLaunchctlResultDetail,
  isLaunchctlNotLoaded,
} from "./launchd-exec.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { scheduleDetachedLaunchdRestartHandoff } from "./launchd-restart-handoff.js";
import {
  bootstrapLaunchAgentOrThrow,
  isLaunchctlAlreadyLoaded,
  isUnsupportedGuiDomain,
  parseLaunchctlPrint,
  readLaunchAgentRuntime,
  resolveLaunchAgentGatewayContext,
  resolveLaunchAgentGuiDomain,
} from "./launchd-runtime.js";
import {
  resolveLaunchAgentPlistPath,
  rewriteLaunchAgentPlistForRestart,
} from "./launchd-service-files.js";
import {
  assertNoSystemLaunchDaemonOwnership,
  isSystemLaunchDaemonOwnershipError,
} from "./launchd-system.js";
import { formatLine } from "./output.js";
import { createGatewayLifecycleMutationReporter } from "./service-mutation.js";
import type {
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceRestartResult,
} from "./service-types.js";

const LAUNCHCTL_PROTECTED_PID_TIMEOUT_MS = 2_000;
function readLaunchAgentPidForCleanupSync(serviceTarget: string): number {
  const probe = spawnSync("launchctl", ["print", serviceTarget], {
    encoding: "utf8",
    timeout: LAUNCHCTL_PROTECTED_PID_TIMEOUT_MS,
  });
  const result = {
    stdout: probe.stdout ?? "",
    stderr: probe.error?.message ?? probe.stderr ?? "",
    code: probe.error ? 1 : (probe.status ?? 1),
  };
  if (result.code !== 0) {
    throw new Error(`launchctl print failed: ${formatLaunchctlResultDetail(result)}`);
  }
  const pid = parseLaunchctlPrint(result.stdout || result.stderr || "").pid;
  if (pid === undefined) {
    throw new Error("launchctl print did not report a running pid");
  }
  return pid;
}

type LaunchAgentBootstrapRepairResult =
  | { ok: true; status: "repaired" | "already-loaded" }
  | {
      ok: false;
      status: "bootstrap-failed" | "kickstart-failed";
      detail?: string;
    }
  | {
      ok: false;
      status: "system-launchdaemon-conflict" | "system-launchdaemon-unverifiable";
      detail: string;
    }
  | { ok: false; status: "gui-session-unavailable"; detail: string; domain: string };

export async function repairLaunchAgentBootstrap(args: {
  env?: Record<string, string | undefined>;
  warn?: (message: string) => void;
}): Promise<LaunchAgentBootstrapRepairResult> {
  const env = args.env ?? (process.env as Record<string, string | undefined>);
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(env);
  const plistPath = resolveLaunchAgentPlistPath(env);
  const serviceTarget = `${domain}/${label}`;
  try {
    await assertNoSystemLaunchDaemonOwnership(label);
  } catch (error) {
    if (!isSystemLaunchDaemonOwnershipError(error)) {
      throw error;
    }
    return {
      ok: false,
      status:
        error.ownership.status === "unverifiable"
          ? "system-launchdaemon-unverifiable"
          : "system-launchdaemon-conflict",
      detail: error.message,
    };
  }
  // Rewrite first so legacy inline environment secrets move into the private
  // env file before the plist becomes world-readable for launchd.
  const warn = args.warn ?? ((message: string) => console.warn(formatLine("Warning", message)));
  await rewriteLaunchAgentPlistForRestart({ env, label, plistPath, warn });
  await execLaunchctl(["enable", serviceTarget]);
  const boot = await execLaunchctl(["bootstrap", domain, plistPath]);
  let repairStatus: "repaired" | "already-loaded" = "repaired";
  if (boot.code !== 0) {
    const detail = (boot.stderr || boot.stdout).trim();
    if (isUnsupportedGuiDomain(detail)) {
      return {
        ok: false,
        status: "gui-session-unavailable",
        detail,
        domain,
      };
    }
    if (!isLaunchctlAlreadyLoaded(boot)) {
      return { ok: false, status: "bootstrap-failed", detail: detail || undefined };
    }
    repairStatus = "already-loaded";
  }
  if (repairStatus === "repaired") {
    return { ok: true, status: repairStatus };
  }

  // Service is already bootstrapped. Only kickstart if it is not actively running —
  // kickstarting a healthy running service causes unnecessary session disconnects.
  const runtime = await readLaunchAgentRuntime(env);
  if (runtime.status === "running") {
    return { ok: true, status: repairStatus };
  }

  const kick = await execLaunchctl(["kickstart", serviceTarget]);
  if (kick.code !== 0) {
    return {
      ok: false,
      status: "kickstart-failed",
      detail: (kick.stderr || kick.stdout).trim() || undefined,
    };
  }
  return { ok: true, status: repairStatus };
}
type LaunchAgentRestoreResult = { loaded: true } | { loaded: false; detail: string };

function writeLaunchAgentActionLine(
  stdout: NodeJS.WritableStream,
  label: string,
  value: string,
): void {
  try {
    stdout.write(`${formatLine(label, value)}\n`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "EPIPE") {
      throw err;
    }
  }
}

async function ensureLaunchAgentLoadedAfterFailure(params: {
  domain: string;
  serviceTarget: string;
  plistPath: string;
  onMutation?: (mode: "enable" | "bootstrap") => void;
}): Promise<LaunchAgentRestoreResult> {
  const probe = await execLaunchctl(["print", params.serviceTarget]);
  if (probe.code === 0) {
    return { loaded: true };
  }
  try {
    await bootstrapLaunchAgentOrThrow({
      domain: params.domain,
      serviceTarget: params.serviceTarget,
      plistPath: params.plistPath,
      actionHint: "openclaw gateway start",
      onMutation: params.onMutation,
    });
    return { loaded: true };
  } catch (error) {
    // A failed restore is not recoverable by launchd: the label is gone, so
    // KeepAlive has nothing to respawn. Report it instead of dropping it.
    return { loaded: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function formatLaunchAgentLeftUnloadedError(params: {
  domain: string;
  serviceTarget: string;
  plistPath: string;
  failure: string;
  restoreDetail: string;
}): string {
  return [
    params.failure,
    `LaunchAgent ${params.serviceTarget} is not loaded and could not be restored: ${params.restoreDetail}`,
    "The gateway is down and launchd has no job left to respawn it.",
    `Fix: run \`openclaw gateway start\`, or \`launchctl bootstrap ${params.domain} ${params.plistPath}\`.`,
  ].join("\n");
}

export async function startLaunchAgent({
  stdout,
  env,
  onMutation,
}: GatewayServiceControlArgs): Promise<void> {
  const serviceEnv = env ?? (process.env as GatewayServiceEnv);
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(serviceEnv);
  const plistPath = resolveLaunchAgentPlistPath(serviceEnv);
  const serviceTarget = `${domain}/${label}`;
  const reportMutation = createGatewayLifecycleMutationReporter(onMutation);
  await assertNoSystemLaunchDaemonOwnership(label);

  // Enable is an independent mutation; audit it even if the later launch fails.
  const enable = await execLaunchctl(["enable", serviceTarget]);
  const enabled = enable.code === 0;
  if (enabled) {
    reportMutation("enable");
  }

  let start = await execLaunchctl(["kickstart", serviceTarget]);
  if (isLaunchctlNotLoaded(start)) {
    await bootstrapLaunchAgentOrThrow({
      domain,
      serviceTarget,
      plistPath,
      actionHint: "openclaw gateway start",
      onMutation: reportMutation,
      skipEnable: enabled,
    });
    // Loading does not start demand-only jobs. Without -k, an auto-started job is left running.
    start = await execLaunchctl(["kickstart", serviceTarget]);
  }
  if (start.code !== 0) {
    throw new Error(`launchctl kickstart failed: ${start.stderr || start.stdout}`.trim());
  }
  reportMutation("kickstart");

  writeLaunchAgentActionLine(stdout, "Started LaunchAgent", serviceTarget);
}

export async function restartLaunchAgent({
  preserveDefinition,
  stdout,
  env,
  warn,
  onMutation,
}: GatewayServiceControlArgs): Promise<GatewayServiceRestartResult> {
  const serviceEnv = env ?? (process.env as GatewayServiceEnv);
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(serviceEnv);
  const plistPath = resolveLaunchAgentPlistPath(serviceEnv);
  const serviceTarget = `${domain}/${label}`;
  const reportMutation = createGatewayLifecycleMutationReporter(onMutation);
  await assertNoSystemLaunchDaemonOwnership(label);

  const detached = isCurrentProcessLaunchdServiceLabel(label);
  if (!detached) {
    const { port: cleanupPort, probeHosts } = await resolveLaunchAgentGatewayContext(serviceEnv);
    if (cleanupPort !== null) {
      cleanStaleGatewayProcessesSync(cleanupPort, {
        // Resolve after lsof captures its listener snapshot. A KeepAlive respawn
        // during enumeration must be protected before candidate filtering/signals.
        resolveProtectedPid: () => readLaunchAgentPidForCleanupSync(serviceTarget),
      });
      const diagnostics = await inspectPortUsage(cleanupPort, {
        probeHosts,
      }).catch(() => null);
      if (diagnostics?.status === "busy") {
        const runtime = await readLaunchAgentRuntime(serviceEnv);
        const managedPid = runtime.pid;
        // Only the current supervised PID may keep the port busy before a
        // disruptive restart. Re-read after cleanup to close over a concurrent
        // launchd respawn rather than trusting the protected pre-cleanup PID.
        const ownedByLaunchAgent =
          managedPid !== undefined &&
          diagnostics.listeners.length > 0 &&
          diagnostics.listeners.every((listener) => listener.pid === managedPid);
        if (!ownedByLaunchAgent) {
          throw new Error(
            [
              `gateway port ${cleanupPort} is busy but is not verifiably owned by LaunchAgent ${label}`,
              ...formatPortDiagnostics(diagnostics),
            ].join("\n"),
          );
        }
      }
    }
  }
  // Preservation permits native activation only, including detached handoffs.
  const plistReloadNeeded =
    !preserveDefinition &&
    (await rewriteLaunchAgentPlistForRestart({
      env: serviceEnv,
      label,
      plistPath,
      stdout,
      warn,
    }));
  // Restart requests issued from inside the managed gateway process tree need a
  // detached handoff. A direct `kickstart -k` would terminate the caller before
  // it can finish the restart command.
  if (detached) {
    const handoff = scheduleDetachedLaunchdRestartHandoff({
      env: serviceEnv,
      mode: plistReloadNeeded ? "reload" : "kickstart",
      waitForPid: process.pid,
    });
    if (!handoff.ok) {
      throw new Error(`launchd restart handoff failed: ${handoff.error}`);
    }
    reportMutation(plistReloadNeeded ? "handoff-reload" : "handoff-kickstart");
    writeLaunchAgentActionLine(stdout, "Scheduled LaunchAgent restart", serviceTarget);
    return { outcome: "scheduled" };
  }

  // `openclaw gateway restart` is an explicit operator request to bring the
  // LaunchAgent back, so clear any persisted disabled state before restart.
  const enable = await execLaunchctl(["enable", serviceTarget]);
  if (enable.code === 0) {
    reportMutation("enable");
  }

  if (plistReloadNeeded) {
    const bootout = await execLaunchctl(["bootout", serviceTarget]);
    if (bootout.code !== 0 && !isLaunchctlNotLoaded(bootout)) {
      throw new Error(`launchctl bootout failed: ${formatLaunchctlResultDetail(bootout)}`);
    }
    if (bootout.code === 0) {
      reportMutation("bootout");
    }
    try {
      await bootstrapLaunchAgentOrThrow({
        domain,
        serviceTarget,
        plistPath,
        actionHint: "openclaw gateway restart",
        onMutation: reportMutation,
        retryPendingTeardown: true,
      });
    } catch (error) {
      // bootout already removed the job from the domain, so a failed bootstrap
      // leaves the gateway down with no KeepAlive respawn to recover it. Restore
      // the job before surfacing the original failure, as the kickstart path does.
      const restored = await ensureLaunchAgentLoadedAfterFailure({
        domain,
        serviceTarget,
        plistPath,
        onMutation: reportMutation,
      });
      if (restored.loaded) {
        throw error;
      }
      throw new Error(
        formatLaunchAgentLeftUnloadedError({
          domain,
          serviceTarget,
          plistPath,
          failure: error instanceof Error ? error.message : String(error),
          restoreDetail: restored.detail,
        }),
        { cause: error },
      );
    }
    writeLaunchAgentActionLine(stdout, "Restarted LaunchAgent", serviceTarget);
    return { outcome: "completed" };
  }

  const start = await execLaunchctl(["kickstart", "-k", serviceTarget]);
  if (start.code === 0) {
    reportMutation("kickstart");
    writeLaunchAgentActionLine(stdout, "Restarted LaunchAgent", serviceTarget);
    return { outcome: "completed" };
  }

  if (!isLaunchctlNotLoaded(start)) {
    const restored = await ensureLaunchAgentLoadedAfterFailure({
      domain,
      serviceTarget,
      plistPath,
      onMutation: reportMutation,
    });
    const failure = `launchctl kickstart failed: ${start.stderr || start.stdout}`.trim();
    if (restored.loaded) {
      throw new Error(failure);
    }
    throw new Error(
      formatLaunchAgentLeftUnloadedError({
        domain,
        serviceTarget,
        plistPath,
        failure,
        restoreDetail: restored.detail,
      }),
    );
  }

  // A preserved plist may be demand-only; bootstrap alone only registers it.
  await bootstrapLaunchAgentOrThrow({
    domain,
    serviceTarget,
    plistPath,
    actionHint: "openclaw gateway restart",
    onMutation: reportMutation,
  });
  if (preserveDefinition) {
    const kick = await execLaunchctl(["kickstart", serviceTarget]);
    if (kick.code !== 0) {
      throw new Error(`launchctl kickstart failed: ${kick.stderr || kick.stdout}`.trim());
    }
    reportMutation("kickstart");
  }
  writeLaunchAgentActionLine(stdout, "Restarted LaunchAgent", serviceTarget);
  return { outcome: "completed" };
}
