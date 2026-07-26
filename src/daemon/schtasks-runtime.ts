/** Windows Task Scheduler runtime queries and Startup-folder fallback control. */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isGatewayArgv } from "../infra/gateway-process-argv.js";
import { parseTcpPortFromArgs } from "../infra/tcp-port.js";
import {
  getWindowsCmdExePath,
  getWindowsPowerShellExePath,
} from "../infra/windows-install-roots.js";
import { sleep } from "../utils.js";
import { parseCmdScriptCommandLine } from "./cmd-argv.js";
import { formatLine } from "./output.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import { execSchtasks } from "./schtasks-exec.js";
import {
  findInstalledProcessPid,
  isNodeHostArgv,
  parsePositivePort,
  probeProcessState,
  readWindowsProcessSnapshot,
  resolveConfiguredGatewayPort,
  resolveFallbackRuntime,
  resolveListenerBackedScheduledTaskRuntime,
  resolveScheduledTaskGatewayListenerPids,
  shouldManageGatewayListenerPort,
  terminateGatewayProcessTree,
} from "./schtasks-process.js";
import {
  readScheduledTaskCommand,
  resolveStartupEntryPaths,
  resolveTaskName,
  resolveTaskScriptPath,
  shouldUseHiddenWindowsTaskLauncher,
} from "./schtasks-script.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceEnv,
  GatewayServiceRestartResult,
} from "./service-types.js";

type ScheduledTaskInfo = {
  status?: string;
  lastRunTime?: string;
  lastRunResult?: string;
};

function parseSchtasksQuery(output: string): ScheduledTaskInfo {
  const entries = parseKeyValueOutput(output, ":");
  const info: ScheduledTaskInfo = {};
  const status = entries.status;
  if (status) {
    info.status = status;
  }
  const lastRunTime = entries["last run time"];
  if (lastRunTime) {
    info.lastRunTime = lastRunTime;
  }
  // Some Windows locales/versions emit "Last Result" instead of "Last Run Result".
  // Accept both so gateway status is not falsely reported as "unknown" (#47726).
  const lastRunResult = entries["last run result"] ?? entries["last result"];
  if (lastRunResult) {
    info.lastRunResult = lastRunResult;
  }
  return info;
}

function normalizeTaskResultCode(value?: string): string | null {
  if (!value) {
    return null;
  }
  const raw = normalizeLowercaseStringOrEmpty(value);
  if (!raw) {
    return null;
  }

  if (/^0x[0-9a-f]+$/.test(raw)) {
    return `0x${raw.slice(2).replace(/^0+/, "") || "0"}`;
  }

  if (/^\d+$/.test(raw)) {
    const numeric = Number.parseInt(raw, 10);
    if (Number.isFinite(numeric)) {
      return `0x${numeric.toString(16)}`;
    }
  }

  return null;
}

const RUNNING_RESULT_CODES = new Set(["0x41301"]);
const NOT_YET_RUN_RESULT_CODES = new Set(["0x41303"]);
const UNKNOWN_STATUS_DETAIL =
  "Task status is locale-dependent and no numeric Last Run Result was available.";
const SCHEDULED_TASK_FALLBACK_POLL_MS = 250;
const SCHEDULED_TASK_FALLBACK_TIMEOUT_MS = 15_000;

function deriveScheduledTaskRuntimeStatus(parsed: ScheduledTaskInfo): {
  status: GatewayServiceRuntime["status"];
  detail?: string;
} {
  const normalizedResult = normalizeTaskResultCode(parsed.lastRunResult);
  if (normalizedResult != null) {
    if (RUNNING_RESULT_CODES.has(normalizedResult)) {
      return { status: "running" };
    }
    return {
      status: "stopped",
      detail: `Task Last Run Result=${parsed.lastRunResult}; treating as not running.`,
    };
  }
  if (parsed.status?.trim()) {
    return { status: "unknown", detail: UNKNOWN_STATUS_DETAIL };
  }
  return { status: "unknown" };
}

export async function assertSchtasksAvailable() {
  const res = await execSchtasks(["/Query"]);
  if (res.code === 0) {
    return;
  }
  const detail = res.stderr || res.stdout;
  throw new Error(`schtasks unavailable: ${detail || "unknown error"}`.trim());
}

export async function isStartupEntryInstalled(env: GatewayServiceEnv): Promise<boolean> {
  for (const startupEntryPath of resolveStartupEntryPaths(env)) {
    try {
      await fs.access(startupEntryPath);
      return true;
    } catch {}
  }
  return false;
}

export async function removeStartupEntries(
  env: GatewayServiceEnv,
  stdout: NodeJS.WritableStream,
): Promise<void> {
  for (const startupEntryPath of resolveStartupEntryPaths(env)) {
    try {
      await fs.unlink(startupEntryPath);
      stdout.write(`${formatLine("Removed Windows login item", startupEntryPath)}\n`);
    } catch {}
  }
}

export async function hasScheduledTaskRunningEvidence(env: GatewayServiceEnv): Promise<boolean> {
  const runtime = await readScheduledTaskRuntime(env).catch(() => null);
  if (runtime?.status !== "running") {
    return false;
  }
  const normalizedResult = normalizeTaskResultCode(runtime.lastRunResult);
  if (normalizedResult !== null && RUNNING_RESULT_CODES.has(normalizedResult)) {
    return true;
  }
  // The hidden VBS launcher exits after spawning gateway.cmd. A successful task
  // result plus listener-backed runtime is its equivalent takeover evidence.
  return shouldUseHiddenWindowsTaskLauncher(env) && normalizedResult === "0x0";
}

export async function waitForScheduledTaskRunningEvidence(
  env: GatewayServiceEnv,
): Promise<boolean> {
  const deadline = Date.now() + SCHEDULED_TASK_FALLBACK_TIMEOUT_MS;
  while (true) {
    if (await hasScheduledTaskRunningEvidence(env)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(SCHEDULED_TASK_FALLBACK_POLL_MS);
  }
}

export async function isRegisteredScheduledTask(env: GatewayServiceEnv): Promise<boolean> {
  const taskName = resolveTaskName(env);
  const res = await execSchtasks(["/Query", "/TN", taskName]).catch(() => ({
    code: 1,
    stdout: "",
    stderr: "",
  }));
  return res.code === 0;
}

export async function launchFallbackTaskScript(
  env: GatewayServiceEnv,
  installedCommand?: GatewayServiceCommandConfig | null,
): Promise<void> {
  const scriptPath = resolveTaskScriptPath(env);
  const command =
    installedCommand === undefined ? await readScheduledTaskCommand(env) : installedCommand;
  if (command?.programArguments.length) {
    const [executable, ...args] = command.programArguments;
    const child = spawn(expectDefined(executable, "schtasks executable"), args, {
      cwd: command.workingDirectory || undefined,
      detached: true,
      env: {
        ...process.env,
        ...command.environment,
      },
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return;
  }

  const child = spawn(getWindowsCmdExePath(), ["/d", "/c", scriptPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export async function readWindowsStartupFallbackRuntimeForUpdate(
  env: GatewayServiceEnv,
): Promise<GatewayServiceRuntime | null> {
  if (!(await isStartupEntryInstalled(env))) {
    return null;
  }
  const taskExists = probeScheduledTaskExists(resolveTaskName(env));
  if (taskExists === null) {
    throw new Error("Could not verify whether the Windows Scheduled Task exists.");
  }
  if (taskExists) {
    return null;
  }
  return await resolveFallbackRuntime(env, undefined, "control");
}

const FALLBACK_TAKEOVER_REPROBE_TIMEOUT_MS = 5_000;
const FALLBACK_TAKEOVER_REPROBE_INTERVAL_MS = 250;

export async function waitForFallbackTakeoverRuntime(
  env: GatewayServiceEnv,
  installedCommand: GatewayServiceCommandConfig | null,
  initialRuntime: GatewayServiceRuntime,
  previousRuntime: GatewayServiceRuntime,
): Promise<GatewayServiceRuntime> {
  let runtime = initialRuntime;
  const deadline = Date.now() + FALLBACK_TAKEOVER_REPROBE_TIMEOUT_MS;
  while (runtime.status !== "running" && Date.now() < deadline) {
    await sleep(FALLBACK_TAKEOVER_REPROBE_INTERVAL_MS);
    runtime = await resolveFallbackRuntime(env, installedCommand, "control").catch(
      (err: unknown) => ({
        status: "unknown",
        detail: `Could not re-inspect the existing Windows login item: ${String(err)}`,
      }),
    );
  }
  if (runtime.status === "stopped" && previousRuntime.status === "running") {
    const previousPid = previousRuntime.pid;
    if (!previousPid || probeProcessState(previousPid) !== "missing") {
      return {
        status: "unknown",
        detail: "The previously running Windows login item has not exited cleanly.",
      };
    }
  }
  return runtime;
}

async function resolveControllableFallbackRuntime(
  env: GatewayServiceEnv,
): Promise<GatewayServiceRuntime> {
  const runtime = await resolveFallbackRuntime(env, undefined, "control");
  if (runtime.status === "unknown") {
    throw new Error(runtime.detail ?? "Could not verify Windows login item ownership.");
  }
  return runtime;
}

export async function stopStartupEntry(
  env: GatewayServiceEnv,
  stdout: NodeJS.WritableStream,
  onMutation?: () => void,
): Promise<void> {
  const runtime = await resolveControllableFallbackRuntime(env);
  if (typeof runtime.pid === "number" && runtime.pid > 0) {
    await terminateGatewayProcessTree(runtime.pid, 300);
  }
  onMutation?.();
  stdout.write(`${formatLine("Stopped Windows login item", resolveTaskName(env))}\n`);
}

export async function terminateInstalledStartupRuntime(env: GatewayServiceEnv): Promise<void> {
  if (!(await isStartupEntryInstalled(env))) {
    return;
  }
  const runtime = await resolveControllableFallbackRuntime(env);
  if (typeof runtime.pid === "number" && runtime.pid > 0) {
    await terminateGatewayProcessTree(runtime.pid, 300);
  }
}

export async function restartStartupEntry(
  env: GatewayServiceEnv,
  stdout: NodeJS.WritableStream,
  onMutation?: (kind: "stop" | "restart") => void,
): Promise<GatewayServiceRestartResult> {
  const runtime = await resolveControllableFallbackRuntime(env);
  if (typeof runtime.pid === "number" && runtime.pid > 0) {
    await terminateGatewayProcessTree(runtime.pid, 300);
    onMutation?.("stop");
  }
  await launchFallbackTaskScript(env);
  onMutation?.("restart");
  stdout.write(`${formatLine("Restarted Windows login item", resolveTaskName(env))}\n`);
  return { outcome: "completed" };
}

export async function startStartupEntry(
  env: GatewayServiceEnv,
  stdout: NodeJS.WritableStream,
  onMutation?: () => void,
): Promise<void> {
  await launchFallbackTaskScript(env);
  onMutation?.();
  stdout.write(`${formatLine("Started Windows login item", resolveTaskName(env))}\n`);
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

function probeScheduledTaskExists(taskName: string): boolean | null {
  const encodedTaskName = Buffer.from(taskName, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$taskName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTaskName}'))`,
    "try { $service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); $null=$service.GetFolder('\\').GetTask($taskName); exit 0 } catch { $exception=$_.Exception; while($null -ne $exception.InnerException){$exception=$exception.InnerException}; [Console]::Out.Write($exception.HResult); exit 1 }",
  ].join("; ");
  const probe = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  if (probe.error) {
    return null;
  }
  if (probe.status === 0) {
    return true;
  }
  const hresult = Number.parseInt(probe.stdout.trim(), 10);
  // Task Scheduler COM reports missing task and missing task-folder paths as
  // locale-independent HRESULT_FROM_WIN32 values. Every other failure stays fatal.
  return hresult === -2147024894 || hresult === -2147024893 ? false : null;
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
      return {
        state: "running",
        signature: [runtime.state, runtime.lastRunTime, runtime.lastRunResult, runtime.detail]
          .filter(Boolean)
          .join("|"),
      };
    }
    const normalizedResult = normalizeTaskResultCode(runtime?.lastRunResult);
    if (normalizedResult && NOT_YET_RUN_RESULT_CODES.has(normalizedResult)) {
      return {
        state: "not-yet-run",
        signature: [runtime?.state, runtime?.lastRunTime, runtime?.lastRunResult, runtime?.detail]
          .filter(Boolean)
          .join("|"),
      };
    }
    if (normalizedResult === "0x0") {
      return {
        state: "stopped-success",
        signature: [runtime?.state, runtime?.lastRunTime, runtime?.lastRunResult, runtime?.detail]
          .filter(Boolean)
          .join("|"),
      };
    }
    return {
      state: "other",
      signature: [runtime?.state, runtime?.lastRunTime, runtime?.lastRunResult, runtime?.detail]
        .filter(Boolean)
        .join("|"),
    };
  };

  const hasLaunchEvidence = async (): Promise<boolean> => {
    const command = await readScheduledTaskCommand(params.env).catch(() => null);
    const installedArguments = command?.programArguments;
    const taskPort =
      parseTcpPortFromArgs(installedArguments) ??
      parsePositivePort(command?.environment?.OPENCLAW_GATEWAY_PORT) ??
      resolveConfiguredGatewayPort(params.env);
    const manageGatewayPort = shouldManageGatewayListenerPort(params.env);
    if (manageGatewayPort && taskPort) {
      const listenerPids = await resolveScheduledTaskGatewayListenerPids(taskPort);
      if (listenerPids.length > 0) {
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
    const matchingTaskScriptProcess = entries.some((entry) =>
      normalizeLowercaseStringOrEmpty(entry.CommandLine ?? "")
        .replaceAll("/", "\\")
        .includes(scriptPathNeedle),
    );
    if (matchingTaskScriptProcess) {
      return true;
    }

    if (!taskPort) {
      return false;
    }

    if (!manageGatewayPort) {
      return installedArguments?.length
        ? findInstalledProcessPid(entries, taskPort, installedArguments, isNodeHostArgv) != null
        : false;
    }

    return entries.some((entry) => {
      const commandLine = normalizeLowercaseStringOrEmpty(entry.CommandLine ?? "");
      if (!commandLine) {
        return false;
      }
      const argv = parseCmdScriptCommandLine(entry.CommandLine ?? "");
      return (
        isGatewayArgv(argv, { allowGatewayBinary: true }) && parseTcpPortFromArgs(argv) === taskPort
      );
    });
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
    // A queued task may finish cleanly before its process/listener becomes observable.
    // Keep that transition inside this bounded poll; the reverse means a new run is starting.
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

export type ScheduledTaskActivation = "scheduled-task" | "direct-fallback";

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
  await launchFallbackTaskScript(params.env);
  return "direct-fallback";
}

export async function readScheduledTaskRuntime(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
): Promise<GatewayServiceRuntime> {
  try {
    await assertSchtasksAvailable();
  } catch (err) {
    if (await isStartupEntryInstalled(env)) {
      return await resolveFallbackRuntime(env);
    }
    return {
      status: "unknown",
      detail: String(err),
    };
  }
  const taskName = resolveTaskName(env);
  const res = await execSchtasks(["/Query", "/TN", taskName, "/V", "/FO", "LIST"]);
  if (res.code !== 0) {
    if (await isStartupEntryInstalled(env)) {
      return await resolveFallbackRuntime(env);
    }
    const detail = (res.stderr || res.stdout).trim();
    const missing = normalizeLowercaseStringOrEmpty(detail).includes("cannot find the file");
    return {
      status: missing ? "stopped" : "unknown",
      detail: detail || undefined,
      missingUnit: missing,
    };
  }
  const parsed = parseSchtasksQuery(res.stdout || "");
  const derived = deriveScheduledTaskRuntimeStatus(parsed);
  if (derived.status !== "running") {
    const observedRuntime = await resolveListenerBackedScheduledTaskRuntime(env);
    if (observedRuntime) {
      return {
        ...observedRuntime,
        state: parsed.status,
        lastRunTime: parsed.lastRunTime,
        lastRunResult: parsed.lastRunResult,
      };
    }
  }
  return {
    status: derived.status,
    state: parsed.status,
    lastRunTime: parsed.lastRunTime,
    lastRunResult: parsed.lastRunResult,
    ...(derived.detail ? { detail: derived.detail } : {}),
  };
}

async function changeScheduledTaskEnabledState(params: {
  env: GatewayServiceEnv;
  enabled: boolean;
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
  const result = await execSchtasks(["/Change", "/TN", taskName, action]);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim() || "unknown error";
    const changeError = new Error(
      `schtasks ${params.enabled ? "enable" : "disable"} failed: ${detail}`,
    );
    if (!params.enabled) {
      // The task was proven enabled before /DISABLE. A timeout or non-zero exit
      // can still follow a committed change, so restore that known prior state.
      const restore = await execSchtasks(["/Change", "/TN", taskName, "/ENABLE"]);
      if (restore.code !== 0) {
        const restoreDetail = (restore.stderr || restore.stdout).trim() || "unknown error";
        throw new AggregateError(
          [changeError, new Error(`schtasks enable failed: ${restoreDetail}`)],
          "Scheduled Task disable failed and its enabled state could not be restored",
        );
      }
    }
    throw changeError;
  }
  return true;
}

export async function suspendScheduledTaskAutoStartForUpdate(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
): Promise<boolean> {
  return await changeScheduledTaskEnabledState({ env, enabled: false });
}

export async function resumeScheduledTaskAutoStartAfterUpdate(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
): Promise<boolean> {
  return await changeScheduledTaskEnabledState({ env, enabled: true });
}
