/** LaunchAgent stop semantics and in-service maintenance parking. */
import { formatPortDiagnostics } from "../infra/ports-format.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import { probePortUsage } from "../infra/ports-probe.js";
import { cleanStaleGatewayProcessesSync } from "../infra/restart-stale-pids.js";
import { sleep } from "../utils.js";
import { isCurrentProcessLaunchdServiceLabel } from "./launchd-current-service.js";
import {
  execLaunchctl,
  formatLaunchctlResultDetail,
  isLaunchctlNotLoaded,
} from "./launchd-exec.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "./launchd-plist.js";
import { scheduleDetachedLaunchdMaintenancePark } from "./launchd-restart-handoff.js";
import {
  resolveLaunchAgentGatewayContext,
  resolveLaunchAgentGuiDomain,
  waitForLaunchAgentStopped,
} from "./launchd-runtime.js";
import { formatLine } from "./output.js";
import { createGatewayLifecycleMutationReporter } from "./service-mutation.js";
import type { GatewayServiceControlArgs, GatewayServiceEnv } from "./service-types.js";

const LAUNCH_AGENT_STOP_PORT_RELEASE_TIMEOUT_MS = LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS * 1_000;
const LAUNCH_AGENT_STOP_PORT_RELEASE_POLL_MS = 100;
async function bootoutLaunchAgentOrThrow(params: {
  serviceTarget: string;
  warning: string;
  stdout: NodeJS.WritableStream;
  onMutation?: () => void;
}): Promise<void> {
  const bootout = await execLaunchctl(["bootout", params.serviceTarget]);
  if (bootout.code !== 0 && !isLaunchctlNotLoaded(bootout)) {
    throw new Error(
      `${params.warning}; launchctl bootout failed: ${formatLaunchctlResultDetail(bootout)}`,
    );
  }
  params.onMutation?.();
  params.stdout.write(`${formatLine("Warning", params.warning)}\n`);
}
async function waitForGatewayPortRelease(
  port: number,
  probeHosts: readonly string[],
): Promise<boolean> {
  const deadline = Date.now() + LAUNCH_AGENT_STOP_PORT_RELEASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(Math.min(LAUNCH_AGENT_STOP_PORT_RELEASE_POLL_MS, deadline - Date.now()));
    const status = await probePortUsage(port, probeHosts);
    if (status === "free") {
      return true;
    }
  }
  return false;
}

async function assertGatewayPortReleasedAfterStop(env: GatewayServiceEnv): Promise<void> {
  const { port, probeHosts } = await resolveLaunchAgentGatewayContext(env);
  if (port === null) {
    return;
  }
  cleanStaleGatewayProcessesSync(port);
  const diagnostics = await inspectPortUsage(port, {
    probeHosts,
  }).catch(() => null);
  if (diagnostics?.status !== "busy") {
    return;
  }
  if (await waitForGatewayPortRelease(port, probeHosts)) {
    return;
  }
  throw new Error(
    [
      `gateway port ${port} is still busy after LaunchAgent stop`,
      ...formatPortDiagnostics(diagnostics),
    ].join("\n"),
  );
}

export async function stopLaunchAgent({
  stdout,
  env,
  disable: persistDisable,
  onMutation,
}: GatewayServiceControlArgs): Promise<void> {
  const serviceEnv = env ?? (process.env as GatewayServiceEnv);
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(serviceEnv);
  const serviceTarget = `${domain}/${label}`;
  const reportMutation = createGatewayLifecycleMutationReporter(onMutation);

  if (
    isCurrentProcessLaunchdServiceLabel(label, process.env, { allowConfiguredLabelFallback: false })
  ) {
    throw new Error(
      `Refusing to stop LaunchAgent ${label} from inside the same launchd service; run this command from an external shell.`,
    );
  }

  if (!persistDisable) {
    // Default: bootout only. Removes the job from the current launchd domain without
    // persisting a disable, so KeepAlive auto-recovery survives future crashes and
    // `openclaw gateway start` re-enables cleanly without a manual `launchctl enable`.
    const bootout = await execLaunchctl(["bootout", serviceTarget]);
    if (bootout.code !== 0 && !isLaunchctlNotLoaded(bootout)) {
      throw new Error(`launchctl bootout failed: ${formatLaunchctlResultDetail(bootout)}`);
    }
    reportMutation("bootout");
    await assertGatewayPortReleasedAfterStop(serviceEnv);
    stdout.write(`${formatLine("Stopped LaunchAgent", serviceTarget)}\n`);
    return;
  }

  // --disable: persistently suppress KeepAlive/RunAtLoad before stopping.
  // Without this, launchd can relaunch the process as soon as `stop` exits.
  const disableResult = await execLaunchctl(["disable", serviceTarget]);
  if (disableResult.code !== 0) {
    await bootoutLaunchAgentOrThrow({
      serviceTarget,
      stdout,
      warning: `launchctl disable failed; used bootout fallback and left service unloaded: ${formatLaunchctlResultDetail(disableResult)}`,
      onMutation: () => reportMutation("disable-bootout"),
    });
    await assertGatewayPortReleasedAfterStop(serviceEnv);
    stdout.write(`${formatLine("Stopped LaunchAgent (degraded)", serviceTarget)}\n`);
    return;
  }
  reportMutation("disable");

  // `launchctl stop` targets the plain label (not the fully-qualified service target).
  const stop = await execLaunchctl(["stop", label]);
  if (stop.code !== 0 && !isLaunchctlNotLoaded(stop)) {
    await bootoutLaunchAgentOrThrow({
      serviceTarget,
      stdout,
      warning: `launchctl stop failed; used bootout fallback and left service unloaded: ${formatLaunchctlResultDetail(stop)}`,
      onMutation: () => reportMutation("disable-bootout"),
    });
    await assertGatewayPortReleasedAfterStop(serviceEnv);
    stdout.write(`${formatLine("Stopped LaunchAgent (degraded)", serviceTarget)}\n`);
    return;
  }

  reportMutation("disable-stop");

  const stopState = await waitForLaunchAgentStopped(serviceTarget);
  if (stopState.state !== "stopped" && stopState.state !== "not-loaded") {
    const warning =
      stopState.state === "unknown"
        ? `launchctl print could not confirm stop; used bootout fallback and left service unloaded: ${stopState.detail ?? "unknown error"}`
        : "launchctl stop did not fully stop the service; used bootout fallback and left service unloaded";
    await bootoutLaunchAgentOrThrow({
      serviceTarget,
      stdout,
      warning,
      onMutation: () => reportMutation("disable-bootout"),
    });
    await assertGatewayPortReleasedAfterStop(serviceEnv);
    stdout.write(`${formatLine("Stopped LaunchAgent (degraded)", serviceTarget)}\n`);
    return;
  }

  await assertGatewayPortReleasedAfterStop(serviceEnv);
  stdout.write(`${formatLine("Stopped LaunchAgent", serviceTarget)}\n`);
}

export async function parkCurrentLaunchAgentForMaintenance(
  params: {
    env?: GatewayServiceEnv;
  } = {},
): Promise<boolean> {
  const serviceEnv = params.env ?? (process.env as GatewayServiceEnv);
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(serviceEnv);
  if (
    !isCurrentProcessLaunchdServiceLabel(label, process.env, {
      allowConfiguredLabelFallback: false,
    })
  ) {
    return false;
  }
  const serviceTarget = `${domain}/${label}`;
  // Disable before exit so KeepAlive cannot spawn a replacement before the
  // detached handoff can boot the current job out of launchd.
  const disable = await execLaunchctl(["disable", serviceTarget]);
  if (disable.code !== 0) {
    throw new Error(
      `launchctl disable failed while parking ${serviceTarget}: ${formatLaunchctlResultDetail(disable)}`,
    );
  }
  const handoff = scheduleDetachedLaunchdMaintenancePark({
    env: serviceEnv,
    waitForPid: process.pid,
  });
  const handoffError = !handoff.ok
    ? handoff.error
    : (await handoff.value)
      ? undefined
      : "helper failed to spawn";
  if (handoffError) {
    const rollback = await execLaunchctl(["enable", serviceTarget]);
    const rollbackDetail =
      rollback.code === 0
        ? "restored launchd enable state"
        : `launchctl enable rollback failed: ${formatLaunchctlResultDetail(rollback)}`;
    throw new Error(`launchd maintenance park handoff failed: ${handoffError}; ${rollbackDetail}`);
  }
  return true;
}
