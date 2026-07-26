/** Windows Task Scheduler installation and migration. */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { encodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import { resolveGatewayServiceDescription } from "./constants.js";
import { formatLine, writeFormattedLines } from "./output.js";
import { execSchtasks } from "./schtasks-exec.js";
import {
  assertReplacementPortAvailableForTakeover,
  resolveFallbackRuntime,
  resolveScheduledTaskPort,
  shouldManageGatewayListenerPort,
  terminateBusyPortListeners,
  terminateGatewayProcessTree,
  terminateScheduledTaskGatewayListeners,
  terminateScheduledTaskNodeHost,
  waitForGatewayPortRelease,
} from "./schtasks-process.js";
import {
  assertSchtasksAvailable,
  hasScheduledTaskRunningEvidence,
  isRegisteredScheduledTask,
  isStartupEntryInstalled,
  launchFallbackTaskScript,
  removeStartupEntries,
  restartStartupEntry,
  runScheduledTaskOrThrow,
  startStartupEntry,
  stopStartupEntry,
  terminateInstalledStartupRuntime,
  type ScheduledTaskActivation,
  waitForFallbackTakeoverRuntime,
  waitForScheduledTaskRunningEvidence,
} from "./schtasks-runtime.js";
import {
  buildHiddenLauncherScript,
  buildScheduledTaskXml,
  buildStartupLauncherScript,
  buildTaskScript,
  quoteSchtasksArg,
  readScheduledTaskCommand,
  resolveSchtasksCreateUser,
  resolveStartupEntryPath,
  resolveTaskLauncherScriptPath,
  resolveTaskName,
  resolveTaskScriptPath,
  resolveTaskUser,
  shouldFallbackToStartupEntry,
  shouldUseHiddenWindowsTaskLauncher,
  writeTaskXmlTempFile,
} from "./schtasks-script.js";
import { createGatewayLifecycleMutationReporter } from "./service-mutation.js";
import type {
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
  GatewayServiceRestartResult,
} from "./service-types.js";

const CALLER_OWNED_SERVICE_IDENTITY_KEYS = [
  "OPENCLAW_LAUNCHD_LABEL",
  "OPENCLAW_SYSTEMD_UNIT",
  "OPENCLAW_WINDOWS_TASK_NAME",
] as const;

function resolveScheduledTaskRenderEnv(
  env: GatewayServiceEnv,
  environment: GatewayServiceEnv | undefined,
): GatewayServiceEnv {
  if (!environment) {
    return env;
  }
  const merged = { ...env, ...environment };
  for (const key of CALLER_OWNED_SERVICE_IDENTITY_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      merged[key] = value;
    }
  }
  return merged;
}

function resolveScheduledTaskScriptEnvironment(
  taskEnv: GatewayServiceEnv,
  environment: GatewayServiceEnv | undefined,
): GatewayServiceEnv | undefined {
  const scriptEnv = environment ? { ...environment } : {};
  for (const key of CALLER_OWNED_SERVICE_IDENTITY_KEYS) {
    const value = taskEnv[key]?.trim();
    if (value) {
      scriptEnv[key] = value;
    }
  }
  return Object.keys(scriptEnv).length > 0 ? scriptEnv : undefined;
}

const SCHEDULED_TASK_ACTIVATION_KEYS = [
  "OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER",
  "OPENCLAW_TASK_SCRIPT_NAME",
  "OPENCLAW_TASK_SCRIPT",
  "OPENCLAW_SERVICE_KIND",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_PROFILE",
] as const;

function resolveScheduledTaskActivationEnv(
  env: GatewayServiceEnv,
  environment: GatewayServiceEnv | undefined,
): GatewayServiceEnv {
  if (!environment) {
    return env;
  }
  const activationEnv = { ...env };
  for (const key of SCHEDULED_TASK_ACTIVATION_KEYS) {
    const value = environment[key];
    if (value !== undefined) {
      activationEnv[key] = value;
    }
  }
  return activationEnv;
}

async function writeScheduledTaskScript({
  env,
  programArguments,
  workingDirectory,
  environment,
  description,
}: Omit<GatewayServiceInstallArgs, "stdout">): Promise<{
  scriptPath: string;
  taskLaunchPath: string;
  taskDescription: string;
  taskEnv: GatewayServiceEnv;
}> {
  await assertSchtasksAvailable().catch(() => undefined);
  const taskEnv = resolveScheduledTaskRenderEnv(env, environment);
  const scriptPath = resolveTaskScriptPath(taskEnv);
  const taskLaunchPath = resolveTaskLauncherScriptPath(taskEnv, scriptPath);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  const taskDescription = resolveGatewayServiceDescription({
    env: taskEnv,
    environment,
    description,
  });
  const scriptEnvironment = resolveScheduledTaskScriptEnvironment(taskEnv, environment);
  const script = buildTaskScript({
    description: taskDescription,
    programArguments,
    workingDirectory,
    environment: scriptEnvironment,
  });
  await fs.writeFile(scriptPath, encodeWindowsLauncherScript({ format: "cmd", content: script }));
  if (taskLaunchPath !== scriptPath) {
    const launcher = buildHiddenLauncherScript({
      description: taskDescription,
      scriptPath,
    });
    await fs.writeFile(
      taskLaunchPath,
      encodeWindowsLauncherScript({ format: "vbs", content: launcher }),
    );
  }
  return { scriptPath, taskLaunchPath, taskDescription, taskEnv };
}

export async function stageScheduledTask({
  stdout,
  ...args
}: GatewayServiceInstallArgs): Promise<{ scriptPath: string }> {
  const { scriptPath } = await writeScheduledTaskScript(args);
  writeFormattedLines(stdout, [{ label: "Staged task script", value: scriptPath }], {
    leadingBlankLine: true,
  });
  return { scriptPath };
}

async function updateExistingScheduledTask(params: {
  env: GatewayServiceEnv;
  stdout: NodeJS.WritableStream;
  taskName: string;
  quotedLaunchPath: string;
  scriptPath: string;
  taskLaunchPath: string;
  description?: string;
}): Promise<ScheduledTaskActivation | null> {
  if (!(await isRegisteredScheduledTask(params.env))) {
    return null;
  }
  const change = await execSchtasks([
    "/Change",
    "/TN",
    params.taskName,
    "/TR",
    params.quotedLaunchPath,
  ]);
  if (change.code !== 0) {
    return null;
  }
  // Re-apply the full XML on top of the `/Change` so tasks installed by older
  // versions inherit the `<DisallowStartIfOnBatteries>false</...>` and
  // `<StopIfGoingOnBatteries>false</...>` flags on upgrade (#59299). Best
  // effort: a non-zero result here leaves the existing settings in place, so
  // upgraders keep the prior buggy defaults rather than losing the task.
  const upgradeXmlPath = await writeTaskXmlTempFile(
    buildScheduledTaskXml({
      taskDescription: params.description ?? "OpenClaw Gateway",
      taskUser: resolveTaskUser(params.env),
      launchPath: params.taskLaunchPath,
    }),
  );
  try {
    await execSchtasks(["/Create", "/F", "/TN", params.taskName, "/XML", upgradeXmlPath]);
  } finally {
    await fs.rm(path.dirname(upgradeXmlPath), { recursive: true, force: true }).catch(() => {});
  }
  const activation = await runScheduledTaskOrThrow({
    taskName: params.taskName,
    env: params.env,
    scriptPath: params.scriptPath,
  });
  writeFormattedLines(
    params.stdout,
    [
      { label: "Updated Scheduled Task", value: params.taskName },
      { label: "Task script", value: params.scriptPath },
    ],
    { leadingBlankLine: true },
  );
  return activation;
}

async function activateScheduledTask(params: {
  env: GatewayServiceEnv;
  stdout: NodeJS.WritableStream;
  scriptPath: string;
  taskLaunchPath: string;
  description?: string;
}): Promise<ScheduledTaskActivation | "startup-fallback"> {
  const taskDescription = params.description ?? "OpenClaw Gateway";

  const taskName = resolveTaskName(params.env);
  const quotedLaunchPath = quoteSchtasksArg(params.taskLaunchPath);

  const existingActivation = await updateExistingScheduledTask({
    ...params,
    taskName,
    quotedLaunchPath,
  });
  if (existingActivation) {
    return existingActivation;
  }

  const taskUser = resolveTaskUser(params.env);
  // Use `schtasks /Create /XML` so the task carries explicit
  // `DisallowStartIfOnBatteries=false` and `StopIfGoingOnBatteries=false`
  // settings. The CLI flag form (`/Create /SC ONLOGON ...`) cannot set those
  // flags and inherits the Task Scheduler defaults (both true), which kills
  // the Gateway when a laptop unplugs from AC power (#59299).
  const xmlPath = await writeTaskXmlTempFile(
    buildScheduledTaskXml({
      taskDescription,
      taskUser,
      launchPath: params.taskLaunchPath,
    }),
  );
  let create: Awaited<ReturnType<typeof execSchtasks>>;
  try {
    const xmlArgs = ["/Create", "/F", "/TN", taskName, "/XML", xmlPath];
    const createUser = resolveSchtasksCreateUser(params.env, taskUser);
    const xmlArgsWithUser = createUser ? [...xmlArgs, "/RU", createUser, "/NP"] : xmlArgs;
    create = await execSchtasks(xmlArgsWithUser);
    if (create.code !== 0 && createUser) {
      // Retry without the elevated `/RU` form, matching the pre-XML behavior
      // for accounts whose service password cannot be stored.
      create = await execSchtasks(xmlArgs);
    }
  } finally {
    await fs.rm(path.dirname(xmlPath), { recursive: true, force: true }).catch(() => {});
  }
  if (create.code !== 0) {
    const detail = create.stderr || create.stdout;
    if (shouldFallbackToStartupEntry({ code: create.code, detail })) {
      const startupEntryPath = resolveStartupEntryPath(params.env);
      await fs.mkdir(path.dirname(startupEntryPath), { recursive: true });
      const useHiddenLauncher = shouldUseHiddenWindowsTaskLauncher(params.env);
      const launcher = useHiddenLauncher
        ? buildHiddenLauncherScript({
            description: taskDescription,
            scriptPath: params.scriptPath,
          })
        : buildStartupLauncherScript({
            description: taskDescription,
            scriptPath: params.scriptPath,
          });
      await fs.writeFile(
        startupEntryPath,
        encodeWindowsLauncherScript({
          format: useHiddenLauncher ? "vbs" : "cmd",
          content: launcher,
        }),
      );
      await launchFallbackTaskScript(params.env);
      writeFormattedLines(
        params.stdout,
        [
          { label: "Installed Windows login item", value: startupEntryPath },
          { label: "Task script", value: params.scriptPath },
        ],
        { leadingBlankLine: true },
      );
      return "startup-fallback";
    }
    throw new Error(`schtasks create failed: ${detail}`.trim());
  }

  const activation = await runScheduledTaskOrThrow({
    taskName,
    env: params.env,
    scriptPath: params.scriptPath,
  });
  // Ensure we don't end up writing to a clack spinner line (wizards show progress without a newline).
  writeFormattedLines(
    params.stdout,
    [
      { label: "Installed Scheduled Task", value: taskName },
      { label: "Task script", value: params.scriptPath },
    ],
    { leadingBlankLine: true },
  );
  return activation;
}

export async function installScheduledTask(
  args: GatewayServiceInstallArgs,
): Promise<{ scriptPath: string }> {
  const installedCommand = await readScheduledTaskCommand(args.env).catch(() => null);
  const fallbackEnv = resolveScheduledTaskActivationEnv(args.env, installedCommand?.environment);
  // Capture fallback ownership from installed metadata before replacing the
  // script. A repair can change the port or profile that locates the old process.
  const startupEntryInstalled = await isStartupEntryInstalled(fallbackEnv);
  let startupRuntime = startupEntryInstalled
    ? await resolveFallbackRuntime(fallbackEnv, installedCommand, "control").catch(() => null)
    : null;
  if (
    startupEntryInstalled &&
    args.startupFallbackTakeoverRuntime?.status === "running" &&
    startupRuntime?.status !== "running"
  ) {
    startupRuntime = await waitForFallbackTakeoverRuntime(
      fallbackEnv,
      installedCommand,
      startupRuntime ?? { status: "unknown" },
      args.startupFallbackTakeoverRuntime,
    );
  }
  if (startupEntryInstalled && (!startupRuntime || startupRuntime.status === "unknown")) {
    throw new Error(
      startupRuntime?.detail ??
        "Could not verify the existing Windows login item before Scheduled Task migration.",
    );
  }
  const activationEnv = resolveScheduledTaskActivationEnv(args.env, args.environment);
  if (startupRuntime) {
    const fallbackPid = startupRuntime.status === "running" ? startupRuntime.pid : undefined;
    if (startupRuntime.status === "running" && !fallbackPid) {
      throw new Error("Could not verify the existing Windows login item process.");
    }
    await assertReplacementPortAvailableForTakeover({
      env: activationEnv,
      programArguments: args.programArguments,
      ...(args.environment ? { environment: args.environment } : {}),
      ...(fallbackPid ? { fallbackPid } : {}),
    });
  }
  const staged = await writeScheduledTaskScript(args);
  const activation = await activateScheduledTask({
    env: activationEnv,
    stdout: args.stdout,
    scriptPath: staged.scriptPath,
    taskLaunchPath: staged.taskLaunchPath,
    description: staged.taskDescription,
  });
  if (activation !== "scheduled-task") {
    return { scriptPath: staged.scriptPath };
  }
  // Config writes can briefly drop the old listener before the service script
  // is replaced. Re-probe through the captured command so a resumed fallback
  // cannot be hidden by the newly staged port or entrypoint.
  const takeoverRuntime =
    startupRuntime?.status === "stopped"
      ? await resolveFallbackRuntime(fallbackEnv, installedCommand, "control").catch(
          () => startupRuntime,
        )
      : startupRuntime;
  if (takeoverRuntime?.status === "running") {
    // The old launcher can still own the listener after the task is created.
    // Terminate its captured PID, then restart and prove the replacement.
    if (takeoverRuntime.pid) {
      await terminateGatewayProcessTree(takeoverRuntime.pid, 300);
      try {
        // The captured fallback is already gone. Re-reading ownership after
        // replacing its script would inspect the new task command instead.
        await restartRegisteredScheduledTask({
          env: activationEnv,
          stdout: args.stdout,
          mode: { kind: "fallback-takeover" },
        });
      } catch (err) {
        // Keep the gateway available if Task Scheduler takeover fails after
        // terminating the captured fallback process.
        await launchFallbackTaskScript(fallbackEnv, installedCommand);
        throw err;
      }
    }
  } else if (
    takeoverRuntime?.status === "stopped" &&
    (await waitForScheduledTaskRunningEvidence(activationEnv))
  ) {
    await removeStartupEntries(activationEnv, args.stdout);
  }
  return { scriptPath: staged.scriptPath };
}

export async function uninstallScheduledTask({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<void> {
  await assertSchtasksAvailable();
  const taskName = resolveTaskName(env);
  const taskInstalled = await isRegisteredScheduledTask(env).catch(() => false);
  if (taskInstalled) {
    await execSchtasks(["/Delete", "/F", "/TN", taskName]);
  }

  await removeStartupEntries(env, stdout);

  const scriptPath = resolveTaskScriptPath(env);
  const parsedScriptPath = path.parse(scriptPath);
  const launcherPaths = uniqueStrings([
    resolveTaskLauncherScriptPath(env, scriptPath),
    path.join(parsedScriptPath.dir, `${parsedScriptPath.name}.vbs`),
  ]);
  for (const launcherPath of launcherPaths) {
    if (launcherPath === scriptPath) {
      continue;
    }
    try {
      await fs.unlink(launcherPath);
      stdout.write(`${formatLine("Removed task launcher", launcherPath)}\n`);
    } catch {}
  }
  try {
    await fs.unlink(scriptPath);
    stdout.write(`${formatLine("Removed task script", scriptPath)}\n`);
  } catch {
    stdout.write(`Task script not found at ${scriptPath}\n`);
  }
}

function isTaskNotRunning(res: { stdout: string; stderr: string; code: number }): boolean {
  const detail = normalizeLowercaseStringOrEmpty(res.stderr || res.stdout);
  return detail.includes("not running");
}

export async function stopScheduledTask({
  stdout,
  env,
  onMutation,
}: GatewayServiceControlArgs): Promise<void> {
  const effectiveEnv = env ?? (process.env as GatewayServiceEnv);
  const reportMutation = createGatewayLifecycleMutationReporter(onMutation);
  try {
    await assertSchtasksAvailable();
  } catch (err) {
    if (await isStartupEntryInstalled(effectiveEnv)) {
      await stopStartupEntry(effectiveEnv, stdout, () => reportMutation("startup-entry-stop"));
      return;
    }
    throw err;
  }
  if (!(await isRegisteredScheduledTask(effectiveEnv))) {
    if (await isStartupEntryInstalled(effectiveEnv)) {
      await stopStartupEntry(effectiveEnv, stdout, () => reportMutation("startup-entry-stop"));
      return;
    }
  }
  const taskName = resolveTaskName(effectiveEnv);
  const res = await execSchtasks(["/End", "/TN", taskName]);
  if (res.code !== 0 && !isTaskNotRunning(res)) {
    throw new Error(`schtasks end failed: ${res.stderr || res.stdout}`.trim());
  }
  reportMutation("schtasks-stop");
  const manageGatewayPort = shouldManageGatewayListenerPort(effectiveEnv);
  const stopPort = manageGatewayPort ? await resolveScheduledTaskPort(effectiveEnv) : null;
  if (manageGatewayPort) {
    await terminateScheduledTaskGatewayListeners(effectiveEnv);
  } else {
    await terminateScheduledTaskNodeHost(effectiveEnv);
  }
  await terminateInstalledStartupRuntime(effectiveEnv);
  if (stopPort) {
    const released = await waitForGatewayPortRelease(stopPort);
    if (!released) {
      await terminateBusyPortListeners(stopPort);
      const releasedAfterForce = await waitForGatewayPortRelease(stopPort, 2_000);
      if (!releasedAfterForce) {
        throw new Error(`gateway port ${stopPort} is still busy after stop`);
      }
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
  try {
    await assertSchtasksAvailable();
  } catch (err) {
    if (await isStartupEntryInstalled(effectiveEnv)) {
      await startStartupEntry(effectiveEnv, stdout, () => reportMutation("startup-entry-start"));
      return;
    }
    throw err;
  }
  if (!(await isRegisteredScheduledTask(effectiveEnv))) {
    if (await isStartupEntryInstalled(effectiveEnv)) {
      await startStartupEntry(effectiveEnv, stdout, () => reportMutation("startup-entry-start"));
      return;
    }
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

async function restartRegisteredScheduledTask(params: {
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
  const restartPort = manageGatewayPort ? await resolveScheduledTaskPort(params.env) : null;
  if (params.mode.kind === "standard") {
    if (manageGatewayPort) {
      await terminateScheduledTaskGatewayListeners(params.env);
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
    const released = await waitForGatewayPortRelease(restartPort);
    if (!released) {
      if (params.mode.kind === "fallback-takeover") {
        throw new Error(
          `replacement gateway port ${restartPort} is occupied by an unverified process`,
        );
      }
      await terminateBusyPortListeners(restartPort);
      const releasedAfterForce = await waitForGatewayPortRelease(restartPort, 2_000);
      if (!releasedAfterForce) {
        throw new Error(`gateway port ${restartPort} is still busy before restart`);
      }
    }
  }
  const activation = await runScheduledTaskOrThrow({
    taskName,
    env: params.env,
    scriptPath: resolveTaskScriptPath(params.env),
    ...(params.onRunMutation ? { onMutation: params.onRunMutation } : {}),
  });
  const startupEntryInstalled = await isStartupEntryInstalled(params.env);
  const hasRunningEvidence = startupEntryInstalled
    ? activation === "scheduled-task" && (await waitForScheduledTaskRunningEvidence(params.env))
    : await hasScheduledTaskRunningEvidence(params.env);
  // A direct launch is the replacement fallback; keep the Startup entry so
  // the same command remains available at the next login.
  if (
    params.mode.kind === "fallback-takeover" &&
    startupEntryInstalled &&
    activation === "scheduled-task" &&
    !hasRunningEvidence
  ) {
    await execSchtasks(["/End", "/TN", taskName]);
    const failedRuntime = await resolveFallbackRuntime(params.env, undefined, "control").catch(
      () => null,
    );
    if (failedRuntime?.status === "running" && failedRuntime.pid) {
      await terminateGatewayProcessTree(failedRuntime.pid, 300);
    }
    throw new Error("Replacement Windows Scheduled Task did not produce running evidence.");
  }
  if (startupEntryInstalled && hasRunningEvidence) {
    await removeStartupEntries(params.env, params.stdout);
  }
  params.stdout.write(`${formatLine("Restarted Scheduled Task", taskName)}\n`);
  return { outcome: "completed" };
}

export async function restartScheduledTask({
  stdout,
  env,
  onMutation,
}: GatewayServiceControlArgs): Promise<GatewayServiceRestartResult> {
  const effectiveEnv = env ?? (process.env as GatewayServiceEnv);
  const reportMutation = createGatewayLifecycleMutationReporter(onMutation);
  try {
    await assertSchtasksAvailable();
  } catch (err) {
    if (await isStartupEntryInstalled(effectiveEnv)) {
      const result = await restartStartupEntry(effectiveEnv, stdout, (kind) =>
        reportMutation(kind === "stop" ? "startup-entry-stop" : "startup-entry-restart"),
      );
      return result;
    }
    throw err;
  }
  if (!(await isRegisteredScheduledTask(effectiveEnv))) {
    if (await isStartupEntryInstalled(effectiveEnv)) {
      const result = await restartStartupEntry(effectiveEnv, stdout, (kind) =>
        reportMutation(kind === "stop" ? "startup-entry-stop" : "startup-entry-restart"),
      );
      return result;
    }
  }
  const result = await restartRegisteredScheduledTask({
    env: effectiveEnv,
    stdout,
    mode: { kind: "standard" },
    onEndMutation: () => reportMutation("schtasks-end"),
    onRunMutation: () => reportMutation("schtasks-restart"),
  });
  return result;
}

export async function isScheduledTaskInstalled(args: GatewayServiceEnvArgs): Promise<boolean> {
  const effectiveEnv = args.env ?? (process.env as GatewayServiceEnv);
  if (await isRegisteredScheduledTask(effectiveEnv)) {
    return true;
  }
  return await isStartupEntryInstalled(effectiveEnv);
}
