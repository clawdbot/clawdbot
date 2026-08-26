import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCmdScriptCommandLine } from "../daemon/cmd-argv.js";
import { sleep } from "../utils/sleep.js";
import { getCommandPositionalsWithRootOptions } from "./cli-root-options.js";
import { extractErrorCode } from "./errors.js";
import { acquireFileLock, type FileLockHandle } from "./file-lock.js";
import { getWindowsPowerShellExePath } from "./windows-install-roots.js";
import { readWindowsProcessStartTimeSync } from "./windows-port-pids.js";

export type LocalTuiProcess = {
  pid: number;
  command: string;
  instanceId?: string;
  instanceIdentity?: "coarse" | "strong";
  ownership: "target" | "ambiguous";
};

type ProcessSignal = "SIGTERM" | "SIGKILL";

type ProcessController = {
  kill: (pid: number, signal: ProcessSignal | 0) => boolean;
};

type PsResult = {
  error?: Error;
  status: number | null;
  stdout?: string;
};

const LOCAL_TUI_SUBCOMMANDS = new Set(["chat", "terminal", "tui"]);
const LOCAL_TUI_PROCESS_PROBE_TIMEOUT_MS = 1_000;
const LOCAL_TUI_UPDATE_LOCK_OPTIONS = {
  stale: 30_000,
  retries: { retries: 100, factor: 1, minTimeout: 50, maxTimeout: 250 },
  staleRecovery: "remove-if-unchanged" as const,
};

function resolveLocalTuiUpdateLockPath(targetRoot: string): string {
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync.native(targetRoot);
  } catch {
    canonicalRoot = path.resolve(targetRoot);
  }
  const installId = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 24);
  return path.join(os.tmpdir(), "openclaw-local-tui-update", installId);
}

function tokenizeCommandLine(command: string): string[] {
  return command.trim().split(/\s+/u).filter(Boolean);
}

function normalizeExecutableName(value: string | undefined): string {
  return (
    (value ?? "")
      .split(/[\\/]/u)
      .at(-1)
      ?.replace(/\.exe$/iu, "") ?? ""
  );
}

function isLocalTuiSubcommand(command: string | null | undefined): boolean {
  return command === undefined || (command !== null && LOCAL_TUI_SUBCOMMANDS.has(command));
}

function classifyLocalTuiCommand(
  command: string,
  platform: NodeJS.Platform,
  targetRoot: string | undefined,
  realpath: (value: string) => string,
): LocalTuiProcess["ownership"] | "other" | undefined {
  const argv =
    platform === "win32" ? parseCmdScriptCommandLine(command) : tokenizeCommandLine(command);
  const executable = normalizeExecutableName(argv[0]);
  const isNodeLaunch = executable === "node" && normalizeExecutableName(argv[1]) === "openclaw.mjs";
  const isTui =
    executable === "openclaw-tui" ||
    (executable === "openclaw" && isLocalTuiSubcommand(resolveOpenClawCommand(argv.slice(1)))) ||
    (isNodeLaunch && isLocalTuiSubcommand(resolveOpenClawCommand(argv.slice(2))));
  if (!isTui) {
    return undefined;
  }
  if (!targetRoot) {
    return "ambiguous";
  }
  const entrypoint = isNodeLaunch ? argv[1] : argv[0];
  const pathApi = platform === "win32" ? path.win32 : path;
  if (!entrypoint || !pathApi.isAbsolute(entrypoint)) {
    return "ambiguous";
  }
  let resolvedEntrypoint: string;
  let resolvedTarget: string;
  try {
    resolvedEntrypoint = realpath(entrypoint);
    resolvedTarget = realpath(targetRoot);
  } catch {
    return "ambiguous";
  }
  const relative = pathApi.relative(resolvedTarget, resolvedEntrypoint);
  return relative === "" ||
    (!relative.startsWith(`..${pathApi.sep}`) && relative !== ".." && !pathApi.isAbsolute(relative))
    ? "target"
    : "other";
}

function resolveOpenClawCommand(args: readonly string[]): string | null | undefined {
  const positionals = getCommandPositionalsWithRootOptions(["node", "openclaw", ...args], {
    commandPath: [],
    maxPositionals: 1,
  });
  return positionals === null ? null : positionals[0];
}

function parseLocalTuiProcessLine(
  line: string,
  currentUid: number,
  currentPid: number,
  platform: NodeJS.Platform,
  targetRoot: string | undefined,
  realpath: (value: string) => string,
  readPosixInstanceId: (pid: number, platform: NodeJS.Platform) => string | undefined,
): LocalTuiProcess | null {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/);
  if (!match) {
    return null;
  }
  const uid = Number(match[1]);
  const pid = Number(match[2]);
  if (uid !== currentUid) {
    return null;
  }
  if (!Number.isFinite(pid) || pid <= 0 || pid === currentPid) {
    return null;
  }
  const command = match[4]?.trim() ?? "";
  const ownership = classifyLocalTuiCommand(command, platform, targetRoot, realpath);
  if (!ownership || ownership === "other") {
    return null;
  }
  const kernelInstanceId = readPosixInstanceId(pid, platform);
  const instanceId = kernelInstanceId ?? match[3]?.trim();
  return {
    pid,
    command,
    ownership,
    ...(instanceId ? { instanceId } : {}),
    ...(instanceId ? { instanceIdentity: kernelInstanceId ? "strong" : "coarse" } : {}),
  };
}

function readPosixProcessInstanceId(pid: number, platform: NodeJS.Platform): string | undefined {
  if (platform !== "linux") {
    return undefined;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    // Linux starttime is field 22 and cannot collide when a PID is reused.
    // Other POSIX platforms fail closed because their ps timestamps are second-granularity.
    const startTicks = fields[19];
    return startTicks ? `${pid}:${startTicks}` : undefined;
  } catch {
    return undefined;
  }
}

/** Lists local OpenClaw TUI processes whose in-memory chunk graph may outlive an update. */
export function listLocalTuiProcesses(
  params: {
    targetRoot?: string;
    platform?: NodeJS.Platform;
    currentUid?: number;
    currentPid?: number;
    spawnSync?: (
      command: string,
      args: string[],
      options: SpawnSyncOptionsWithStringEncoding,
    ) => PsResult;
    readWindowsStartTime?: (pid: number) => number | null;
    readPosixInstanceId?: (pid: number, platform: NodeJS.Platform) => string | undefined;
  } = {},
): LocalTuiProcess[] {
  const realpath = fs.realpathSync.native;
  if ((params.platform ?? process.platform) === "win32") {
    const result = (params.spawnSync ?? spawnSync)(
      getWindowsPowerShellExePath(),
      [
        "-NoProfile",
        "-Command",
        "$currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Get-CimInstance Win32_Process | ForEach-Object { $ownerSid=(Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid; [pscustomobject]@{ProcessId=$_.ProcessId;CommandLine=$_.CommandLine;OwnerSid=$ownerSid;CurrentSid=$currentSid} } | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", killSignal: "SIGKILL", timeout: LOCAL_TUI_PROCESS_PROBE_TIMEOUT_MS },
    );
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) {
          return [];
        }
        const pidValue = Reflect.get(entry, "ProcessId");
        const commandValue = Reflect.get(entry, "CommandLine");
        const ownerSidValue = Reflect.get(entry, "OwnerSid");
        const currentSidValue = Reflect.get(entry, "CurrentSid");
        const pid = typeof pidValue === "number" ? pidValue : undefined;
        const command = typeof commandValue === "string" ? commandValue.trim() : undefined;
        const startTime = pid
          ? (params.readWindowsStartTime ?? readWindowsProcessStartTimeSync)(pid)
          : null;
        const ownership = command
          ? classifyLocalTuiCommand(command, "win32", params.targetRoot, realpath)
          : undefined;
        return pid &&
          pid !== (params.currentPid ?? process.pid) &&
          typeof ownerSidValue === "string" &&
          ownerSidValue === currentSidValue &&
          command &&
          ownership &&
          ownership !== "other"
          ? [
              {
                pid,
                command,
                ownership,
                ...(startTime === null
                  ? {}
                  : { instanceId: String(startTime), instanceIdentity: "strong" as const }),
              },
            ]
          : [];
      });
    } catch {
      return [];
    }
  }
  const currentUid = params.currentUid ?? process.getuid?.();
  if (currentUid === undefined) {
    return [];
  }
  const spawnSyncImpl = params.spawnSync ?? spawnSync;
  const ps = spawnSyncImpl("ps", ["-axo", "uid=,pid=,lstart=,command="], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: LOCAL_TUI_PROCESS_PROBE_TIMEOUT_MS,
  });
  if (ps.error || ps.status !== 0 || typeof ps.stdout !== "string") {
    return [];
  }
  const seen = new Set<number>();
  const processes: LocalTuiProcess[] = [];
  const platform = params.platform ?? process.platform;
  for (const line of ps.stdout.split(/\r?\n/)) {
    const proc = parseLocalTuiProcessLine(
      line,
      currentUid,
      params.currentPid ?? process.pid,
      platform,
      params.targetRoot,
      realpath,
      params.readPosixInstanceId ?? readPosixProcessInstanceId,
    );
    if (!proc || seen.has(proc.pid)) {
      continue;
    }
    seen.add(proc.pid);
    processes.push(proc);
  }
  return processes;
}

function isProcessAlive(controller: ProcessController, pid: number): boolean {
  try {
    controller.kill(pid, 0);
    return true;
  } catch (error) {
    return extractErrorCode(error) !== "ESRCH";
  }
}

/** Terminates local TUI processes with SIGTERM, then SIGKILL for remaining pids. */
export async function terminateLocalTuiProcesses(params: {
  processes: LocalTuiProcess[];
  targetRoot: string;
  controller?: ProcessController;
  graceMs?: number;
  killGraceMs?: number;
  readCurrentProcess?: (pid: number, targetRoot: string) => LocalTuiProcess | undefined;
}): Promise<{ stopped: number[]; failed: number[] }> {
  const controller = params.controller ?? process;
  const graceMs = Math.max(0, params.graceMs ?? 500);
  const killGraceMs = Math.max(0, params.killGraceMs ?? 250);
  const readCurrentProcess =
    params.readCurrentProcess ??
    ((pid: number, targetRoot: string) =>
      listLocalTuiProcesses({ targetRoot }).find((process) => process.pid === pid));
  const stopped: number[] = [];
  const failed: number[] = [];

  for (const proc of params.processes) {
    const current = readCurrentProcess(proc.pid, params.targetRoot);
    const originalIdentity = proc.instanceIdentity ?? "strong";
    const currentIdentity = current?.instanceIdentity ?? "strong";
    if (
      proc.ownership !== "target" ||
      !proc.instanceId ||
      originalIdentity !== "strong" ||
      current?.ownership !== "target" ||
      current.instanceId !== proc.instanceId ||
      currentIdentity !== "strong"
    ) {
      failed.push(proc.pid);
      continue;
    }
    try {
      controller.kill(proc.pid, "SIGTERM");
    } catch {
      // Already gone is success for this repair.
    }
  }
  if (graceMs > 0) {
    await sleep(graceMs);
  }
  const killFallback: LocalTuiProcess[] = [];
  for (const proc of params.processes) {
    if (stopped.includes(proc.pid) || failed.includes(proc.pid)) {
      continue;
    }
    if (!isProcessAlive(controller, proc.pid)) {
      stopped.push(proc.pid);
      continue;
    }
    const current = readCurrentProcess(proc.pid, params.targetRoot);
    if (
      current?.ownership !== "target" ||
      current.instanceId !== proc.instanceId ||
      (proc.instanceIdentity ?? "strong") !== "strong" ||
      (current.instanceIdentity ?? "strong") !== "strong"
    ) {
      failed.push(proc.pid);
      continue;
    }
    try {
      controller.kill(proc.pid, "SIGKILL");
    } catch {
      // Already gone is still success.
    }
    killFallback.push(proc);
  }
  if (killFallback.length > 0 && killGraceMs > 0) {
    await sleep(killGraceMs);
  }
  for (const proc of killFallback) {
    if (isProcessAlive(controller, proc.pid)) {
      failed.push(proc.pid);
    } else {
      stopped.push(proc.pid);
    }
  }
  return { stopped, failed };
}

export function formatLocalTuiPidList(processes: readonly LocalTuiProcess[]) {
  return processes.map((proc) => String(proc.pid)).join(", ");
}

/** Quiesces clients at the shared update mutation boundary. */
export async function quiesceLocalTuiProcessesBeforeUpdate(
  targetRoot: string,
  overrides: {
    list?: typeof listLocalTuiProcesses;
    terminate?: typeof terminateLocalTuiProcesses;
    acquireLock?: typeof acquireFileLock;
  } = {},
): Promise<(FileLockHandle & { stopped: number[] }) | undefined> {
  if (!overrides.list && (process.env.VITEST || process.env.NODE_ENV === "test")) {
    return undefined;
  }
  // Keep startup and discovery in one interprocess order. The updater retains
  // this gate until mutation ends, so a newly launched TUI cannot enter stale code.
  const updateLock = await (overrides.acquireLock ?? acquireFileLock)(
    resolveLocalTuiUpdateLockPath(targetRoot),
    LOCAL_TUI_UPDATE_LOCK_OPTIONS,
  );
  const processes = (overrides.list ?? listLocalTuiProcesses)({ targetRoot });
  const ambiguous = processes.filter((proc) => proc.ownership === "ambiguous");
  if (ambiguous.length > 0) {
    await updateLock.release();
    throw new Error(
      `Update refused: could not bind local TUI clients ${formatLocalTuiPidList(ambiguous)} to this installation. Close them and retry the update.`,
    );
  }
  if (processes.length === 0) {
    return Object.assign(updateLock, { stopped: [] });
  }
  const stopped = await (overrides.terminate ?? terminateLocalTuiProcesses)({
    processes,
    targetRoot,
  });
  if (stopped.failed.length > 0) {
    await updateLock.release();
    throw new Error(
      `Update refused: could not stop local TUI clients ${stopped.failed.join(", ")}. Close them and retry the update.`,
    );
  }
  return Object.assign(updateLock, { stopped: stopped.stopped });
}

/** Waits for an in-flight update before a TUI enters its loaded runtime. */
export async function waitForLocalTuiUpdate(
  targetRoot: string,
  acquireLock: typeof acquireFileLock = acquireFileLock,
): Promise<void> {
  for (;;) {
    try {
      const lock = await acquireLock(
        resolveLocalTuiUpdateLockPath(targetRoot),
        LOCAL_TUI_UPDATE_LOCK_OPTIONS,
      );
      await lock.release();
      return;
    } catch (error) {
      if (extractErrorCode(error) !== "file_lock_timeout") {
        throw error;
      }
    }
  }
}
