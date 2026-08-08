import fs from "node:fs/promises";
import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveGatewayServiceDescription } from "./constants.js";
import { formatLine, writeFormattedLines } from "./output.js";
import {
  restartRegisteredScheduledTask,
  runScheduledTaskOrThrow,
  type ScheduledTaskActivation,
} from "./schtasks-control.js";
import { execSchtasks } from "./schtasks-exec.js";
import {
  buildHiddenLauncherScript,
  buildScheduledTaskXml,
  buildStartupLauncherScript,
  buildTaskScript,
  encodeWindowsLauncherScript,
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
} from "./schtasks-layout.js";
import {
  assertReplacementPortAvailableForTakeover,
  terminateGatewayProcessTree,
} from "./schtasks-process.js";
import {
  assertSchtasksAvailable,
  isRegisteredScheduledTask,
  isStartupEntryInstalled,
  launchFallbackTaskScript,
  removeStartupEntries,
  resolveFallbackRuntime,
  waitForFallbackTakeoverRuntime,
  waitForScheduledTaskRunningEvidence,
} from "./schtasks-runtime.js";
import type {
  GatewayServiceEnv,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
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
    description,
  });
  const script = buildTaskScript({
    description: taskDescription,
    programArguments,
    workingDirectory,
    environment: resolveScheduledTaskScriptEnvironment(taskEnv, environment),
  });
  await fs.writeFile(scriptPath, encodeWindowsLauncherScript({ format: "cmd", content: script }));
  if (taskLaunchPath !== scriptPath) {
    const launcher = buildHiddenLauncherScript({ description: taskDescription, scriptPath });
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
  // Re-apply the full XML so older tasks inherit both false battery flags (#59299).
  // Best effort: failure keeps the prior settings rather than losing the task.
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
  // Use `schtasks /Create /XML` so the task carries explicit battery settings.
  // The CLI flag form cannot set these and kills the Gateway when a laptop unplugs (#59299).
  const xmlPath = await writeTaskXmlTempFile(
    buildScheduledTaskXml({ taskDescription, taskUser, launchPath: params.taskLaunchPath }),
  );
  let create: Awaited<ReturnType<typeof execSchtasks>>;
  try {
    const xmlArgs = ["/Create", "/F", "/TN", taskName, "/XML", xmlPath];
    const createUser = resolveSchtasksCreateUser(params.env, taskUser);
    create = await execSchtasks(createUser ? [...xmlArgs, "/RU", createUser, "/NP"] : xmlArgs);
    if (create.code !== 0 && createUser) {
      // Retry without elevated `/RU` when the account password cannot be stored.
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
        ? buildHiddenLauncherScript({ description: taskDescription, scriptPath: params.scriptPath })
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
  // Capture ownership before repair changes the port/profile that locates the old process.
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
  // Re-probe the captured command so a config-reload fallback is not hidden by the staged script.
  const takeoverRuntime =
    startupRuntime?.status === "stopped"
      ? await resolveFallbackRuntime(fallbackEnv, installedCommand, "control").catch(
          () => startupRuntime,
        )
      : startupRuntime;
  if (takeoverRuntime?.status === "running" && takeoverRuntime.pid) {
    // The old launcher can still own the listener; terminate it and prove the replacement.
    await terminateGatewayProcessTree(takeoverRuntime.pid, 300);
    try {
      // Re-reading ownership now would inspect the replacement command, not the captured fallback.
      await restartRegisteredScheduledTask({
        env: activationEnv,
        stdout: args.stdout,
        mode: { kind: "fallback-takeover" },
      });
    } catch (err) {
      // Restore availability if takeover fails after terminating the captured fallback.
      await launchFallbackTaskScript(fallbackEnv, installedCommand);
      throw err;
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
  if (await isRegisteredScheduledTask(env).catch(() => false)) {
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
