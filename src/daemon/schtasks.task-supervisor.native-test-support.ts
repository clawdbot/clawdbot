import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { readWindowsProcessSnapshot } from "./schtasks-process.js";

const WAIT_INTERVAL_MS = 200;
const WAIT_TIMEOUT_MS = 30_000;

type WindowsProcessDiagnostic = {
  CommandLine?: string | null;
  ParentProcessId?: number;
  ProcessId?: number;
};

export type GatewayTaskSupervisorProbe = {
  childPidPath: string;
  failedAttemptPidPath: string;
  probePath: string;
  supervisorPidPath: string;
};

async function sleep(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, WAIT_INTERVAL_MS);
  });
}

async function waitForRecordedPid(pidPath: string, label: string): Promise<number> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const raw = await fs.readFile(pidPath, "utf8").catch(() => "");
    const pid = Number.parseInt(raw.trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 1) {
      return pid;
    }
    await sleep();
  }
  throw new Error(`Timed out waiting for Scheduled Task ${label} process id`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
    }
    await sleep();
  }
  throw new Error(`Timed out waiting for Scheduled Task process ${pid} to exit`);
}

export function createGatewayTaskSupervisorProbe(rootDir: string): GatewayTaskSupervisorProbe {
  return {
    childPidPath: path.join(rootDir, "child-pid.txt"),
    failedAttemptPidPath: path.join(rootDir, "failed-attempt-pid.txt"),
    probePath: path.join(rootDir, "probe.mts"),
    supervisorPidPath: path.join(rootDir, "supervisor-pid.txt"),
  };
}

export async function writeGatewayTaskSupervisorProbe(params: {
  activePidPath: string;
  eventsPath: string;
  probe: GatewayTaskSupervisorProbe;
}): Promise<void> {
  const taskSupervisorModuleUrl = pathToFileURL(
    path.resolve("src/cli/gateway-cli/task-supervisor.ts"),
  ).href;
  await fs.writeFile(
    params.probe.probePath,
    [
      'import { spawn } from "node:child_process";',
      'import fs from "node:fs";',
      'import net from "node:net";',
      `import { runWindowsGatewayTaskSupervisor } from ${JSON.stringify(taskSupervisorModuleUrl)};`,
      "const eventsPath = process.argv[5];",
      "const activePidPath = process.argv[6];",
      "const childPidPath = process.argv[7];",
      "const supervisorPidPath = process.argv[8];",
      "const failedAttemptPidPath = process.argv[9];",
      "const appendEvent = (phase) => fs.appendFileSync(eventsPath, `${JSON.stringify({ phase, pid: process.pid, ppid: process.ppid })}\\n`);",
      "if (process.argv.includes('--task-supervisor')) {",
      "  fs.writeFileSync(supervisorPidPath, String(process.pid));",
      "  await runWindowsGatewayTaskSupervisor();",
      "} else if (!fs.existsSync(failedAttemptPidPath)) {",
      "  fs.writeFileSync(failedAttemptPidPath, String(process.pid));",
      "  process.exit(23);",
      "} else {",
      'const portIndex = process.argv.indexOf("--port");',
      "const port = Number.parseInt(process.argv[portIndex + 1] ?? '', 10);",
      "if (!Number.isInteger(port) || port < 1) throw new Error('Missing gateway --port');",
      "const activePidTempPath = `${activePidPath}.${process.pid}.tmp`;",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "fs.writeFileSync(childPidPath, String(child.pid));",
      "const server = net.createServer((socket) => socket.end());",
      'appendEvent("started");',
      "server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {",
      "  fs.writeFileSync(activePidTempPath, String(process.pid));",
      "  fs.renameSync(activePidTempPath, activePidPath);",
      '  appendEvent("listening");',
      "});",
      "server.on('error', (error) => { console.error(error); process.exit(1); });",
      "setInterval(() => {}, 1000).unref();",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
}

export function buildGatewayTaskSupervisorProgramArguments(params: {
  activePidPath: string;
  eventsPath: string;
  gatewayPort: number;
  probe: GatewayTaskSupervisorProbe;
}): string[] {
  return [
    process.execPath,
    "--import",
    "tsx",
    params.probe.probePath,
    "gateway",
    "--port",
    String(params.gatewayPort),
    params.eventsPath,
    params.activePidPath,
    params.probe.childPidPath,
    params.probe.supervisorPidPath,
    params.probe.failedAttemptPidPath,
  ];
}

export async function waitForGatewayTaskSupervisorProcesses(params: {
  probe: GatewayTaskSupervisorProbe;
  requireFailedAttempt?: boolean;
}): Promise<{ childPid: number; supervisorPid: number }> {
  const [childPid, supervisorPid] = await Promise.all([
    waitForRecordedPid(params.probe.childPidPath, "child"),
    waitForRecordedPid(params.probe.supervisorPidPath, "supervisor"),
  ]);
  if (params.requireFailedAttempt) {
    await waitForProcessExit(
      await waitForRecordedPid(params.probe.failedAttemptPidPath, "failed child"),
    );
  }
  return { childPid, supervisorPid };
}

export function expectGatewayTaskSupervisorProcessAlive(pid: number, probePath: string): void {
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error(`Scheduled Task probe ${pid} did not remain alive`);
  }
  const processEntry = readWindowsProcessSnapshot()?.find((entry) => entry.ProcessId === pid);
  const commandLine = (processEntry?.CommandLine ?? "").replaceAll("/", "\\").toLowerCase();
  expect(commandLine).toContain("--task-supervisor");
  expect(commandLine).toContain(probePath.replaceAll("/", "\\").toLowerCase());
}

export async function waitForGatewayTaskSupervisorExit(pids: {
  childPid: number;
  supervisorPid: number;
}): Promise<void> {
  await Promise.all([waitForProcessExit(pids.childPid), waitForProcessExit(pids.supervisorPid)]);
}

export function expectScheduledTaskProbeOrigin(params: {
  eventsPath: string;
  probePath: string;
  run: { pid: number; ppid: number };
  scriptPath: string;
  readRelatedProcessDiagnostics: (needles: string[]) => {
    ok: boolean;
    processes: WindowsProcessDiagnostic[];
    truncated: boolean;
  };
}): void {
  expect(params.run.ppid).not.toBe(process.pid);
  const capture = params.readRelatedProcessDiagnostics([
    params.eventsPath,
    params.probePath,
    params.scriptPath,
  ]);
  expect(capture.ok).toBe(true);
  expect(capture.truncated).toBe(false);
  const processEntry = capture.processes.find((entry) => entry.ProcessId === params.run.pid);
  expect(processEntry?.ParentProcessId).toBe(params.run.ppid);
  const normalizeCommandLine = (value: string | null | undefined) =>
    (value ?? "").replaceAll("/", "\\").toLowerCase();
  const processCommandLine = normalizeCommandLine(processEntry?.CommandLine);
  expect(processCommandLine.includes(normalizeCommandLine(params.probePath))).toBe(true);
  expect(processCommandLine.includes(normalizeCommandLine(params.eventsPath))).toBe(true);
  expect(
    capture.processes.some((entry) =>
      normalizeCommandLine(entry.CommandLine).includes(normalizeCommandLine(params.scriptPath)),
    ),
  ).toBe(true);
}
