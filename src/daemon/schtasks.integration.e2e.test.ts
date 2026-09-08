import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveGatewayWindowsTaskName } from "./constants.js";
import { execSchtasks } from "./schtasks-exec.js";
import { resolveStartupEntryPaths, resolveTaskLauncherScriptPath } from "./schtasks-layout.js";
import { readWindowsProcessSnapshot } from "./schtasks-process.js";
import { probeScheduledTaskExists } from "./schtasks-state-probe.js";
import {
  assertInteractiveLeastPrivilegeTask,
  DIAGNOSTIC_TEXT_LIMIT,
  readRelatedProcessDiagnostics,
  readTaskPrincipal,
  readTaskXml,
  resolveDiagnosticReplacements,
  sanitizeDiagnosticText,
  sanitizeTaskXml,
  sanitizeVerboseQuery,
  TASK_LOGON_INTERACTIVE_TOKEN,
  TASK_RUNLEVEL_LEAST_PRIVILEGE,
  type ScheduledTaskPrincipal,
  type WindowsProcessDiagnostic,
} from "./schtasks.integration-observation.test-support.js";
import * as proof from "./schtasks.integration.test-helpers.js";
import { resolveTaskScriptPath } from "./schtasks.js";
import {
  buildGatewayTaskSupervisorProgramArguments,
  createGatewayTaskSupervisorProbe,
  expectGatewayTaskSupervisorProcessAlive,
  expectScheduledTaskProbeOrigin,
  isProcessAlive,
  stopGatewayTaskWithPowerShell,
  waitForGatewayTaskSupervisorExit,
  waitForGatewayTaskSupervisorProcesses,
  waitForProcessExit,
  writeGatewayTaskSupervisorProbe,
} from "./schtasks.task-supervisor.native-test-support.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { resolveGatewayService } from "./service.js";

const WAIT_INTERVAL_MS = 200;
const WAIT_TIMEOUT_MS = 30_000;
const TASK_STATE_READY = 3;
const TASK_STATE_RUNNING = 4;

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

async function waitForCompletedScheduledTaskRun(
  taskName: string,
  exitCode: number,
): Promise<ScheduledTaskPrincipal> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastPrincipal: ScheduledTaskPrincipal | null = null;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      lastPrincipal = readTaskPrincipal(taskName);
      if (
        lastPrincipal.taskState === TASK_STATE_READY &&
        lastPrincipal.lastTaskResult === exitCode &&
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
    `Timed out waiting for Scheduled Task ${taskName} to finish with exit ${exitCode}; ${
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
  try {
    // Service guards observe config in this test process. Native child exit does
    // not close that parent-held database; release only this fixture before unlink.
    const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: params.stateDir });
    const cachedStateHandleClosed = closeOpenClawStateDatabaseByPath(databasePath);
    console.log(`[windows-schtasks-cleanup] ${JSON.stringify({ cachedStateHandleClosed })}`);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Native Scheduled Task resource cleanup failed");
  }
  if (params.preserveEvidence) {
    return;
  }
  // Stop at the first filesystem failure so remaining fixture evidence survives.
  for (const cleanupPath of [params.stateDir, params.rootDir]) {
    await fs.rm(cleanupPath, { recursive: true, force: true });
  }
}

function expectProbeProcessAlive(pid: number): void {
  expect(isProcessAlive(pid), `Scheduled Task probe ${pid} did not remain alive`).toBe(true);
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
          enabled: true,
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
          enabled: true,
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
    const probe = createGatewayTaskSupervisorProbe(rootDir);
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
    const scriptPath = resolveTaskScriptPath(env);
    const launcherPath = resolveTaskLauncherScriptPath(env, scriptPath);

    // Source workers resolve tsx from the task cwd; give the isolated fixture its dependencies.
    await fs.symlink(path.resolve("node_modules"), path.join(rootDir, "node_modules"), "junction");
    await writeGatewayTaskSupervisorProbe({ activePidPath, eventsPath, probe });

    let testFailed = false;
    let testError: unknown;
    const lifecyclePids: number[] = [];
    let installedPrincipal: ScheduledTaskPrincipal | null = null;
    let pendingProof: { path: string; content: string } | undefined;
    const programArguments = buildGatewayTaskSupervisorProgramArguments({
      activePidPath,
      eventsPath,
      gatewayPort,
      probe,
    });
    try {
      await fs.mkdir(stateDir);
      await fs.writeFile(path.join(stateDir, "openclaw.json"), "{}\n");
      pendingProof = await withEnvAsync(env, async () => {
        const startupFallbackProof = await proof.proveNativeStartupFallbackLaunch({ env, rootDir });
        const defaultTaskBefore = await readTaskDefinitionSnapshot("OpenClaw Gateway");
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
          environment: {
            OPENCLAW_PROFILE: profile,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: env.OPENCLAW_CONFIG_PATH,
            OPENCLAW_GATEWAY_PORT: String(gatewayPort),
            OPENCLAW_SERVICE_KIND: "gateway",
            OPENCLAW_SERVICE_MARKER: "openclaw",
            // Source aliases belong to the checkout, even when the task runs outside it.
            TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
          },
          description: `OpenClaw CI Scheduled Task integration ${id}`,
        });

        const failedProcesses = await waitForGatewayTaskSupervisorProcesses({
          probe,
          failedAttempt: true,
        });
        installedPrincipal = await waitForCompletedScheduledTaskRun(taskName, 23);
        await waitForGatewayTaskSupervisorExit(failedProcesses);

        expect((await execSchtasks(["/Query", "/TN", taskName])).code).toBe(0);
        const taskXml = await readTaskXml(taskName);
        if (!taskXml) {
          throw new Error(`Could not export Scheduled Task XML for ${taskName}`);
        }
        expect(taskXml).toContain("<UserId>");
        expect(taskXml.replaceAll("/", "\\").toLowerCase()).toContain(
          launcherPath.replaceAll("/", "\\").toLowerCase(),
        );
        expect(taskXml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
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
        expect(command?.environment?.OPENCLAW_SERVICE_KIND).toBe("gateway");
        // An executed exit 23 need not trigger Scheduler retry. Request recovery only
        // after failure cleanup; IgnoreNew prevents overlap if Scheduler also retries.
        const recoveryMutations: string[] = [];
        await service.start({
          env,
          stdout,
          onMutation: (mutation) => recoveryMutations.push(mutation.mode),
        });
        expect(recoveryMutations).toEqual(["schtasks-start"]);
        const recoveredRun = await proof.waitForExactProbeRun(eventsPath, 1);
        const recoveredPid = recoveredRun.pid;
        const recoveredProcesses = await waitForGatewayTaskSupervisorProcesses({ probe });
        expect(recoveredPid).not.toBe(failedProcesses.childPid);
        expect(recoveredProcesses.supervisorPid).not.toBe(failedProcesses.supervisorPid);
        lifecyclePids.push(recoveredPid);
        const externalStops = [];
        let externalRun = recoveredRun;
        let externalProcesses = recoveredProcesses;
        for (const [stopIndex, method] of ["schtasks /End", "Stop-ScheduledTask"].entries()) {
          if (stopIndex > 0) {
            await service.start({ env, stdout });
            const nextRun = await proof.waitForExactProbeRun(eventsPath, 2);
            const nextProcesses = await waitForGatewayTaskSupervisorProcesses({ probe });
            expect(nextRun.pid).not.toBe(externalRun.pid);
            expect(nextProcesses.supervisorPid).not.toBe(externalProcesses.supervisorPid);
            externalRun = nextRun;
            externalProcesses = nextProcesses;
            lifecyclePids.push(nextRun.pid);
          }
          expectProbeProcessAlive(externalRun.pid);
          expectProbeProcessAlive(externalProcesses.childPid);
          expectGatewayTaskSupervisorProcessAlive(externalProcesses.supervisorPid, probe.probePath);
          expectScheduledTaskProbeOrigin({
            eventsPath,
            probePath: probe.probePath,
            run: externalRun,
            scriptPath,
            readRelatedProcessDiagnostics,
          });
          expect(await canBindLoopbackPort(gatewayPort)).toBe(false);
          await waitForRuntimeStatus(readRuntime, "running", externalRun.pid);
          expect(readTaskPrincipal(taskName).taskState).toBe(TASK_STATE_RUNNING);
          const processCapture = readRelatedProcessDiagnostics([
            probe.probePath,
            eventsPath,
            scriptPath,
          ]);
          expect(processCapture.ok).toBe(true);
          expect(processCapture.truncated).toBe(false);
          expect(processCapture.processes.map((entry) => entry.ProcessId)).toEqual(
            expect.arrayContaining([externalRun.pid, externalProcesses.supervisorPid]),
          );
          const ownedPids = Array.from(
            new Set([
              externalRun.pid,
              externalProcesses.childPid,
              externalProcesses.supervisorPid,
              ...processCapture.processes.flatMap((entry) =>
                entry.ProcessId === undefined ? [] : [entry.ProcessId],
              ),
            ]),
          );
          // External Scheduler stop must own extinction; service.stop() also kills
          // listeners and would conceal a surviving hidden launcher process tree.
          if (method === "schtasks /End") {
            const stopped = await execSchtasks(["/End", "/TN", taskName]);
            expect(stopped.code, stopped.stderr || stopped.stdout).toBe(0);
          } else {
            stopGatewayTaskWithPowerShell(taskName);
          }
          await Promise.all(ownedPids.map((pid) => waitForProcessExit(pid)));
          await waitForLoopbackPortRelease(gatewayPort);
          await waitForRuntimeStatus(readRuntime, "stopped");
          const stoppedTask = readTaskPrincipal(taskName);
          expect(stoppedTask.taskState).toBe(TASK_STATE_READY);
          await clearActivePid(activePidPath, externalRun.pid);
          expect((await execSchtasks(["/Query", "/TN", taskName])).code).toBe(0);
          externalStops.push({
            method,
            gatewayPid: externalRun.pid,
            ...externalProcesses,
            pids: ownedPids,
            taskState: stoppedTask.taskState,
            lastTaskResult: stoppedTask.lastTaskResult,
            portReleaseRebind: true,
          });
        }

        const startMutations: string[] = [];
        await service.start({
          env,
          stdout,
          onMutation: (mutation) => startMutations.push(mutation.mode),
        });
        expect(startMutations).toEqual(["schtasks-start"]);
        const startedRun = await proof.waitForExactProbeRun(eventsPath, 3);
        const startedPid = startedRun.pid;
        const startedProcesses = await waitForGatewayTaskSupervisorProcesses({ probe });
        expect(lifecyclePids).not.toContain(startedPid);
        expectProbeProcessAlive(startedPid);
        expectProbeProcessAlive(startedProcesses.childPid);
        expectGatewayTaskSupervisorProcessAlive(startedProcesses.supervisorPid, probe.probePath);
        expectScheduledTaskProbeOrigin({
          eventsPath,
          probePath: probe.probePath,
          run: startedRun,
          scriptPath,
          readRelatedProcessDiagnostics,
        });
        expect(await canBindLoopbackPort(gatewayPort)).toBe(false);
        await waitForRuntimeStatus(readRuntime, "running", startedPid);
        expect(readTaskPrincipal(taskName).taskState).toBe(TASK_STATE_RUNNING);
        await service.start({ env, stdout });
        await proof.waitForExactProbeRun(eventsPath, 3);

        const restartMutations: string[] = [];
        const restartResult = await service.restart({
          env,
          stdout,
          onMutation: (mutation) => restartMutations.push(mutation.mode),
        });
        expect(restartResult).toEqual({ outcome: "completed" });
        expect(restartMutations).toEqual(["schtasks-end", "schtasks-restart"]);
        const restartedRun = await proof.waitForExactProbeRun(eventsPath, 4);
        const restartedPid = restartedRun.pid;
        const restartedProcesses = await waitForGatewayTaskSupervisorProcesses({ probe });
        lifecyclePids.push(startedPid, restartedPid);
        expect(new Set(lifecyclePids).size).toBe(lifecyclePids.length);
        expectProbeProcessAlive(restartedPid);
        expectProbeProcessAlive(restartedProcesses.childPid);
        expectGatewayTaskSupervisorProcessAlive(restartedProcesses.supervisorPid, probe.probePath);
        expectScheduledTaskProbeOrigin({
          eventsPath,
          probePath: probe.probePath,
          run: restartedRun,
          scriptPath,
          readRelatedProcessDiagnostics,
        });
        await waitForProcessExit(startedPid);
        await waitForGatewayTaskSupervisorExit(startedProcesses);
        await clearActivePid(activePidPath, startedPid);
        expect(await canBindLoopbackPort(gatewayPort)).toBe(false);
        await waitForRuntimeStatus(readRuntime, "running", restartedPid);
        expect(readTaskPrincipal(taskName).taskState).toBe(TASK_STATE_RUNNING);

        // Keep the generated failure policy enabled. A successful hosted exit
        // must settle through the supervisor, without external /End or task edits.
        expect(taskXml).toContain("<Interval>PT1M</Interval>");
        // Exported XML can omit Enabled=true; inspect the registered task's effective value.
        expect(readTaskPrincipal(taskName).enabled).toBe(true);
        const response = await fetch("http://127.0.0.1:" + gatewayPort + "/approved-stop", {
          method: "POST",
          signal: AbortSignal.timeout(WAIT_TIMEOUT_MS),
        });
        expect(response.status).toBe(200);
        const scheduled = await response.json();
        expect(scheduled).toEqual({ outcome: "scheduled", nativeCompleted: false });
        await waitForProcessExit(restartedPid);
        await waitForGatewayTaskSupervisorExit(restartedProcesses);
        await clearActivePid(activePidPath, restartedPid);
        await waitForLoopbackPortRelease(gatewayPort);
        await waitForRuntimeStatus(readRuntime, "stopped");
        const stoppedPrincipal = await waitForCompletedScheduledTaskRun(taskName, 0);
        expect(stoppedPrincipal.enabled).toBe(true);
        const hostedEvents = (await fs.readFile(eventsPath + ".hosted-stop", "utf8"))
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                phase: string;
                pid: number;
                code?: number;
                roots?: number;
                active?: number;
                queued?: number;
                keys?: string[];
              },
          );
        const gatewayEvents = hostedEvents.filter((event) => event.pid === restartedPid);
        const phases = gatewayEvents.map((event) => event.phase);
        expect(phases).not.toContain("request-failed");
        expect(phases.filter((phase) => phase === "caller-live").length).toBeGreaterThan(1);
        expect(phases.filter((phase) => phase !== "caller-live")).toEqual([
          "bounded-environment",
          "operation-settled",
          "response-finished",
          "close",
          "descendant-exit",
          "boot-completion",
          "gateway-exit",
          "process-exit",
        ]);
        expect(gatewayEvents.find((event) => event.phase === "close")).toMatchObject({
          roots: 0,
          active: 0,
          queued: 0,
        });
        expect(gatewayEvents.find((event) => event.phase === "boot-completion")).toMatchObject({
          outcome: "clean_stop",
          reason: "gateway.stop",
        });
        for (const phase of ["descendant-exit", "gateway-exit", "process-exit"]) {
          expect(gatewayEvents.find((event) => event.phase === phase)?.code).toBe(0);
        }
        const supervisorEvents = hostedEvents.filter(
          (event) => event.pid === restartedProcesses.supervisorPid,
        );
        expect(supervisorEvents.filter((event) => event.phase !== "bounded-environment")).toEqual([
          expect.objectContaining({ phase: "supervisor-joined", code: 0 }),
          expect.objectContaining({ phase: "process-exit", code: 0 }),
        ]);
        for (const event of hostedEvents.filter(
          (candidate) => candidate.phase === "bounded-environment",
        )) {
          expect(event.keys?.length).toBeGreaterThan(0);
          expect(
            event.keys?.some((key) =>
              /TOKEN|SECRET|PASSWORD|CREDENTIAL|(^|_)(KEY|KEYS)$|ACTIONS_|GITHUB_|AZURE_|AWS_/u.test(
                key,
              ),
            ),
          ).toBe(false);
        }
        const runEventsBefore = await fs.readFile(eventsPath, "utf8");
        const observationStartedAt = Date.now();
        // PT1M is a behavior under test, not a timeout workaround. Preserve the
        // suite's existing 240s and the workflow step's 5m caps.
        do {
          await sleep(1_000);
          expect(await fs.readFile(eventsPath, "utf8")).toBe(runEventsBefore);
        } while (Date.now() - observationStartedAt < 65_000);
        expect(readTaskPrincipal(taskName)).toEqual(stoppedPrincipal);
        expect(await readTaskXml(taskName)).toBe(taskXml);
        expect(await canBindLoopbackPort(gatewayPort)).toBe(true);
        const remaining = readRelatedProcessDiagnostics([probe.probePath, eventsPath, scriptPath]);
        expect(remaining.ok).toBe(true);
        expect(remaining.processes).toEqual([]);
        const hostedStopProof = {
          boundary: "HTTP approved SystemAgent operation + root/queue + runGatewayLoop",
          response: scheduled,
          gatewayPid: restartedPid,
          ...restartedProcesses,
          events: hostedEvents,
          taskState: stoppedPrincipal.taskState,
          lastTaskResult: stoppedPrincipal.lastTaskResult,
          definitionSha256: createHash("sha256").update(taskXml).digest("hex"),
          definition: sanitizeTaskXml(
            taskXml,
            resolveDiagnosticReplacements({ rootDir, stateDir }),
          ),
          definitionUnchanged: true,
          taskEnabled: stoppedPrincipal.enabled,
          restartInterval: "PT1M",
          noRestartObservedMs: Date.now() - observationStartedAt,
        };

        await service.uninstall({ env, stdout });
        expect((await execSchtasks(["/Query", "/TN", taskName])).code).not.toBe(0);
        await expect(fs.access(scriptPath)).rejects.toThrow();
        await expect(fs.access(launcherPath)).rejects.toThrow();
        expect(await canBindLoopbackPort(gatewayPort)).toBe(true);
        expect(await readTaskDefinitionSnapshot("OpenClaw Gateway")).toEqual(defaultTaskBefore);
        const proofPath = process.env.CI_WINDOWS_SCHTASKS_PROOF_PATH?.trim();
        if (proofPath) {
          const proofHead = process.env.CI_WINDOWS_SCHTASKS_HEAD?.trim();
          if (!proofHead || !/^[0-9a-f]{40}$/u.test(proofHead)) {
            throw new Error(
              "CI_WINDOWS_SCHTASKS_HEAD must identify the exact 40-character checkout SHA",
            );
          }
          return {
            path: proofPath,
            content: `${JSON.stringify(
              {
                result: "pass",
                head: proofHead,
                profile,
                taskName,
                lifecycle: [
                  "install",
                  "failed-run",
                  "recovery-start",
                  "schtasks-end",
                  "external-stop-recovery-start",
                  "powershell-stop-scheduled-task",
                  "start",
                  "restart",
                  "hosted-stop",
                  "uninstall",
                ],
                failedRun: {
                  taskState: installedPrincipal?.taskState,
                  lastTaskResult: installedPrincipal?.lastTaskResult,
                  ...failedProcesses,
                },
                pids: lifecyclePids,
                externalStops,
                gatewayPort,
                portReleaseRebind: true,
                startupFallback: false,
                startupFallbackProof,
                hostedStop: hostedStopProof,
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
          };
        }
        return undefined;
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
        probePath: probe.probePath,
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
    // A passing lifecycle alone is not a completed proof: cleanup must also succeed.
    if (pendingProof) {
      await fs.mkdir(path.dirname(pendingProof.path), { recursive: true });
      await fs.writeFile(pendingProof.path, pendingProof.content, "utf8");
    }
  }, 240_000);
});
