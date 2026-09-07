import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isGatewayArgv } from "../infra/gateway-process-argv.js";
import { sleep } from "../utils.js";
import { resolveGatewayServiceProbeHosts } from "./gateway-service-probe-hosts.js";
import { formatLine } from "./output.js";
import { execSchtasks } from "./schtasks-exec.js";
import {
  readScheduledTaskCommand,
  resolveTaskName,
  resolveTaskScriptPath,
} from "./schtasks-layout.js";
import {
  findInstalledProcessPid,
  isNodeHostArgv,
  readWindowsProcessSnapshot,
  resolveScheduledTaskCommandPort,
  resolveScheduledTaskGatewayContext,
  resolveScheduledTaskOwnedGatewayPids,
  shouldManageGatewayListenerPort,
  terminateGatewayProcessTree,
  terminateScheduledTaskGatewayListeners,
  terminateScheduledTaskNodeHost,
  waitForGatewayPortRelease,
} from "./schtasks-process.js";
import {
  assertSchtasksAvailable,
  isRegisteredScheduledTask,
  isScheduledTaskDefinitelyNotRunning,
  isStartupEntryInstalled,
  launchFallbackTaskScript,
  readScheduledTaskRuntime,
  removeStartupEntries,
  resolveFallbackRuntime,
  restartStartupEntry,
  startStartupEntry,
  stopStartupEntry,
  SCHEDULED_TASK_FALLBACK_POLL_MS,
  SCHEDULED_TASK_FALLBACK_TIMEOUT_MS,
  terminateInstalledStartupRuntime,
  waitForScheduledTaskRunningEvidence,
} from "./schtasks-runtime.js";
import { probeScheduledTaskExists } from "./schtasks-state-probe.js";
import { ScheduledTaskAutoStartRecoveryError } from "./schtasks-update-recovery.js";
import { createGatewayLifecycleMutationReporter } from "./service-mutation.js";
import type {
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceRestartResult,
} from "./service-types.js";

export type ScheduledTaskActivation = "scheduled-task" | "direct-fallback";

function runtimeSignature(runtime: Awaited<ReturnType<typeof readScheduledTaskRuntime>> | null) {
  return [runtime?.state, runtime?.lastRunTime, runtime?.lastRunResult, runtime?.detail]
    .filter(Boolean)
    .join("|");
}

async function shouldFallbackScheduledTaskLaunch(params: {
  env: GatewayServiceEnv;
  scriptPath: string;
}): Promise<boolean> {
  const readLaunchObservation = async (): Promise<{
    state: "running" | "not-yet-run" | "stopped-success" | "other";
    signature: string;
  }> => {
    const runtime = await readScheduledTaskRuntime(params.env).catch(() => null);
    if (runtime?.status === "running") {
      return { state: "running", signature: runtimeSignature(runtime) };
    }
    if (runtime?.status !== "stopped") {
      return { state: "other", signature: runtimeSignature(runtime) };
    }
    // SCHED_S_TASK_HAS_NOT_RUN is history, and only a stopped task is a fallback candidate.
    if (runtime.lastRunResult === "267011") {
      return { state: "not-yet-run", signature: runtimeSignature(runtime) };
    }
    return runtime.lastRunResult === "0"
      ? { state: "stopped-success", signature: runtimeSignature(runtime) }
      : { state: "other", signature: runtimeSignature(runtime) };
  };

  const hasLaunchEvidence = async (): Promise<boolean> => {
    const command = await readScheduledTaskCommand(params.env).catch(() => null);
    const installedArguments = command?.programArguments;
    const taskPort = resolveScheduledTaskCommandPort(params.env, command);
    const manageGatewayPort = shouldManageGatewayListenerPort(params.env);
    if (manageGatewayPort && taskPort) {
      const probeHosts = await resolveGatewayServiceProbeHosts({ env: params.env, command });
      const ownedPids = await resolveScheduledTaskOwnedGatewayPids(
        params.env,
        { port: taskPort, probeHosts },
        command,
      );
      if (ownedPids.length > 0) {
        return true;
      }
    }

    const scriptPathNeedle = normalizeLowercaseStringOrEmpty(
      params.scriptPath.replaceAll("/", "\\"),
    );
    if (!scriptPathNeedle) {
      return false;
    }
    const entries = readWindowsProcessSnapshot();
    if (!entries) {
      return false;
    }
    if (
      entries.some((entry) =>
        normalizeLowercaseStringOrEmpty(entry.CommandLine ?? "")
          .replaceAll("/", "\\")
          .includes(scriptPathNeedle),
      )
    ) {
      return true;
    }
    if (!taskPort) {
      return false;
    }
    if (!installedArguments?.length) {
      return false;
    }
    return (
      findInstalledProcessPid(
        entries,
        taskPort,
        installedArguments,
        manageGatewayPort
          ? (argv) => isGatewayArgv(argv, { allowGatewayBinary: true })
          : isNodeHostArgv,
      ) != null
    );
  };

  let previous = await readLaunchObservation();
  if (previous.state !== "not-yet-run" && previous.state !== "stopped-success") {
    return false;
  }
  const deadline = Date.now() + SCHEDULED_TASK_FALLBACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(SCHEDULED_TASK_FALLBACK_POLL_MS);
    const current = await readLaunchObservation();
    if (current.state !== "not-yet-run" && current.state !== "stopped-success") {
      return false;
    }
    if (
      current.state === "not-yet-run" &&
      previous.state === "not-yet-run" &&
      current.signature !== previous.signature
    ) {
      return false;
    }
    // A queued task may finish before its process is observable; the reverse transition means a new run is starting.
    if (previous.state === "stopped-success" && current.state === "not-yet-run") {
      return false;
    }
    previous = current;
    if (await hasLaunchEvidence()) {
      return false;
    }
  }
  return true;
}

export async function runScheduledTaskOrThrow(params: {
  taskName: string;
  env: GatewayServiceEnv;
  scriptPath: string;
  onMutation?: () => void;
}): Promise<ScheduledTaskActivation> {
  const run = await execSchtasks(["/Run", "/TN", params.taskName]);
  if (run.code !== 0) {
    throw new Error(`schtasks run failed: ${run.stderr || run.stdout}`.trim());
  }
  params.onMutation?.();
  if (
    !(await shouldFallbackScheduledTaskLaunch({ env: params.env, scriptPath: params.scriptPath }))
  ) {
    return "scheduled-task";
  }
  if (!shouldManageGatewayListenerPort(params.env)) {
    await launchFallbackTaskScript(params.env);
    return "direct-fallback";
  }
  throw new Error(
    `Scheduled Task ${params.taskName} did not start within ${SCHEDULED_TASK_FALLBACK_TIMEOUT_MS / 1000}s after schtasks /Run; refusing a direct fallback because the queued task could still start.`,
  );
}

function parseScheduledTaskXmlEnabled(output: string): boolean | null {
  const normalized = output.replace(/^\uFEFF/u, "").replaceAll(String.fromCharCode(0), "");
  const settings = /<Settings(?:\s[^>]*)?>([\s\S]*?)<\/Settings>/iu.exec(normalized)?.[1];
  if (settings === undefined) {
    return null;
  }
  const enabled = /<Enabled>\s*(true|false)\s*<\/Enabled>/iu.exec(settings)?.[1];
  // Task Scheduler's schema defaults a missing Settings.Enabled value to true.
  return enabled === undefined ? true : enabled.toLowerCase() === "true";
}

async function changeScheduledTaskEnabledState(params: {
  env: GatewayServiceEnv;
  enabled: boolean;
  beforeMutation?: () => Promise<void>;
  restoreOnFailure?: boolean;
}): Promise<boolean> {
  const taskName = resolveTaskName(params.env);
  if (!params.enabled) {
    const query = await execSchtasks(["/Query", "/TN", taskName, "/XML"]);
    if (query.code !== 0) {
      const taskExists = probeScheduledTaskExists(taskName);
      if (taskExists === false) {
        return false;
      }
      const detail = (query.stderr || query.stdout).trim() || "unknown error";
      throw new Error(`schtasks XML query failed: ${detail}`);
    }
    const enabled = parseScheduledTaskXmlEnabled(query.stdout);
    if (enabled === null) {
      throw new Error("schtasks XML query did not expose the task enabled state");
    }
    if (!enabled) {
      return false;
    }
  }

  const action = params.enabled ? "/ENABLE" : "/DISABLE";
  await params.beforeMutation?.();
  const result = await execSchtasks(["/Change", "/TN", taskName, action]);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim() || "unknown error";
    const changeError = new Error(
      `schtasks ${params.enabled ? "enable" : "disable"} failed: ${detail}`,
    );
    if (!params.enabled && params.restoreOnFailure !== false) {
      // A timeout can follow a committed /DISABLE, so restore the proven prior state.
      try {
        await params.beforeMutation?.();
        const restore = await execSchtasks(["/Change", "/TN", taskName, "/ENABLE"]);
        if (restore.code !== 0) {
          const restoreDetail = (restore.stderr || restore.stdout).trim() || "unknown error";
          throw new Error(`schtasks enable failed: ${restoreDetail}`);
        }
      } catch (restoreError) {
        throw new ScheduledTaskAutoStartRecoveryError(
          [changeError, restoreError],
          `Scheduled Task disable failed and its enabled state could not be restored: ${changeError.message}; ${String(restoreError)}`,
          params.env,
        );
      }
    }
    throw changeError;
  }
  return true;
}

export async function suspendScheduledTaskAutoStartForUpdate(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
  options?: { beforeMutation?: () => Promise<void>; restoreOnFailure?: boolean },
): Promise<boolean> {
  return changeScheduledTaskEnabledState({ env, enabled: false, ...options });
}

export async function resumeScheduledTaskAutoStartAfterUpdate(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
  options?: { beforeMutation?: () => Promise<void> },
): Promise<boolean> {
  return changeScheduledTaskEnabledState({ env, enabled: true, ...options });
}

async function shouldControlStartupEntry(env: GatewayServiceEnv): Promise<boolean> {
  try {
    await assertSchtasksAvailable();
  } catch (err) {
    if (!(await isStartupEntryInstalled(env))) {
      throw err;
    }
    return true;
  }
  return !(await isRegisteredScheduledTask(env)) && (await isStartupEntryInstalled(env));
}

export async function stopScheduledTask({
  stdout,
  env,
  onMutation,
}: GatewayServiceControlArgs): Promise<void> {
  const effectiveEnv = env ?? (process.env as GatewayServiceEnv);
  const reportMutation = createGatewayLifecycleMutationReporter(onMutation);
  if (await shouldControlStartupEntry(effectiveEnv)) {
    await stopStartupEntry(effectiveEnv, stdout, () => reportMutation("startup-entry-stop"));
    return;
  }
  const taskName = resolveTaskName(effectiveEnv);
  const res = await execSchtasks(["/End", "/TN", taskName]);
  if (res.code !== 0 && !isScheduledTaskDefinitelyNotRunning(taskName)) {
    throw new Error(`schtasks end failed: ${res.stderr || res.stdout}`.trim());
  }
  reportMutation("schtasks-stop");
  const manageGatewayPort = shouldManageGatewayListenerPort(effectiveEnv);
  const stopContext = manageGatewayPort
    ? await resolveScheduledTaskGatewayContext(effectiveEnv)
    : null;
  const stopPort = stopContext?.port ?? null;
  if (manageGatewayPort) {
    await terminateScheduledTaskGatewayListeners(effectiveEnv, stopContext ?? undefined);
  } else {
    await terminateScheduledTaskNodeHost(effectiveEnv);
  }
  await terminateInstalledStartupRuntime(effectiveEnv);
  if (stopPort) {
    const probeHosts = stopContext?.probeHosts ?? [];
    const released = await waitForGatewayPortRelease(stopPort, 5_000, { probeHosts });
    if (!released) {
      throw new Error(
        `gateway port ${stopPort} is still busy after stop; remaining listener ownership could not be verified`,
      );
    }
  }
  stdout.write(`${formatLine("Stopped Scheduled Task", taskName)}\n`);
}

export async function startScheduledTask({
  stdout,
  env,
  onMutation,
}: GatewayServiceControlArgs): Promise<void> {
  const effectiveEnv = env ?? (process.env as GatewayServiceEnv);
  const reportMutation = createGatewayLifecycleMutationReporter(onMutation);
  if (await shouldControlStartupEntry(effectiveEnv)) {
    await startStartupEntry(effectiveEnv, stdout, () => reportMutation("startup-entry-start"));
    return;
  }
  const taskName = resolveTaskName(effectiveEnv);
  await runScheduledTaskOrThrow({
    taskName,
    env: effectiveEnv,
    scriptPath: resolveTaskScriptPath(effectiveEnv),
    onMutation: () => reportMutation("schtasks-start"),
  });
  stdout.write(`${formatLine("Started Scheduled Task", taskName)}\n`);
}

export async function restartRegisteredScheduledTask(params: {
  preserveDefinition?: boolean;
  env: GatewayServiceEnv;
  stdout: NodeJS.WritableStream;
  mode: { kind: "standard" } | { kind: "fallback-takeover" };
  onEndMutation?: () => void;
  onRunMutation?: () => void;
}): Promise<GatewayServiceRestartResult> {
  const taskName = resolveTaskName(params.env);
  const end = await execSchtasks(["/End", "/TN", taskName]);
  if (end.code === 0) {
    params.onEndMutation?.();
  }
  const manageGatewayPort = shouldManageGatewayListenerPort(params.env);
  const restartContext = manageGatewayPort
    ? await resolveScheduledTaskGatewayContext(params.env)
    : null;
  const restartPort = restartContext?.port ?? null;
  if (params.mode.kind === "standard") {
    if (manageGatewayPort) {
      await terminateScheduledTaskGatewayListeners(params.env, restartContext ?? undefined);
    } else {
      await terminateScheduledTaskNodeHost(params.env);
    }
    await terminateInstalledStartupRuntime(params.env);
  } else {
    const replacementRuntime = await resolveFallbackRuntime(params.env, undefined, "control");
    if (replacementRuntime.status === "unknown") {
      throw new Error(
        replacementRuntime.detail ??
          "Could not verify the replacement Windows Scheduled Task process.",
      );
    }
    if (replacementRuntime.status === "running" && replacementRuntime.pid) {
      await terminateGatewayProcessTree(replacementRuntime.pid, 300);
    }
  }
  if (restartPort) {
    const probeHosts = restartContext?.probeHosts ?? [];
    const released = await waitForGatewayPortRelease(restartPort, 5_000, { probeHosts });
    if (!released) {
      if (params.mode.kind === "fallback-takeover") {
        throw new Error(
          `replacement gateway port ${restartPort} is occupied by an unverified process`,
        );
      }
      throw new Error(
        `gateway port ${restartPort} is still busy before restart; remaining listener ownership could not be verified`,
      );
    }
  }
  const activation = await runScheduledTaskOrThrow({
    taskName,
    env: params.env,
    scriptPath: resolveTaskScriptPath(params.env),
    ...(params.onRunMutation ? { onMutation: params.onRunMutation } : {}),
  });
  // A direct launch is the replacement fallback; keep it available at the next login.
  const shouldRemoveStartup =
    activation === "scheduled-task" &&
    !params.preserveDefinition &&
    (await isStartupEntryInstalled(params.env));
  if (
    activation === "scheduled-task" &&
    (params.mode.kind === "fallback-takeover" || shouldRemoveStartup)
  ) {
    // Captured takeover owns the settling wait even if Startup vanished or its profile changed.
    const hasRunningEvidence = await waitForScheduledTaskRunningEvidence(params.env);
    if (params.mode.kind === "fallback-takeover" && !hasRunningEvidence) {
      await execSchtasks(["/End", "/TN", taskName]);
      const failedRuntime = await resolveFallbackRuntime(params.env, undefined, "control").catch(
        () => null,
      );
      if (failedRuntime?.status === "running" && failedRuntime.pid) {
        await terminateGatewayProcessTree(failedRuntime.pid, 300);
      }
      throw new Error("Replacement Windows Scheduled Task did not produce running evidence.");
    }
    if (shouldRemoveStartup && hasRunningEvidence) {
      await removeStartupEntries(params.env, params.stdout);
    }
  }
  params.stdout.write(`${formatLine("Restarted Scheduled Task", taskName)}\n`);
  return { outcome: "completed" };
}

export async function restartScheduledTask({
  preserveDefinition,
  stdout,
  env,
  onMutation,
}: GatewayServiceControlArgs): Promise<GatewayServiceRestartResult> {
  const effectiveEnv = env ?? (process.env as GatewayServiceEnv);
  const reportMutation = createGatewayLifecycleMutationReporter(onMutation);
  if (await shouldControlStartupEntry(effectiveEnv)) {
    return restartStartupEntry(effectiveEnv, stdout, (kind) =>
      reportMutation(kind === "stop" ? "startup-entry-stop" : "startup-entry-restart"),
    );
  }
  return restartRegisteredScheduledTask({
    preserveDefinition,
    env: effectiveEnv,
    stdout,
    mode: { kind: "standard" },
    onEndMutation: () => reportMutation("schtasks-end"),
    onRunMutation: () => reportMutation("schtasks-restart"),
  });
}
