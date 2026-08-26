import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveGatewayWindowsTaskName } from "./constants.js";
import { execSchtasks } from "./schtasks-exec.js";
import { resolveStartupEntryPaths, resolveTaskLauncherScriptPath } from "./schtasks-layout.js";
import { readWindowsProcessSnapshot } from "./schtasks-process.js";
import { probeScheduledTaskExists } from "./schtasks-runtime.js";
import * as proof from "./schtasks.integration.test-helpers.js";
import { resolveTaskScriptPath } from "./schtasks.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { resolveGatewayService } from "./service.js";

const WAIT_INTERVAL_MS = 200;
const WAIT_TIMEOUT_MS = 30_000;
const DIAGNOSTIC_TEXT_LIMIT = 16_384;
const DIAGNOSTIC_PROCESS_LIMIT = 32;
const TASK_LOGON_INTERACTIVE_TOKEN = 3;
const TASK_RUNLEVEL_LEAST_PRIVILEGE = 0;

type ScheduledTaskPrincipal = {
  lastRunTime: string;
  lastTaskResult: number;
  logonType: number;
  runLevel: number;
  taskState: number;
};

type WindowsProcessDiagnostic = {
  CommandLine?: string | null;
  ParentProcessId?: number;
  ProcessId?: number;
};

type FailureDiagnosticSnapshot = {
  capturedAt: string;
  principal: ScheduledTaskPrincipal | null;
  principalError: string | null;
  processCapture: {
    error: string | null;
    ok: boolean;
    processes: WindowsProcessDiagnostic[];
    truncated: boolean;
  };
  taskXml: string | null;
  verboseQuery: {
    code: number;
    stdout: string | null;
    stderr: string | null;
  };
};

type TaskDefinitionSnapshot = { exists: false; taskXml: null } | { exists: true; taskXml: string };

async function sleep(delayMs = WAIT_INTERVAL_MS): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function waitForRuntimeStatus(
  readRuntime: () => Promise<GatewayServiceRuntime>,
  expected: "running" | "stopped",
  expectedPid?: number,
): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastStatus = "unknown";
  let lastDetail = "";
  let lastPid: number | undefined;
  while (Date.now() < deadline) {
    const runtime = await readRuntime();
    lastStatus = runtime.status ?? "unknown";
    lastDetail = runtime.detail ?? "";
    lastPid = runtime.pid;
    if (runtime.status === expected && (expectedPid === undefined || runtime.pid === expectedPid)) {
      return;
    }
    await sleep();
  }
  throw new Error(
    `Timed out waiting for Scheduled Task status=${expected}${
      expectedPid === undefined ? "" : ` pid=${expectedPid}`
    }; observed ${lastStatus}${lastPid === undefined ? "" : ` pid=${lastPid}`}: ${lastDetail}`,
  );
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep();
  }
  throw new Error(`Timed out waiting for Scheduled Task process ${pid} to exit`);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback port for the Scheduled Task probe");
  }
  const port = (address as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function canBindLoopbackPort(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function waitForLoopbackPortRelease(port: number): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await canBindLoopbackPort(port)) {
      return;
    }
    await sleep();
  }
  throw new Error(`Timed out waiting for Scheduled Task loopback port ${port} to be reusable`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readTaskXml(taskName: string): Promise<string | null> {
  const result = await execSchtasks(["/Query", "/TN", taskName, "/XML"]);
  return result.code === 0
    ? result.stdout.replace(/^\uFEFF/u, "").replaceAll(String.fromCharCode(0), "")
    : null;
}

function readTaskPrincipal(taskName: string): ScheduledTaskPrincipal {
  const encodedTaskName = Buffer.from(taskName, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$taskName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTaskName}'))`,
    "$service=New-Object -ComObject 'Schedule.Service'",
    "$service.Connect()",
    "$task=$service.GetFolder('\\').GetTask($taskName)",
    "$principal=$task.Definition.Principal",
    "$result=@{logonType=[int]$principal.LogonType;runLevel=[int]$principal.RunLevel;taskState=[int]$task.State;lastTaskResult=[int64]$task.LastTaskResult;lastRunTime=$task.LastRunTime.ToUniversalTime().ToString('o')}",
    "[Console]::Out.Write(($result | ConvertTo-Json -Compress))",
  ].join("; ");
  const result = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Could not inspect Scheduled Task principal for ${taskName}: ${
        result.stderr.trim() || `PowerShell exited ${result.status ?? "without status"}`
      }`,
    );
  }
  const parsed = JSON.parse(result.stdout.trim()) as Partial<ScheduledTaskPrincipal>;
  if (
    typeof parsed.logonType !== "number" ||
    !Number.isInteger(parsed.logonType) ||
    typeof parsed.runLevel !== "number" ||
    !Number.isInteger(parsed.runLevel) ||
    typeof parsed.taskState !== "number" ||
    !Number.isInteger(parsed.taskState) ||
    typeof parsed.lastTaskResult !== "number" ||
    !Number.isInteger(parsed.lastTaskResult) ||
    typeof parsed.lastRunTime !== "string"
  ) {
    throw new Error(`Scheduled Task principal returned invalid data for ${taskName}`);
  }
  return {
    lastRunTime: parsed.lastRunTime,
    lastTaskResult: parsed.lastTaskResult,
    logonType: parsed.logonType,
    runLevel: parsed.runLevel,
    taskState: parsed.taskState,
  };
}

function readRelatedProcessDiagnostics(needles: string[]): {
  error: string | null;
  ok: boolean;
  processes: WindowsProcessDiagnostic[];
  truncated: boolean;
} {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000, windowsHide: true },
  );
  if (result.error) {
    return { error: result.error.message, ok: false, processes: [], truncated: false };
  }
  if (result.status !== 0) {
    return {
      error: result.stderr.trim() || `PowerShell exited ${result.status ?? "without status"}`,
      ok: false,
      processes: [],
      truncated: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim() || "[]");
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
      processes: [],
      truncated: false,
    };
  }
  const entries = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (entry): entry is WindowsProcessDiagnostic => typeof entry === "object" && entry !== null,
  );
  const normalizedNeedles = needles.map((needle) => needle.replaceAll("/", "\\").toLowerCase());
  const matching = entries.filter((entry) => {
    const commandLine = (entry.CommandLine ?? "").replaceAll("/", "\\").toLowerCase();
    return normalizedNeedles.some((needle) => commandLine.includes(needle));
  });
  const parentPids = new Set(
    matching
      .map((entry) => entry.ParentProcessId)
      .filter((pid): pid is number => typeof pid === "number"),
  );
  const processes = entries.filter(
    (entry) =>
      matching.includes(entry) ||
      (typeof entry.ProcessId === "number" && parentPids.has(entry.ProcessId)),
  );
  return {
    error: null,
    ok: true,
    processes: processes.slice(0, DIAGNOSTIC_PROCESS_LIMIT),
    truncated: processes.length > DIAGNOSTIC_PROCESS_LIMIT,
  };
}

function sanitizeDiagnosticText(
  value: string | null | undefined,
  replacements: Array<[string, string]>,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const variantPlaceholders = new Map<string, string>();
  for (const [privateValue, placeholder] of replacements) {
    if (privateValue) {
      for (const variant of new Set([
        privateValue,
        privateValue.replaceAll("/", "\\"),
        privateValue.replaceAll("\\", "/"),
      ])) {
        variantPlaceholders.set(variant.toLowerCase(), placeholder);
      }
    }
  }
  const pattern = Array.from(variantPlaceholders.keys())
    .toSorted((left, right) => right.length - left.length)
    .map((variant) => variant.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const sanitized = pattern
    ? value.replace(new RegExp(pattern, "giu"), (match) => {
        return variantPlaceholders.get(match.toLowerCase()) ?? match;
      })
    : value;
  return sanitized.length <= DIAGNOSTIC_TEXT_LIMIT
    ? sanitized
    : `${sanitized.slice(0, DIAGNOSTIC_TEXT_LIMIT)}\n[truncated]`;
}

function sanitizeTaskXml(
  value: string | null,
  replacements: Array<[string, string]>,
): string | null {
  const identityRedacted =
    value?.replace(
      /<(UserId|Author)>([\s\S]*?)<\/\1>/giu,
      (_match, tag: string) => `<${tag}><task-user></${tag}>`,
    ) ?? null;
  if (identityRedacted === null) {
    return null;
  }
  return identityRedacted
    .split(/(<[^>]+>)/gu)
    .map((segment) =>
      segment.startsWith("<") ? segment : (sanitizeDiagnosticText(segment, replacements) ?? ""),
    )
    .join("");
}

function sanitizeVerboseQuery(value: string, replacements: Array<[string, string]>): string | null {
  return (
    sanitizeDiagnosticText(value, replacements)?.replace(
      /^(\s*(?:HostName|Run As User)\s*:\s*).*$/gimu,
      "$1<redacted>",
    ) ?? null
  );
}

function resolveDiagnosticReplacements(params: {
  rootDir: string;
  stateDir: string;
}): Array<[string, string]> {
  const username = os.userInfo().username;
  const domain = process.env.USERDOMAIN?.trim();
  return [
    [os.userInfo().homedir, "<account-home>"],
    [params.rootDir, "<integration-root>"],
    [params.stateDir, "<state-dir>"],
    [domain && username ? `${domain}\\${username}` : "", "<task-user>"],
    [process.env.COMPUTERNAME?.trim() ?? "", "<host>"],
    [os.hostname(), "<host>"],
  ];
}

function assertInteractiveLeastPrivilegeTask(params: {
  principal: ScheduledTaskPrincipal;
  taskXml: string;
}): void {
  expect(params.taskXml).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(params.principal.logonType).toBe(TASK_LOGON_INTERACTIVE_TOKEN);
  expect(params.principal.runLevel).toBe(TASK_RUNLEVEL_LEAST_PRIVILEGE);
  const exportedRunLevel = params.taskXml.match(/<RunLevel>([^<]+)<\/RunLevel>/u)?.[1];
  // Task Scheduler may omit the default LeastPrivilege node when exporting XML.
  // If present, it must agree with the effective COM principal checked above.
  expect(exportedRunLevel === undefined || exportedRunLevel === "LeastPrivilege").toBe(true);
}

async function waitForSuccessfulScheduledTaskRun(
  taskName: string,
): Promise<ScheduledTaskPrincipal> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastPrincipal: ScheduledTaskPrincipal | null = null;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      lastPrincipal = readTaskPrincipal(taskName);
      if (
        lastPrincipal.lastTaskResult === 0 &&
        !Number.isNaN(Date.parse(lastPrincipal.lastRunTime)) &&
        Date.parse(lastPrincipal.lastRunTime) > 0
      ) {
        return lastPrincipal;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep();
  }
  throw new Error(
    `Timed out waiting for Scheduled Task ${taskName} to record a successful run; ${
      lastPrincipal
        ? `observed state=${lastPrincipal.taskState} result=${lastPrincipal.lastTaskResult}`
        : `last inspection failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    }`,
  );
}

async function readTaskDefinitionSnapshot(taskName: string): Promise<TaskDefinitionSnapshot> {
  const exists = probeScheduledTaskExists(taskName);
  if (exists === null) {
    throw new Error(`Could not determine whether Scheduled Task ${taskName} exists`);
  }
  if (!exists) {
    return { exists: false, taskXml: null };
  }
  const taskXml = await readTaskXml(taskName);
  if (!taskXml) {
    throw new Error(`Could not export Scheduled Task XML for ${taskName}`);
  }
  return { exists: true, taskXml };
}

async function clearActivePid(activePidPath: string, pid: number): Promise<void> {
  const activePid = Number.parseInt(await fs.readFile(activePidPath, "utf8").catch(() => ""), 10);
  if (activePid === pid) {
    await fs.rm(activePidPath, { force: true });
  }
}

async function forceKillActiveProcess(params: {
  activePidPath: string;
  eventsPath: string;
  probePath: string;
}): Promise<void> {
  await sleep();
  let activePidText: string;
  try {
    activePidText = await fs.readFile(params.activePidPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const activePid = Number.parseInt(activePidText.trim(), 10);
  if (!Number.isSafeInteger(activePid) || activePid <= 1) {
    throw new Error(`Invalid Scheduled Task active process id: ${activePidText.trim() || "empty"}`);
  }
  if (!isProcessAlive(activePid)) {
    await fs.rm(params.activePidPath, { force: true });
    return;
  }
  const normalizedProbePath = params.probePath.replaceAll("/", "\\").toLowerCase();
  const normalizedEventsPath = params.eventsPath.replaceAll("/", "\\").toLowerCase();
  const snapshot = readWindowsProcessSnapshot();
  if (!snapshot) {
    throw new Error("Could not verify Scheduled Task probe ownership during cleanup");
  }
  const activeProcess = snapshot.find((entry) => entry.ProcessId === activePid);
  const commandLine = (activeProcess?.CommandLine ?? "").replaceAll("/", "\\").toLowerCase();
  if (!commandLine.includes(normalizedProbePath) || !commandLine.includes(normalizedEventsPath)) {
    throw new Error(
      `Refused to kill reused or unverifiable Scheduled Task process id ${activePid}`,
    );
  }
  try {
    process.kill(activePid, "SIGKILL");
  } catch {}
  await waitForProcessExit(activePid);
  await fs.rm(params.activePidPath, { force: true });
}

async function readFailureDiagnosticSnapshot(params: {
  eventsPath: string;
  probePath: string;
  replacements: Array<[string, string]>;
  scriptPath: string;
  taskName: string;
}): Promise<FailureDiagnosticSnapshot> {
  const verboseQuery = await execSchtasks(["/Query", "/TN", params.taskName, "/V", "/FO", "LIST"]);
  const taskXml = await readTaskXml(params.taskName);
  let principal: ScheduledTaskPrincipal | null = null;
  let principalError: string | null = null;
  try {
    principal = readTaskPrincipal(params.taskName);
  } catch (error) {
    principalError = error instanceof Error ? error.message : String(error);
  }
  const processCapture = readRelatedProcessDiagnostics([
    params.scriptPath,
    params.probePath,
    params.eventsPath,
  ]);
  for (const process of processCapture.processes) {
    process.CommandLine = sanitizeDiagnosticText(process.CommandLine, params.replacements);
  }
  return {
    capturedAt: new Date().toISOString(),
    principal,
    principalError: sanitizeDiagnosticText(principalError, params.replacements),
    processCapture: {
      ...processCapture,
      error: sanitizeDiagnosticText(processCapture.error, params.replacements),
    },
    taskXml: sanitizeTaskXml(taskXml, params.replacements),
    verboseQuery: {
      code: verboseQuery.code,
      stdout: sanitizeVerboseQuery(verboseQuery.stdout, params.replacements),
      stderr: sanitizeDiagnosticText(verboseQuery.stderr, params.replacements),
    },
  };
}

async function writeFailureDiagnostics(params: {
  cleanupEnd: { stdout: string; stderr: string; code: number } | null;
  postEnd: FailureDiagnosticSnapshot | null;
  postEndError: string | null;
  preCleanup: FailureDiagnosticSnapshot | null;
  preCleanupError: string | null;
  replacements: Array<[string, string]>;
  rootDir: string;
  serviceOutput: string;
}): Promise<void> {
  await fs.writeFile(
    path.join(params.rootDir, "failure-diagnostics.json"),
    `${JSON.stringify(
      {
        preCleanup: params.preCleanup,
        preCleanupError: sanitizeDiagnosticText(params.preCleanupError, params.replacements),
        cleanupEnd: params.cleanupEnd
          ? {
              code: params.cleanupEnd.code,
              stdout: sanitizeDiagnosticText(params.cleanupEnd.stdout, params.replacements),
              stderr: sanitizeDiagnosticText(params.cleanupEnd.stderr, params.replacements),
            }
          : null,
        postEnd: params.postEnd,
        postEndError: sanitizeDiagnosticText(params.postEndError, params.replacements),
        serviceOutput: sanitizeDiagnosticText(params.serviceOutput, params.replacements),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function cleanupNativeTask(params: {
  activePidPath: string;
  eventsPath: string;
  preserveEvidence: boolean;
  probePath: string;
  rootDir: string;
  scriptPath: string;
  serviceOutput: string;
  stateDir: string;
  taskName: string;
}): Promise<void> {
  const cleanupErrors: unknown[] = [];
  const replacements = resolveDiagnosticReplacements({
    rootDir: params.rootDir,
    stateDir: params.stateDir,
  });
  const snapshotParams = {
    eventsPath: params.eventsPath,
    probePath: params.probePath,
    replacements,
    scriptPath: params.scriptPath,
    taskName: params.taskName,
  };
  let preCleanup: FailureDiagnosticSnapshot | null = null;
  let preCleanupError: string | null = null;
  if (params.preserveEvidence) {
    try {
      preCleanup = await readFailureDiagnosticSnapshot(snapshotParams);
    } catch (error) {
      preCleanupError = error instanceof Error ? error.message : String(error);
    }
  }
  const endResult = await execSchtasks(["/End", "/TN", params.taskName]).catch((error: unknown) => {
    cleanupErrors.push(error);
    return null;
  });
  if (params.preserveEvidence) {
    let postEnd: FailureDiagnosticSnapshot | null = null;
    let postEndError: string | null = null;
    try {
      postEnd = await readFailureDiagnosticSnapshot(snapshotParams);
    } catch (error) {
      postEndError = error instanceof Error ? error.message : String(error);
    }
    try {
      await writeFailureDiagnostics({
        cleanupEnd: endResult,
        postEnd,
        postEndError,
        preCleanup,
        preCleanupError,
        replacements,
        rootDir: params.rootDir,
        serviceOutput: params.serviceOutput,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await forceKillActiveProcess({
      activePidPath: params.activePidPath,
      eventsPath: params.eventsPath,
      probePath: params.probePath,
    });
  } catch (error) {
    cleanupErrors.push(error);
  }
  const deletion = await execSchtasks(["/Delete", "/F", "/TN", params.taskName]).catch(
    (error: unknown) => {
      cleanupErrors.push(error);
      return null;
    },
  );
  const taskExists = probeScheduledTaskExists(params.taskName);
  if (taskExists === null) {
    cleanupErrors.push(new Error(`Could not verify Scheduled Task cleanup for ${params.taskName}`));
  } else if (taskExists) {
    const detail = deletion ? (deletion.stderr || deletion.stdout).trim() : "";
    cleanupErrors.push(
      new Error(
        `Scheduled Task cleanup left ${params.taskName} registered${detail ? `: ${detail}` : ""}`,
      ),
    );
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Native Scheduled Task process or task cleanup failed");
  }
  if (params.preserveEvidence) {
    return;
  }
  for (const cleanupPath of [params.stateDir, params.rootDir]) {
    try {
      await fs.rm(cleanupPath, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Native Scheduled Task path cleanup failed");
  }
}

function expectProbeProcessAlive(pid: number): void {
  expect(isProcessAlive(pid), `Scheduled Task probe ${pid} did not remain alive`).toBe(true);
}

function expectScheduledTaskProbeOrigin(params: {
  eventsPath: string;
  probePath: string;
  run: proof.ProbeRunEvent;
  scriptPath: string;
}): void {
  expect(params.run.ppid).not.toBe(process.pid);
  const capture = readRelatedProcessDiagnostics([
    params.eventsPath,
    params.probePath,
    params.scriptPath,
  ]);
  expect(capture.ok).toBe(true);
  expect(capture.truncated).toBe(false);
  const processEntry = capture.processes.find((entry) => entry.ProcessId === params.run.pid);
  expect(processEntry?.ParentProcessId).toBe(params.run.ppid);
  const parentEntry = capture.processes.find((entry) => entry.ProcessId === params.run.ppid);
  const normalizeCommandLine = (value: string | null | undefined) =>
    (value ?? "").replaceAll("/", "\\").toLowerCase();
  const processCommandLine = normalizeCommandLine(processEntry?.CommandLine);
  expect(processCommandLine.includes(normalizeCommandLine(params.probePath))).toBe(true);
  expect(processCommandLine.includes(normalizeCommandLine(params.eventsPath))).toBe(true);
  expect(
    normalizeCommandLine(parentEntry?.CommandLine).includes(
      normalizeCommandLine(params.scriptPath),
    ),
  ).toBe(true);
}

function resolveTestId(): string {
  const configured = process.env.CI_WINDOWS_SCHTASKS_TEST_ID?.trim();
  if (!configured) {
    return randomUUID().slice(0, 8);
  }
  if (!/^[a-z0-9-]{1,48}$/u.test(configured)) {
    throw new Error("CI_WINDOWS_SCHTASKS_TEST_ID must use lowercase letters, digits, or -");
  }
  return configured;
}

async function createIntegrationRoot(
  configuredRoot: string | undefined,
  id: string,
): Promise<string> {
  if (!configuredRoot) {
    return fs.mkdtemp(path.join(os.tmpdir(), `openclaw-schtasks-int-${id}-`));
  }
  const rootDir = path.resolve(configuredRoot);
  try {
    // Cleanup may only remove a directory this exact run created.
    await fs.mkdir(rootDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`CI_WINDOWS_SCHTASKS_ROOT must not already exist: ${rootDir}`, {
        cause: error,
      });
    }
    throw error;
  }
  return rootDir;
}

describe("schtasks Windows integration principal assertion", () => {
  it("accepts omitted default run level when COM reports least privilege", () => {
    expect(() =>
      assertInteractiveLeastPrivilegeTask({
        taskXml: "<LogonType>InteractiveToken</LogonType>",
        principal: {
          lastRunTime: "2026-07-31T00:00:00.0000000Z",
          lastTaskResult: 0,
          logonType: TASK_LOGON_INTERACTIVE_TOKEN,
          runLevel: TASK_RUNLEVEL_LEAST_PRIVILEGE,
          taskState: 3,
        },
      }),
    ).not.toThrow();
  });

  it("rejects an elevated effective run level", () => {
    expect(() =>
      assertInteractiveLeastPrivilegeTask({
        taskXml: "<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>",
        principal: {
          lastRunTime: "2026-07-31T00:00:00.0000000Z",
          lastTaskResult: 0,
          logonType: TASK_LOGON_INTERACTIVE_TOKEN,
          runLevel: 1,
          taskState: 3,
        },
      }),
    ).toThrow();
  });

  it("refuses to reuse or delete an existing configured root", async () => {
    const existingRoot = path.join(os.tmpdir(), `openclaw-schtasks-existing-${randomUUID()}`);
    await fs.mkdir(existingRoot);
    try {
      await expect(createIntegrationRoot(existingRoot, "existing")).rejects.toThrow(
        "CI_WINDOWS_SCHTASKS_ROOT must not already exist",
      );
      await expect(fs.access(existingRoot)).resolves.toBeUndefined();
    } finally {
      await fs.rm(existingRoot, { recursive: true, force: true });
    }
  });

  it("redacts task identities without rewriting placeholders", () => {
    expect(
      sanitizeDiagnosticText("openclaw user on host-user", [
        ["openclaw", "<product>"],
        ["user", "<task-user>"],
      ]),
    ).toBe("<product> <task-user> on host-<task-user>");
    expect(
      sanitizeTaskXml("<Task><Author>private</Author><UserId>S-1-5-21</UserId></Task>", [
        ["user", "<task-user>"],
      ]),
    ).toBe("<Task><Author><task-user></Author><UserId><task-user></UserId></Task>");
    expect(
      sanitizeTaskXml("<Task><Author>private</Author><UserId>S-1-5-21</UserId></Task>", [
        ["openclaw", "<product>"],
      ]),
    ).toBe("<Task><Author><task-user></Author><UserId><task-user></UserId></Task>");
  });
});

const nativeIntegrationEnabled =
  process.platform === "win32" && process.env.CI_WINDOWS_SCHTASKS_INTEGRATION === "1";

describe.runIf(nativeIntegrationEnabled)("schtasks Windows integration", () => {
  it("isolates and completes the native Scheduled Task lifecycle", async () => {
    const id = resolveTestId();
    const configuredRoot = process.env.CI_WINDOWS_SCHTASKS_ROOT?.trim();
    const rootDir = await createIntegrationRoot(configuredRoot, id);
    const accountHome = os.userInfo().homedir;
    const profile = `schtasks-int-${id}`;
    const stateDir = path.join(accountHome, `.openclaw-${profile}`);
    const activePidPath = path.join(rootDir, "active-pid.txt");
    const eventsPath = path.join(rootDir, "runs.txt");
    const probePath = path.join(rootDir, "probe.cjs");
    const gatewayPort = await reserveLoopbackPort();
    const taskName = resolveGatewayWindowsTaskName(profile);
    const stdout = new PassThrough();
    let serviceOutput = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      if (serviceOutput.length < DIAGNOSTIC_TEXT_LIMIT) {
        serviceOutput = `${serviceOutput}${chunk}`.slice(0, DIAGNOSTIC_TEXT_LIMIT);
      }
    });
    const env: GatewayServiceEnv = {
      ...process.env,
      APPDATA: path.join(rootDir, "appdata"),
      HOME: accountHome,
      USERPROFILE: accountHome,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_GATEWAY_PORT: String(gatewayPort),
      OPENCLAW_HOME: undefined,
      OPENCLAW_PROFILE: profile,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TASK_SCRIPT: undefined,
      OPENCLAW_TASK_SCRIPT_NAME: undefined,
      OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
      OPENCLAW_WINDOWS_TASK_NAME: undefined,
    };
    const defaultTaskBefore = await readTaskDefinitionSnapshot("OpenClaw Gateway");
    const scriptPath = resolveTaskScriptPath(env);
    const launcherPath = resolveTaskLauncherScriptPath(env, scriptPath);

    await fs.writeFile(
      probePath,
      [
        'const fs = require("node:fs");',
        'const net = require("node:net");',
        "const eventsPath = process.argv[5];",
        "const activePidPath = process.argv[6];",
        "const appendEvent = (phase) => fs.appendFileSync(eventsPath, `${JSON.stringify({ phase, pid: process.pid, ppid: process.ppid })}\\n`);",
        'const portIndex = process.argv.indexOf("--port");',
        "const port = Number.parseInt(process.argv[portIndex + 1] ?? '', 10);",
        "if (!Number.isInteger(port) || port < 1) throw new Error('Missing gateway --port');",
        "const activePidTempPath = `${activePidPath}.${process.pid}.tmp`;",
        "const server = net.createServer((socket) => socket.end());",
        'appendEvent("started");',
        "server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {",
        "  fs.writeFileSync(activePidTempPath, String(process.pid));",
        "  fs.renameSync(activePidTempPath, activePidPath);",
        '  appendEvent("listening");',
        "});",
        "server.on('error', (error) => { console.error(error); process.exit(1); });",
        "setInterval(() => {}, 1000).unref();",
        "",
      ].join("\n"),
      "utf8",
    );

    let testFailed = false;
    let testError: unknown;
    let lifecyclePids: number[] = [];
    let installedPrincipal: ScheduledTaskPrincipal | null = null;
    const programArguments = [
      process.execPath,
      probePath,
      "gateway",
      "--port",
      String(gatewayPort),
      eventsPath,
      activePidPath,
    ];
    try {
      await withEnvAsync(env, async () => {
        const service = resolveGatewayService();
        const readRuntime = () => service.readRuntime(env);

        expect((await execSchtasks(["/Query", "/TN", taskName])).code).not.toBe(0);
        expect(path.relative(stateDir, scriptPath)).not.toMatch(/^\.\.(?:[\\/]|$)/u);
        expect(await canBindLoopbackPort(gatewayPort)).toBe(true);

        await service.install({
          env,
          stdout,
          programArguments,
          workingDirectory: rootDir,
          environment: { OPENCLAW_GATEWAY_PORT: String(gatewayPort) },
          description: `OpenClaw CI Scheduled Task integration ${id}`,
        });

        expect((await execSchtasks(["/Query", "/TN", taskName])).code).toBe(0);
        const taskXml = await readTaskXml(taskName);
        if (!taskXml) {
          throw new Error(`Could not export Scheduled Task XML for ${taskName}`);
        }
        expect(taskXml).toContain("<UserId>");
        expect(taskXml.replaceAll("/", "\\").toLowerCase()).toContain(
          launcherPath.replaceAll("/", "\\").toLowerCase(),
        );
        installedPrincipal = await waitForSuccessfulScheduledTaskRun(taskName);
        assertInteractiveLeastPrivilegeTask({
          taskXml,
          principal: installedPrincipal,
        });
        for (const startupEntryPath of resolveStartupEntryPaths(env)) {
          await expect(fs.access(startupEntryPath)).rejects.toThrow();
        }
        const command = await service.readCommand(env);
        expect(command?.programArguments).toEqual(programArguments);
        expect(command?.environment?.OPENCLAW_GATEWAY_PORT).toBe(String(gatewayPort));
        const installedRun = await proof.waitForExactProbeRun(eventsPath, 1);
        const installedPid = installedRun.pid;
        expectProbeProcessAlive(installedPid);
        expectScheduledTaskProbeOrigin({
          eventsPath,
          probePath,
          run: installedRun,
          scriptPath,
        });
        expect(await canBindLoopbackPort(gatewayPort)).toBe(false);
        await waitForRuntimeStatus(readRuntime, "running", installedPid);

        const stopMutations: string[] = [];
        await service.stop({
          env,
          stdout,
          onMutation: (mutation) => stopMutations.push(mutation.mode),
        });
        expect(stopMutations).toEqual(["schtasks-stop"]);
        await waitForProcessExit(installedPid);
        await clearActivePid(activePidPath, installedPid);
        await waitForLoopbackPortRelease(gatewayPort);
        await waitForRuntimeStatus(readRuntime, "stopped");
        expect((await execSchtasks(["/Query", "/TN", taskName])).code).toBe(0);

        const startMutations: string[] = [];
        await service.start({
          env,
          stdout,
          onMutation: (mutation) => startMutations.push(mutation.mode),
        });
        expect(startMutations).toEqual(["schtasks-start"]);
        const startedRun = await proof.waitForExactProbeRun(eventsPath, 2);
        const startedPid = startedRun.pid;
        expect(startedPid).not.toBe(installedPid);
        expectProbeProcessAlive(startedPid);
        expectScheduledTaskProbeOrigin({
          eventsPath,
          probePath,
          run: startedRun,
          scriptPath,
        });
        expect(await canBindLoopbackPort(gatewayPort)).toBe(false);
        await waitForRuntimeStatus(readRuntime, "running", startedPid);

        const restartMutations: string[] = [];
        const restartResult = await service.restart({
          env,
          stdout,
          onMutation: (mutation) => restartMutations.push(mutation.mode),
        });
        expect(restartResult).toEqual({ outcome: "completed" });
        expect(restartMutations).toEqual(["schtasks-end", "schtasks-restart"]);
        const restartedRun = await proof.waitForExactProbeRun(eventsPath, 3);
        const restartedPid = restartedRun.pid;
        lifecyclePids = [installedPid, startedPid, restartedPid];
        expect(restartedPid).not.toBe(startedPid);
        expectProbeProcessAlive(restartedPid);
        expectScheduledTaskProbeOrigin({
          eventsPath,
          probePath,
          run: restartedRun,
          scriptPath,
        });
        await waitForProcessExit(startedPid);
        await clearActivePid(activePidPath, startedPid);
        expect(await canBindLoopbackPort(gatewayPort)).toBe(false);
        await waitForRuntimeStatus(readRuntime, "running", restartedPid);

        await service.stop({ env, stdout });
        await waitForProcessExit(restartedPid);
        await clearActivePid(activePidPath, restartedPid);
        await waitForLoopbackPortRelease(gatewayPort);
        await waitForRuntimeStatus(readRuntime, "stopped");

        await service.uninstall({ env, stdout });
        expect((await execSchtasks(["/Query", "/TN", taskName])).code).not.toBe(0);
        await expect(fs.access(scriptPath)).rejects.toThrow();
        await expect(fs.access(launcherPath)).rejects.toThrow();
        expect(await canBindLoopbackPort(gatewayPort)).toBe(true);
        expect(await readTaskDefinitionSnapshot("OpenClaw Gateway")).toEqual(defaultTaskBefore);
        const startupFallbackProof = await proof.proveNativeStartupFallbackLaunch({ env, rootDir });

        const proofPath = process.env.CI_WINDOWS_SCHTASKS_PROOF_PATH?.trim();
        if (proofPath) {
          const proofHead = process.env.CI_WINDOWS_SCHTASKS_HEAD?.trim();
          if (!proofHead || !/^[0-9a-f]{40}$/u.test(proofHead)) {
            throw new Error(
              "CI_WINDOWS_SCHTASKS_HEAD must identify the exact 40-character checkout SHA",
            );
          }
          await fs.mkdir(path.dirname(proofPath), { recursive: true });
          await fs.writeFile(
            proofPath,
            `${JSON.stringify(
              {
                result: "pass",
                head: proofHead,
                profile,
                taskName,
                lifecycle: ["install", "stop", "start", "restart", "stop", "uninstall"],
                pids: lifecyclePids,
                gatewayPort,
                portReleaseRebind: true,
                startupFallback: false,
                startupFallbackProof,
                defaultTaskUnchanged: true,
                taskXml: {
                  interactiveToken: true,
                  leastPrivilege: true,
                  logonType: installedPrincipal?.logonType,
                  runLevel: installedPrincipal?.runLevel,
                },
              },
              null,
              2,
            )}\n`,
            "utf8",
          );
        }
      });
    } catch (error) {
      testFailed = true;
      testError = error;
    }

    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      await cleanupNativeTask({
        activePidPath,
        eventsPath,
        preserveEvidence: testFailed,
        probePath,
        rootDir,
        scriptPath,
        serviceOutput,
        stateDir,
        taskName,
      });
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    }
    if (cleanupFailed) {
      throw new AggregateError(
        testFailed ? [testError, cleanupError] : [cleanupError],
        "Native Scheduled Task cleanup failed",
      );
    }
    if (testFailed) {
      throw testError;
    }
  }, 180_000);
});
