import { spawnSync } from "node:child_process";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isGatewayArgv } from "../infra/gateway-process-argv.js";
import { findVerifiedGatewayListenerPidsOnPortSync } from "../infra/gateway-processes.js";
import { inspectPortUsage, type PortListener } from "../infra/ports.js";
import { parseTcpPort, parseTcpPortFromArgs } from "../infra/tcp-port.js";
import {
  getWindowsPowerShellExePath,
  getWindowsSystem32ExePath,
} from "../infra/windows-install-roots.js";
import { killProcessTree } from "../process/kill-tree.js";
import { sleep } from "../utils.js";
import { parseCmdScriptCommandLine } from "./cmd-argv.js";
import { NODE_SERVICE_KIND } from "./constants.js";
import { readScheduledTaskCommand } from "./schtasks-layout.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type { GatewayServiceEnv } from "./service-types.js";

type WindowsProcessSnapshotEntry = {
  ProcessId?: number;
  CommandLine?: string | null;
};

export function resolveScheduledTaskCommandPort(
  env: GatewayServiceEnv,
  command?: {
    programArguments?: string[];
    environment?: GatewayServiceEnv;
  } | null,
): number | null {
  return (
    parseTcpPortFromArgs(command?.programArguments) ??
    parseTcpPort(command?.environment?.OPENCLAW_GATEWAY_PORT) ??
    parseTcpPort(env.OPENCLAW_GATEWAY_PORT)
  );
}

export function isNodeHostArgv(programArguments: string[]): boolean {
  const normalized = programArguments.map((arg) =>
    normalizeLowercaseStringOrEmpty(arg.replaceAll("\\", "/")),
  );
  return normalized.some((arg, index) => arg === "node" && normalized[index + 1] === "run");
}

function normalizeProgramArguments(programArguments: string[]): string[] {
  return programArguments.map((arg) => normalizeLowercaseStringOrEmpty(arg.replaceAll("\\", "/")));
}

function matchesInstalledProgramArguments(
  actualArguments: string[],
  installedArguments: string[],
): boolean {
  const actual = normalizeProgramArguments(actualArguments);
  const installed = normalizeProgramArguments(installedArguments);
  return (
    actual.length === installed.length && actual.every((arg, index) => arg === installed[index])
  );
}

function getSnapshotProcessId(entry: WindowsProcessSnapshotEntry): number | null {
  const pid = entry.ProcessId;
  return typeof pid === "number" && Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function findInstalledProcessPid(
  entries: WindowsProcessSnapshotEntry[],
  port: number,
  installedArguments: string[],
  matchesProcess: (argv: string[]) => boolean,
): number | null {
  for (const entry of entries) {
    const commandLine = normalizeLowercaseStringOrEmpty(entry.CommandLine ?? "");
    if (!commandLine) {
      continue;
    }
    const argv = parseCmdScriptCommandLine(entry.CommandLine ?? "");
    if (
      !matchesProcess(argv) ||
      parseTcpPortFromArgs(argv) !== port ||
      !matchesInstalledProgramArguments(argv, installedArguments)
    ) {
      continue;
    }
    const pid = getSnapshotProcessId(entry);
    if (pid) {
      return pid;
    }
  }
  return null;
}

async function resolveScheduledTaskProcess(
  env: GatewayServiceEnv,
  matchesProcess: (argv: string[]) => boolean,
): Promise<{ pid: number; port: number } | null> {
  const command = await readScheduledTaskCommand(env).catch(() => null);
  const installedArguments = command?.programArguments;
  if (!installedArguments?.length) {
    return null;
  }
  const port = resolveScheduledTaskCommandPort(env, command);
  if (!port) {
    return null;
  }
  const snapshot = readWindowsProcessSnapshot();
  if (!snapshot) {
    return null;
  }
  // Match full persisted argv so a same-port OpenClaw process cannot impersonate this task.
  const pid = findInstalledProcessPid(snapshot, port, installedArguments, matchesProcess);
  return pid ? { pid, port } : null;
}

async function resolveScheduledTaskNodeHostProcess(
  env: GatewayServiceEnv,
): Promise<{ pid: number; port: number } | null> {
  return resolveScheduledTaskProcess(env, isNodeHostArgv);
}

async function resolveScheduledTaskGatewayProcess(
  env: GatewayServiceEnv,
): Promise<{ pid: number; port: number } | null> {
  return resolveScheduledTaskProcess(env, (argv) =>
    isGatewayArgv(argv, { allowGatewayBinary: true }),
  );
}

export function shouldManageGatewayListenerPort(env: GatewayServiceEnv): boolean {
  return normalizeLowercaseStringOrEmpty(env.OPENCLAW_SERVICE_KIND) !== NODE_SERVICE_KIND;
}

export async function resolveScheduledTaskPort(env: GatewayServiceEnv): Promise<number | null> {
  return resolveScheduledTaskCommandPort(
    env,
    await readScheduledTaskCommand(env).catch(() => null),
  );
}

export async function resolveScheduledTaskGatewayListenerPids(port: number): Promise<number[]> {
  const verified = findVerifiedGatewayListenerPidsOnPortSync(port);
  if (verified.length > 0) {
    return verified;
  }
  const diagnostics = await inspectPortUsage(port).catch(() => null);
  if (diagnostics?.status !== "busy") {
    return [];
  }
  const matchedGatewayPids = resolveGatewayListenerPids(diagnostics.listeners);
  if (matchedGatewayPids.length > 0) {
    return matchedGatewayPids;
  }
  return Array.from(
    new Set(
      diagnostics.listeners
        .map((listener) => listener.pid)
        .filter((pid): pid is number => typeof pid === "number" && Number.isFinite(pid) && pid > 0),
    ),
  );
}

export function resolveGatewayListenerPids(listeners: PortListener[]): number[] {
  return Array.from(
    new Set(
      listeners
        .filter(
          (listener) =>
            typeof listener.pid === "number" &&
            listener.commandLine &&
            isGatewayArgv(parseCmdScriptCommandLine(listener.commandLine), {
              allowGatewayBinary: true,
            }),
        )
        .map((listener) => listener.pid as number),
    ),
  );
}

export async function resolveListenerBackedScheduledTaskRuntime(
  env: GatewayServiceEnv,
): Promise<Pick<GatewayServiceRuntime, "status" | "pid" | "detail"> | null> {
  if (!shouldManageGatewayListenerPort(env)) {
    const matched = await resolveScheduledTaskNodeHostProcess(env);
    return matched
      ? {
          status: "running",
          pid: matched.pid,
          detail: `Node host process detected for gateway port ${matched.port}.`,
        }
      : null;
  }
  const matched = await resolveScheduledTaskGatewayProcess(env);
  if (matched) {
    return {
      status: "running",
      pid: matched.pid,
      detail: `Gateway process detected for gateway port ${matched.port}.`,
    };
  }
  const port = await resolveScheduledTaskPort(env);
  if (!port) {
    return null;
  }
  const pids = findVerifiedGatewayListenerPidsOnPortSync(port);
  return pids.length > 0
    ? {
        status: "running",
        pid: pids[0],
        detail: `Verified gateway listener detected on port ${port} even though schtasks did not report a running task.`,
      }
    : null;
}

export async function terminateScheduledTaskNodeHost(env: GatewayServiceEnv): Promise<number[]> {
  const matched = await resolveScheduledTaskNodeHostProcess(env);
  if (!matched) {
    return [];
  }
  await terminateGatewayProcessTree(matched.pid, 300);
  return [matched.pid];
}

export async function terminateScheduledTaskGatewayListeners(
  env: GatewayServiceEnv,
): Promise<number[]> {
  if (!shouldManageGatewayListenerPort(env)) {
    return [];
  }
  const port = await resolveScheduledTaskPort(env);
  if (!port) {
    return [];
  }
  const pids = await resolveScheduledTaskGatewayListenerPids(port);
  for (const pid of pids) {
    await terminateGatewayProcessTree(pid, 300);
  }
  return pids;
}

export function probeProcessState(pid: number): "alive" | "missing" | "unknown" {
  if (process.platform === "win32") {
    const snapshot = readWindowsProcessSnapshot();
    if (snapshot) {
      return snapshot.some((entry) => getSnapshotProcessId(entry) === pid) ? "alive" : "missing";
    }
    const tasklist = spawnSync(
      getWindowsSystem32ExePath("tasklist.exe"),
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { encoding: "utf8", timeout: 1_500, windowsHide: true },
    );
    if (tasklist.error || tasklist.status !== 0) {
      return "unknown";
    }
    return tasklist.stdout.split(/\r?\n/).some((line) => line.includes(`,"${pid}",`))
      ? "alive"
      : "missing";
  }
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unknown";
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probeProcessState(pid) === "missing") {
      return true;
    }
    await sleep(100);
  }
  return probeProcessState(pid) === "missing";
}

export async function terminateGatewayProcessTree(pid: number, graceMs: number): Promise<void> {
  if (process.platform !== "win32") {
    // These PIDs come from argv/port ownership; leader verification avoids signaling our group.
    killProcessTree(pid, { graceMs });
    return;
  }
  const taskkillPath = getWindowsSystem32ExePath("taskkill.exe");
  const graceful = spawnSync(taskkillPath, ["/T", "/PID", String(pid)], {
    stdio: "ignore",
    timeout: 5_000,
    windowsHide: true,
  });
  // taskkill can race with exit; only a missing PID avoids forcing the verified owner.
  if (await waitForProcessExit(pid, graceful.status === 0 && !graceful.error ? graceMs : 0)) {
    return;
  }
  const forced = spawnSync(taskkillPath, ["/F", "/T", "/PID", String(pid)], {
    stdio: "ignore",
    timeout: 5_000,
    windowsHide: true,
  });
  if (forced.error || forced.status !== 0) {
    if (probeProcessState(pid) === "missing") {
      return;
    }
    throw new Error(`taskkill could not terminate gateway process ${pid}`);
  }
  if (!(await waitForProcessExit(pid, 5_000)) && probeProcessState(pid) === "alive") {
    throw new Error(`gateway process ${pid} is still running after taskkill`);
  }
}

export async function waitForGatewayPortRelease(port: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const diagnostics = await inspectPortUsage(port).catch(() => null);
    if (diagnostics?.status === "free") {
      return true;
    }
    await sleep(250);
  }
  return false;
}

export async function terminateBusyPortListeners(port: number): Promise<number[]> {
  const diagnostics = await inspectPortUsage(port).catch(() => null);
  if (diagnostics?.status !== "busy") {
    return [];
  }
  const pids = Array.from(
    new Set(
      diagnostics.listeners
        .map((listener) => listener.pid)
        .filter((pid): pid is number => typeof pid === "number" && Number.isFinite(pid) && pid > 0),
    ),
  );
  for (const pid of pids) {
    await terminateGatewayProcessTree(pid, 300);
  }
  return pids;
}

export function readWindowsProcessSnapshot(): WindowsProcessSnapshotEntry[] | null {
  if (process.platform !== "win32") {
    return null;
  }
  const processSnapshot = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  if (processSnapshot.error || processSnapshot.status !== 0) {
    return null;
  }
  let parsedSnapshot: unknown;
  try {
    parsedSnapshot = JSON.parse(processSnapshot.stdout.trim() || "[]");
  } catch {
    return null;
  }
  const entries = (Array.isArray(parsedSnapshot) ? parsedSnapshot : [parsedSnapshot]).filter(
    (entry): entry is WindowsProcessSnapshotEntry => typeof entry === "object" && entry !== null,
  );
  // Healthy CIM includes PowerShell itself; empty output cannot prove target exit.
  return entries.length > 0 ? entries : null;
}

export async function assertReplacementPortAvailableForTakeover(params: {
  env: GatewayServiceEnv;
  programArguments: string[];
  environment?: GatewayServiceEnv;
  fallbackPid?: number;
}): Promise<void> {
  if (!shouldManageGatewayListenerPort(params.env)) {
    return;
  }
  const port = resolveScheduledTaskCommandPort(params.env, {
    programArguments: params.programArguments,
    ...(params.environment ? { environment: params.environment } : {}),
  });
  if (!port) {
    throw new Error("Could not verify the replacement Windows Scheduled Task port.");
  }
  const diagnostics = await inspectPortUsage(port).catch(() => null);
  if (!diagnostics) {
    throw new Error(`Could not inspect replacement gateway port ${port}.`);
  }
  if (diagnostics.status === "free") {
    return;
  }
  if (diagnostics.status !== "busy") {
    throw new Error(`Could not verify replacement gateway port ${port}.`);
  }

  const allowedPids = new Set<number>();
  if (params.fallbackPid) {
    allowedPids.add(params.fallbackPid);
  }
  if (process.platform === "win32") {
    const snapshot = readWindowsProcessSnapshot();
    if (snapshot) {
      const replacementPid = findInstalledProcessPid(
        snapshot,
        port,
        params.programArguments,
        () => true,
      );
      if (replacementPid) {
        allowedPids.add(replacementPid);
      }
    }
  }
  const listenerPids = diagnostics.listeners.map((listener) => listener.pid);
  if (
    listenerPids.length > 0 &&
    listenerPids.every((pid) => typeof pid === "number" && pid > 0 && allowedPids.has(pid))
  ) {
    return;
  }
  throw new Error(`replacement gateway port ${port} is occupied by an unverified process`);
}
