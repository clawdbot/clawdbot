import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { findVerifiedGatewayListenerPidsOnPortSync } from "../infra/gateway-processes.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import {
  getWindowsCmdExePath,
  getWindowsPowerShellExePath,
} from "../infra/windows-install-roots.js";
import { spawnWithFallback } from "../process/spawn-utils.js";
import { sleep } from "../utils.js";
import { resolveGatewayServiceProbeHosts } from "./gateway-service-probe-hosts.js";
import { formatLine } from "./output.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import { execSchtasks } from "./schtasks-exec.js";
import {
  readScheduledTaskCommand,
  resolveStartupEntryPaths,
  resolveTaskName,
  resolveTaskScriptPath,
  shouldUseHiddenWindowsTaskLauncher,
} from "./schtasks-layout.js";
import {
  findInstalledProcessPid,
  isNodeHostArgv,
  probeProcessState,
  readWindowsProcessSnapshot,
  resolveGatewayListenerPids,
  resolveListenerBackedScheduledTaskRuntime,
  resolveScheduledTaskCommandPort,
  shouldManageGatewayListenerPort,
  terminateGatewayProcessTree,
} from "./schtasks-process.js";
import {
  createServiceRuntimeInspectionFailure,
  type GatewayServiceRuntime,
} from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
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
  if (entries.status) {
    info.status = entries.status;
  }
  if (entries["last run time"]) {
    info.lastRunTime = entries["last run time"];
  }
  // Accept the "Last Result" locale/version variant to avoid false unknown status (#47726).
  const lastRunResult = entries["last run result"] ?? entries["last result"];
  if (lastRunResult) {
    info.lastRunResult = lastRunResult;
  }
  return info;
}

export function normalizeTaskResultCode(value?: string): string | null {
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
export const NOT_YET_RUN_RESULT_CODES = new Set(["0x41303"]);
const UNKNOWN_STATUS_DETAIL =
  "Task status is locale-dependent and no numeric Last Run Result was available.";
export const SCHEDULED_TASK_FALLBACK_POLL_MS = 250;
export const SCHEDULED_TASK_FALLBACK_TIMEOUT_MS = 15_000;

function deriveScheduledTaskRuntimeStatus(parsed: ScheduledTaskInfo): {
  status: GatewayServiceRuntime["status"];
  detail?: string;
} {
  const normalizedResult = normalizeTaskResultCode(parsed.lastRunResult);
  if (normalizedResult != null) {
    return RUNNING_RESULT_CODES.has(normalizedResult)
      ? { status: "running" }
      : {
          status: "stopped",
          detail: `Task Last Run Result=${parsed.lastRunResult}; treating as not running.`,
        };
  }
  return parsed.status?.trim()
    ? { status: "unknown", detail: UNKNOWN_STATUS_DETAIL }
    : { status: "unknown" };
}

export async function assertSchtasksAvailable(): Promise<void> {
  const res = await execSchtasks(["/Query"]);
  if (res.code !== 0) {
    const detail = res.stderr || res.stdout;
    throw new Error(`schtasks unavailable: ${detail || "unknown error"}`.trim());
  }
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
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw createStartupEntryRemovalError(error);
      }
    }
  }
}

function createStartupEntryRemovalError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  // Native filesystem errors include the private Startup-folder path in their messages.
  return new Error(
    `Windows login item removal failed${code ? ` (${code})` : ""}. Check permissions and retry.`,
    { cause: code ? { code } : undefined },
  );
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
  // Hidden VBS exits after spawning gateway.cmd; listener-backed success proves takeover.
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
  const res = await execSchtasks(["/Query", "/TN", resolveTaskName(env)]).catch(() => ({
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
    const { child } = await spawnWithFallback({
      argv: command.programArguments,
      options: {
        cwd: command.workingDirectory || undefined,
        detached: true,
        env: { ...process.env, ...command.environment },
        stdio: "ignore",
        windowsHide: true,
      },
    });
    child.unref();
    return;
  }
  // Preserve native missing-script errors before testing the actual cmd.exe access contract.
  await (await fs.open(scriptPath, "r")).close();
  const scriptEnv = { ...process.env, OPENCLAW_TASK_SCRIPT: scriptPath };
  // libuv uses backup semantics, so privileged Node opens can bypass the DACL that cmd enforces.
  const scriptProbe = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        "$ErrorActionPreference='Stop'; [System.IO.File]::OpenRead($env:OPENCLAW_TASK_SCRIPT).Dispose()",
        "utf16le",
      ).toString("base64"),
    ],
    {
      env: scriptEnv,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  if (scriptProbe.error) {
    throw scriptProbe.error;
  }
  if (scriptProbe.status !== 0) {
    throw Object.assign(new Error("Windows login item script is not readable"), { code: "EACCES" });
  }
  const { child } = await spawnWithFallback({
    // Node's verbatim /s shell contract preserves inner quotes; percent expansion is nonrecursive.
    argv: [getWindowsCmdExePath(), "/d", "/s", "/v:off", "/c", '""%OPENCLAW_TASK_SCRIPT%""'],
    options: {
      detached: true,
      env: scriptEnv,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
    },
  });
  child.unref();
}

export async function resolveFallbackRuntime(
  env: GatewayServiceEnv,
  installedCommand?: GatewayServiceCommandConfig | null,
  mode: "observe" | "control" = "observe",
): Promise<GatewayServiceRuntime> {
  const command =
    installedCommand === undefined
      ? await readScheduledTaskCommand(env).catch(() => null)
      : installedCommand;
  const port = resolveScheduledTaskCommandPort(env, command);
  if (!port) {
    return {
      status: "unknown",
      detail: shouldManageGatewayListenerPort(env)
        ? "Startup-folder login item installed; gateway port unknown."
        : "Startup-folder login item installed; node gateway port unknown.",
    };
  }
  const installedArguments = command?.programArguments;
  if (!shouldManageGatewayListenerPort(env)) {
    const snapshot = readWindowsProcessSnapshot();
    if (!snapshot) {
      return {
        status: "unknown",
        detail: `Startup-folder login item installed; could not inspect node host process for gateway port ${port}.`,
      };
    }
    const pid = installedArguments?.length
      ? findInstalledProcessPid(snapshot, port, installedArguments, isNodeHostArgv)
      : null;
    return pid
      ? {
          status: "running",
          pid,
          detail: `Startup-folder login item installed; node host process detected for gateway port ${port}.`,
        }
      : {
          status: "stopped",
          detail: `Startup-folder login item installed; no node host process detected for gateway port ${port}.`,
        };
  }

  const shouldInspectProcess = process.platform === "win32" && Boolean(installedArguments?.length);
  const snapshot = shouldInspectProcess ? readWindowsProcessSnapshot() : null;
  const processPid =
    snapshot && installedArguments
      ? findInstalledProcessPid(snapshot, port, installedArguments, () => true)
      : null;
  if (processPid) {
    return {
      status: "running",
      pid: processPid,
      detail: `Startup-folder login item installed; matching gateway process detected for port ${port}.`,
    };
  }
  // Control must match persisted argv; a same-port gateway may belong to another checkout.
  const requireCommandOwnership = mode === "control" && process.platform === "win32";
  if (requireCommandOwnership) {
    if (!installedArguments?.length) {
      return {
        status: "unknown",
        detail: `Startup-folder login item installed; persisted command unavailable for gateway port ${port}.`,
      };
    }
    if (!snapshot) {
      return {
        status: "unknown",
        detail: `Startup-folder login item installed; could not verify the installed process for gateway port ${port}.`,
      };
    }
  }
  const probeHosts = await resolveGatewayServiceProbeHosts({ env, command });
  const diagnostics = await inspectPortUsage(port, { probeHosts }).catch(() => null);
  if (!diagnostics) {
    return {
      status: "unknown",
      detail: `Startup-folder login item installed; could not inspect port ${port}.`,
    };
  }
  if (diagnostics.status !== "busy") {
    const status =
      diagnostics.status === "free" && !(shouldInspectProcess && !snapshot) ? "stopped" : "unknown";
    return {
      status,
      detail:
        status === "unknown" && diagnostics.status === "free"
          ? `Startup-folder login item installed; no listener detected on port ${port}, but process inspection was unavailable.`
          : `Startup-folder login item installed; no gateway listener detected on port ${port}.`,
    };
  }
  const matchedGatewayPids = resolveGatewayListenerPids(diagnostics.listeners);
  const scopedListenerPids = new Set(diagnostics.listeners.map((listener) => listener.pid));
  const verifiedGatewayPids = findVerifiedGatewayListenerPidsOnPortSync(port).filter((pid) =>
    scopedListenerPids.has(pid),
  );
  const ownedGatewayPids = matchedGatewayPids.length > 0 ? matchedGatewayPids : verifiedGatewayPids;
  if (ownedGatewayPids.length > 0) {
    return requireCommandOwnership
      ? {
          status: "unknown",
          detail: `Startup-folder login item installed; gateway listener on port ${port} does not match the persisted command.`,
        }
      : {
          status: "running",
          pid: ownedGatewayPids[0],
          detail: `Startup-folder login item installed; verified gateway listener detected on port ${port}.`,
        };
  }
  return {
    status: "unknown",
    detail: `Startup-folder login item installed; port ${port} is busy, but the listener is not a verified gateway process.`,
  };
}

type ScheduledTaskStateProbe =
  | { status: "found"; state: number | null }
  | { status: "missing" }
  | { status: "unknown" };

function probeScheduledTaskState(taskName: string): ScheduledTaskStateProbe {
  const encodedTaskName = Buffer.from(taskName, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$taskName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTaskName}'))`,
    "try { $service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); $task=$service.GetFolder('\\').GetTask($taskName); [Console]::Out.Write([int]$task.State); exit 0 } catch { $exception=$_.Exception; while($null -ne $exception.InnerException){$exception=$exception.InnerException}; [Console]::Out.Write($exception.HResult); exit 1 }",
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
    return { status: "unknown" };
  }
  if (probe.status === 0) {
    const rawState = probe.stdout.trim();
    const state = /^\d+$/.test(rawState) ? Number.parseInt(rawState, 10) : null;
    return {
      status: "found",
      state,
    };
  }
  const hresult = Number.parseInt(probe.stdout.trim(), 10);
  // Only the locale-independent missing task/folder HRESULT values prove absence.
  return hresult === -2147024894 || hresult === -2147024893
    ? { status: "missing" }
    : { status: "unknown" };
}

export function probeScheduledTaskExists(taskName: string): boolean | null {
  const probe = probeScheduledTaskState(taskName);
  return probe.status === "found" ? true : probe.status === "missing" ? false : null;
}

export function isScheduledTaskDefinitelyNotRunning(taskName: string): boolean {
  const probe = probeScheduledTaskState(taskName);
  if (probe.status !== "found") {
    return false;
  }
  // TASK_STATE_DISABLED and TASK_STATE_READY both prove no instance is queued or running.
  return probe.state === 1 || probe.state === 3;
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
  return taskExists ? null : resolveFallbackRuntime(env, undefined, "control");
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
  if (runtime.pid) {
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
  if (runtime.pid) {
    await terminateGatewayProcessTree(runtime.pid, 300);
  }
}

export async function restartStartupEntry(
  env: GatewayServiceEnv,
  stdout: NodeJS.WritableStream,
  onMutation?: (kind: "stop" | "restart") => void,
): Promise<GatewayServiceRestartResult> {
  const runtime = await resolveControllableFallbackRuntime(env);
  if (runtime.pid) {
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

export async function isScheduledTaskInstalled(args: GatewayServiceEnvArgs): Promise<boolean> {
  const effectiveEnv = args.env ?? (process.env as GatewayServiceEnv);
  return (
    (await isRegisteredScheduledTask(effectiveEnv)) || (await isStartupEntryInstalled(effectiveEnv))
  );
}

export async function readScheduledTaskRuntime(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
): Promise<GatewayServiceRuntime> {
  try {
    await assertSchtasksAvailable();
  } catch (err) {
    if (await isStartupEntryInstalled(env)) {
      return resolveFallbackRuntime(env);
    }
    return createServiceRuntimeInspectionFailure(err);
  }
  const taskName = resolveTaskName(env);
  const res = await execSchtasks(["/Query", "/TN", taskName, "/V", "/FO", "LIST"]);
  if (res.code !== 0) {
    if (await isStartupEntryInstalled(env)) {
      return resolveFallbackRuntime(env);
    }
    const detail = (res.stderr || res.stdout).trim();
    const missing = probeScheduledTaskExists(taskName) === false;
    return missing
      ? { status: "stopped", missingUnit: true }
      : { ...createServiceRuntimeInspectionFailure(detail), missingUnit: false };
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
