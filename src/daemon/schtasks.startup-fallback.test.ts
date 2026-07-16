// Windows schtasks startup fallback tests cover fallback startup task behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWindowsCmdExePath,
  getWindowsPowerShellExePath,
} from "../infra/windows-install-roots.js";
import { decodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import "./test-helpers/schtasks-base-mocks.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import {
  inspectPortUsage,
  killProcessTree,
  resetSchtasksBaseMocks,
  schtasksResponses,
  withWindowsEnv,
  writeGatewayScript,
} from "./test-helpers/schtasks-fixtures.js";
const timeState = vi.hoisted(() => ({ now: 0 }));
const sleepMock = vi.hoisted(() =>
  vi.fn(async (ms: number) => {
    timeState.now += ms;
  }),
);
const childUnref = vi.hoisted(() => vi.fn());
const spawn = vi.hoisted(() => vi.fn(() => ({ unref: childUnref })));
type SpawnSyncResult = {
  pid: number;
  output: (string | null)[];
  stdout: string;
  stderr: string;
  status: number;
  signal: null;
};
const spawnSync = vi.hoisted(() =>
  vi.fn<(command: string, args?: readonly string[]) => SpawnSyncResult>(() => ({
    pid: 0,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
  })),
);
const findVerifiedGatewayListenerPidsOnPortSync = vi.hoisted(() =>
  vi.fn<(port: number) => number[]>(() => []),
);

vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...actual,
    sleep: (ms: number) => sleepMock(ms),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn,
    spawnSync,
  };
});
vi.mock("../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: (port: number) =>
    findVerifiedGatewayListenerPidsOnPortSync(port),
}));

const {
  installScheduledTask,
  isScheduledTaskInstalled,
  readScheduledTaskRuntime,
  readWindowsStartupFallbackRuntimeForUpdate,
  restartScheduledTask,
  resolveTaskScriptPath,
  stopScheduledTask,
  uninstallScheduledTask,
} = await import("./schtasks.js");

function resolveStartupEntryPath(env: Record<string, string>, extension = "cmd") {
  const taskName = env.OPENCLAW_WINDOWS_TASK_NAME ?? "OpenClaw Gateway";
  return path.join(
    expectDefined(env.APPDATA, "env.APPDATA test invariant"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    `${taskName}.${extension}`,
  );
}

async function writeStartupFallbackEntry(env: Record<string, string>, extension = "cmd") {
  const startupEntryPath = resolveStartupEntryPath(env, extension);
  await fs.mkdir(path.dirname(startupEntryPath), { recursive: true });
  await fs.writeFile(startupEntryPath, "@echo off\r\n", "utf8");
  return startupEntryPath;
}

async function writeNodeScript(env: Record<string, string>, port = "18789") {
  const scriptPath = resolveTaskScriptPath(env);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(
    scriptPath,
    [
      "@echo off",
      `set "OPENCLAW_SERVICE_KIND=node"`,
      `set "OPENCLAW_GATEWAY_PORT=${port}"`,
      `"C:\\bin\\openclaw.cmd" node run --host 127.0.0.1 --port ${port}`,
      "",
    ].join("\r\n"),
    "utf8",
  );
}

const NODE_PROCESS_QUERY =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";

function makeNodeServiceEnv(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    OPENCLAW_SERVICE_KIND: "node",
    OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Node",
  };
}

function makeSpawnSyncResult(overrides: Partial<SpawnSyncResult> = {}): SpawnSyncResult {
  return {
    pid: 0,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...overrides,
  };
}

function mockWindowsNodeHostProcess(processId = 5151): void {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  let processAlive = true;
  spawnSync.mockImplementation((command, args) => {
    if (
      command === getWindowsPowerShellExePath() &&
      Array.isArray(args) &&
      args.includes(NODE_PROCESS_QUERY)
    ) {
      return makeSpawnSyncResult({
        stdout: JSON.stringify(
          processAlive
            ? [
                {
                  ProcessId: processId,
                  CommandLine: "C:\\bin\\openclaw.cmd node run --host 127.0.0.1 --port 18789",
                },
                { ProcessId: 9999, CommandLine: "powershell.exe" },
              ]
            : [{ ProcessId: 9999, CommandLine: "powershell.exe" }],
        ),
      });
    }
    if (command.endsWith("taskkill.exe")) {
      processAlive = false;
    }
    return makeSpawnSyncResult();
  });
}

function expectTaskkillPid(pid: number): void {
  expect(
    spawnSync.mock.calls.some(
      ([command, args]) =>
        command.endsWith("taskkill.exe") &&
        Array.isArray(args) &&
        args.includes("/PID") &&
        args.includes(String(pid)),
    ),
  ).toBe(true);
}

function expectStartupFallbackSpawn() {
  expect(spawn).toHaveBeenCalled();
  const calls = spawn.mock.calls as unknown as Array<
    [string, readonly string[], Record<string, unknown>]
  >;
  const lastCall = calls[calls.length - 1];
  if (!lastCall) {
    throw new Error("expected gateway launch spawn call");
  }
  const [executable, args, options] = lastCall;
  expect(executable).not.toBe("cmd.exe");
  expect(args).toContain("--port");
  expect(args).toContain("18789");
  expect(options.detached).toBe(true);
  expect((options.env as Record<string, string> | undefined)?.OPENCLAW_GATEWAY_PORT).toBe("18789");
  expect(options.stdio).toBe("ignore");
  expect(options.windowsHide).toBe(true);
}

function expectGatewayTermination(pid: number) {
  if (process.platform === "win32") {
    expect(killProcessTree).not.toHaveBeenCalled();
    return;
  }
  expect(killProcessTree).toHaveBeenCalledWith(pid, { graceMs: 300 });
}

function useListenerBackedFallbackOwnership(): void {
  // These orchestration cases exercise the portable listener-owner path.
  // Native Windows process-snapshot ownership has dedicated coverage below.
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
}

function addStartupFallbackMissingResponses(
  extraResponses: Array<{ code: number; stdout: string; stderr: string }> = [],
) {
  schtasksResponses.push(
    { code: 0, stdout: "", stderr: "" },
    { code: 1, stdout: "", stderr: "not found" },
    ...extraResponses,
  );
}

function installGatewayScheduledTask(
  env: Record<string, string>,
  stdout = new PassThrough(),
  port = "18789",
  startupFallbackTakeoverRuntime?: GatewayServiceRuntime,
) {
  return installScheduledTask({
    env,
    stdout,
    programArguments: ["node", "gateway.js", "--port", port],
    environment: { OPENCLAW_GATEWAY_PORT: port },
    startupFallbackTakeoverRuntime,
  });
}

function installNodeScheduledTask(env: Record<string, string>, stdout = new PassThrough()) {
  return installScheduledTask({
    env: {
      ...env,
      OPENCLAW_SERVICE_KIND: "node",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Node",
    },
    stdout,
    programArguments: ["node", "openclaw", "node", "run", "--host", "127.0.0.1", "--port", "18789"],
    environment: {
      OPENCLAW_SERVICE_KIND: "node",
      OPENCLAW_GATEWAY_PORT: "18789",
    },
  });
}

function fastForwardTaskStartWait(): void {
  sleepMock.mockImplementationOnce(async () => {
    timeState.now += 15_000;
  });
}

function addAcceptedRunNeverStartsResponses(): void {
  addStartupFallbackMissingResponses([
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: notYetRunTaskQueryOutput(), stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: notYetRunTaskQueryOutput(), stderr: "" },
  ]);
}

function addSuccessfulScheduledTaskRestartResponses(
  cleanupEvidence: string[] = [runningTaskQueryOutput()],
  launchEvidence = runningTaskQueryOutput(),
): void {
  schtasksResponses.push(
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: launchEvidence, stderr: "" },
  );
  for (const output of cleanupEvidence) {
    schtasksResponses.push(
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: output, stderr: "" },
    );
  }
}

function notYetRunTaskQueryOutput() {
  return [
    "Status: Ready",
    "Last Run Time: 11/30/1999 12:00:00 AM",
    "Last Run Result: 267011",
    "",
  ].join("\r\n");
}

function cleanExitTaskQueryOutput(lastRunTime = "5/2/2026 2:41:39 PM") {
  return ["Status: Ready", `Last Run Time: ${lastRunTime}`, "Last Run Result: 0", ""].join("\r\n");
}

function addAcceptedRunCleanExitResponses(initialOutput = cleanExitTaskQueryOutput()): void {
  addStartupFallbackMissingResponses([
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: initialOutput, stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: cleanExitTaskQueryOutput(), stderr: "" },
  ]);
}

function runningTaskQueryOutput() {
  return [
    "Status: Running",
    "Last Run Time: 4/15/2026 11:42:31 PM",
    "Last Run Result: 267009",
    "",
  ].join("\r\n");
}

beforeEach(() => {
  resetSchtasksBaseMocks();
  // Keep generic lifecycle cases host-independent; Windows ownership cases opt in below.
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  findVerifiedGatewayListenerPidsOnPortSync.mockReset();
  findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
  inspectPortUsage.mockResolvedValue({
    port: 18789,
    status: "free",
    listeners: [],
    hints: [],
  });
  spawn.mockClear();
  spawnSync.mockClear();
  childUnref.mockClear();
  timeState.now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => timeState.now);
  sleepMock.mockReset();
  sleepMock.mockImplementation(async (ms: number) => {
    timeState.now += ms;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Windows startup fallback", () => {
  it("skips task ownership probes when no Startup fallback exists", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      await expect(readWindowsStartupFallbackRuntimeForUpdate(env)).resolves.toBeNull();
      expect(spawnSync).not.toHaveBeenCalled();
    });
  });

  it("falls back to a Startup-folder launcher when schtasks create is denied", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses([
        { code: 5, stdout: "", stderr: "ERROR: Access is denied." },
      ]);

      const stdout = new PassThrough();
      let printed = "";
      stdout.on("data", (chunk) => {
        printed += String(chunk);
      });

      const result = await installGatewayScheduledTask(env, stdout);

      const startupEntryPath = resolveStartupEntryPath(env);
      const startupScript = decodeWindowsLauncherScript({
        buffer: await fs.readFile(startupEntryPath),
      });
      expect(result.scriptPath).toBe(resolveTaskScriptPath(env));
      expect(startupScript).toContain(`start "" /min ${getWindowsCmdExePath()} /d /c`);
      expect(startupScript).toContain("gateway.cmd");
      expectStartupFallbackSpawn();
      expect(childUnref).toHaveBeenCalled();
      expect(printed).toContain("Installed Windows login item");
    });
  });

  it("uses a hidden Startup-folder launcher when requested", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses([
        { code: 5, stdout: "", stderr: "ERROR: Access is denied." },
      ]);

      const result = await installGatewayScheduledTask({
        ...env,
        OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
      });

      const startupEntryPath = resolveStartupEntryPath(env, "vbs");
      const rawStartupScript = await fs.readFile(startupEntryPath);
      const startupScript = decodeWindowsLauncherScript({ buffer: rawStartupScript });
      expect(result.scriptPath).toBe(resolveTaskScriptPath(env));
      // wscript only accepts UTF-16 LE with BOM or ANSI; UTF-16 keeps CJK paths intact.
      expect(rawStartupScript.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
      expect(startupScript).toContain("WScript.Shell");
      expect(startupScript).toContain("gateway.cmd");
      expect(startupScript).toContain(`Run """${result.scriptPath}""", 0, False`);
      expectStartupFallbackSpawn();
    });
  });

  it("removes an old Startup-folder launcher after migrating to a Scheduled Task", async () => {
    useListenerBackedFallbackOwnership();
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      const hiddenStartupEntryPath = await writeStartupFallbackEntry(env, "vbs");
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
      ]);
      addSuccessfulScheduledTaskRestartResponses();

      const stdout = new PassThrough();
      let printed = "";
      stdout.on("data", (chunk) => {
        printed += String(chunk);
      });

      await installGatewayScheduledTask(env, stdout);

      await expect(fs.access(startupEntryPath)).rejects.toThrow();
      await expect(fs.access(hiddenStartupEntryPath)).rejects.toThrow();
      expect(printed).toContain("Installed Scheduled Task");
      expect(printed).toContain("Removed Windows login item");
    });
  });

  it("takes over from a running Startup-folder fallback before removing its launcher", async () => {
    useListenerBackedFallbackOwnership();
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      inspectPortUsage
        .mockResolvedValueOnce({
          port: 18789,
          status: "busy",
          listeners: [{ pid: 4242, command: "node.exe" }],
          hints: [],
        })
        .mockResolvedValue({ port: 18789, status: "free", listeners: [], hints: [] });
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
      ]);
      addSuccessfulScheduledTaskRestartResponses();

      await installGatewayScheduledTask(env);

      expectGatewayTermination(4242);
      await expect(fs.access(startupEntryPath)).rejects.toThrow();
    });
  });

  it("migrates an exact persisted wrapper that owns the replacement port", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      const scriptPath = resolveTaskScriptPath(env);
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(
        scriptPath,
        [
          "@echo off",
          'set "OPENCLAW_GATEWAY_PORT=18789"',
          '"C:\\bin\\openclaw-doppler.exe" gateway --port 18789',
          "",
        ].join("\r\n"),
        "utf8",
      );
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      let processAlive = true;
      spawnSync.mockImplementation((command, args) => {
        if (
          command === getWindowsPowerShellExePath() &&
          Array.isArray(args) &&
          args.includes(NODE_PROCESS_QUERY)
        ) {
          return makeSpawnSyncResult({
            stdout: JSON.stringify(
              processAlive
                ? [
                    {
                      ProcessId: 4242,
                      CommandLine: '"C:\\bin\\openclaw-doppler.exe" gateway --port 18789',
                    },
                    { ProcessId: 9999, CommandLine: "powershell.exe" },
                  ]
                : [{ ProcessId: 9999, CommandLine: "powershell.exe" }],
            ),
          });
        }
        if (command.endsWith("taskkill.exe")) {
          processAlive = false;
        }
        return makeSpawnSyncResult();
      });
      inspectPortUsage
        .mockResolvedValueOnce({
          port: 18789,
          status: "busy",
          listeners: [
            {
              pid: 4242,
              command: "openclaw-doppler.exe",
              commandLine: '"C:\\bin\\openclaw-doppler.exe" gateway --port 18789',
            },
          ],
          hints: [],
        })
        .mockImplementation(async (port) => ({
          port,
          status: "free",
          listeners: [],
          hints: [],
        }));
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
      ]);
      addSuccessfulScheduledTaskRestartResponses();

      await installGatewayScheduledTask(env);

      expectTaskkillPid(4242);
      await expect(fs.access(startupEntryPath)).rejects.toThrow();
    });
  });

  it("refuses migration when listener and process inspection are both unavailable", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      await writeGatewayScript(env);
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      spawnSync.mockImplementation((command, args) =>
        (command === getWindowsPowerShellExePath() &&
          Array.isArray(args) &&
          args.includes(NODE_PROCESS_QUERY)) ||
        command.endsWith("tasklist.exe")
          ? makeSpawnSyncResult({ status: 1 })
          : makeSpawnSyncResult(),
      );
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "free",
        listeners: [],
        hints: [],
      });
      await expect(installGatewayScheduledTask(env)).rejects.toThrow(
        "could not verify the installed process",
      );

      expect(spawnSync.mock.calls.some(([command]) => command.endsWith("taskkill.exe"))).toBe(
        false,
      );
      await expect(fs.access(startupEntryPath)).resolves.toBeUndefined();
    });
  });

  it("refuses takeover when only PID existence can be verified", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      await writeGatewayScript(env);
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      spawnSync.mockImplementation((command, args) => {
        if (
          command === getWindowsPowerShellExePath() &&
          Array.isArray(args) &&
          args.includes(NODE_PROCESS_QUERY)
        ) {
          return makeSpawnSyncResult({ status: 1 });
        }
        if (command.endsWith("tasklist.exe")) {
          return makeSpawnSyncResult({
            stdout: '"node.exe","4242","Console","1","1,024 K"',
          });
        }
        return makeSpawnSyncResult();
      });

      await expect(installGatewayScheduledTask(env)).rejects.toThrow(
        "could not verify the installed process",
      );

      expect(spawnSync.mock.calls.some(([command]) => command.endsWith("taskkill.exe"))).toBe(
        false,
      );
      await expect(fs.access(startupEntryPath)).resolves.toBeUndefined();
    });
  });

  it("accepts a process-exit race without forcing a stale PID", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      await writeGatewayScript(env);
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      let processAlive = true;
      spawnSync.mockImplementation((command, args) => {
        if (
          command === getWindowsPowerShellExePath() &&
          Array.isArray(args) &&
          args.includes(NODE_PROCESS_QUERY)
        ) {
          return makeSpawnSyncResult({
            stdout: JSON.stringify(
              processAlive
                ? [
                    {
                      ProcessId: 4242,
                      CommandLine:
                        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789',
                    },
                    { ProcessId: 9999, CommandLine: "powershell.exe" },
                  ]
                : [{ ProcessId: 9999, CommandLine: "powershell.exe" }],
            ),
          });
        }
        if (command.endsWith("taskkill.exe")) {
          processAlive = false;
          return makeSpawnSyncResult({ status: 128 });
        }
        return makeSpawnSyncResult();
      });
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
      ]);
      addSuccessfulScheduledTaskRestartResponses();

      await installGatewayScheduledTask(env);

      const forcedCalls = spawnSync.mock.calls.filter(
        ([command, args]) =>
          command.endsWith("taskkill.exe") && Array.isArray(args) && args.includes("/F"),
      );
      expect(forcedCalls).toHaveLength(0);
      await expect(fs.access(startupEntryPath)).rejects.toThrow();
    });
  });

  it("refuses migration when the busy port owner is not a verified gateway", async () => {
    useListenerBackedFallbackOwnership();
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 4242, command: "other.exe" }],
        hints: [],
      });
      await expect(installGatewayScheduledTask(env)).rejects.toThrow(
        "listener is not a verified gateway process",
      );

      expect(killProcessTree).not.toHaveBeenCalled();
      await expect(fs.access(startupEntryPath)).resolves.toBeUndefined();
    });
  });

  it("refuses migration when another gateway owns the fallback port", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      await writeGatewayScript(env);
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      spawnSync.mockImplementation((command, args) => {
        if (
          command === getWindowsPowerShellExePath() &&
          Array.isArray(args) &&
          args.includes(NODE_PROCESS_QUERY)
        ) {
          return makeSpawnSyncResult({
            stdout: JSON.stringify([
              {
                ProcessId: 3131,
                CommandLine: "C:\\manual\\openclaw.cmd gateway --port 18789",
              },
              {
                ProcessId: 4242,
                CommandLine:
                  '"C:\\Program Files\\nodejs\\node.exe" "C:\\other\\dist\\index.js" gateway --port 18789',
              },
              { ProcessId: 9999, CommandLine: "powershell.exe" },
            ]),
          });
        }
        return makeSpawnSyncResult();
      });
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [
          {
            pid: 4242,
            command: "node.exe",
            commandLine:
              '"C:\\Program Files\\nodejs\\node.exe" "C:\\other\\dist\\index.js" gateway --port 18789',
          },
        ],
        hints: [],
      });

      await expect(installGatewayScheduledTask(env)).rejects.toThrow(
        "gateway listener on port 18789 does not match the persisted command",
      );

      expect(killProcessTree).not.toHaveBeenCalled();
      await expect(fs.access(startupEntryPath)).resolves.toBeUndefined();
    });
  });

  it("relaunches the verified fallback when Scheduled Task takeover fails", async () => {
    useListenerBackedFallbackOwnership();
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      await writeGatewayScript(env);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      inspectPortUsage.mockImplementation(async (port) => {
        schtasksResponses.length = 0;
        schtasksResponses.push({ code: 1, stdout: "", stderr: "restart denied" });
        return { port, status: "free", listeners: [], hints: [] };
      });
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
      ]);

      await expect(installGatewayScheduledTask(env)).rejects.toThrow(
        "schtasks run failed: restart denied",
      );

      expectGatewayTermination(4242);
      expectStartupFallbackSpawn();
      await expect(fs.access(startupEntryPath)).resolves.toBeUndefined();
    });
  });

  it("probes the old fallback port before replacing a drifted task script", async () => {
    useListenerBackedFallbackOwnership();
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      await writeGatewayScript(env, 18789);
      env.OPENCLAW_GATEWAY_PORT = "19433";
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: port === 18789 ? "busy" : "free",
        listeners:
          port === 18789
            ? [
                {
                  pid: 4242,
                  command: "node.exe",
                  commandLine: 'node "C:\\openclaw\\dist\\index.js" gateway --port 18789',
                },
              ]
            : [],
        hints: [],
      }));
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
      ]);
      addSuccessfulScheduledTaskRestartResponses();

      await installGatewayScheduledTask(env, new PassThrough(), "19433");

      expect(inspectPortUsage).toHaveBeenCalledWith(18789);
      expectGatewayTermination(4242);
      await expect(fs.access(startupEntryPath)).rejects.toThrow();
    });
  });

  it("does not inspect the replaced script as the old fallback", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      await writeGatewayScript(env, 18789);
      env.OPENCLAW_GATEWAY_PORT = "19433";
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      let processQueries = 0;
      spawnSync.mockImplementation((command, args) => {
        if (
          command === getWindowsPowerShellExePath() &&
          Array.isArray(args) &&
          args.includes(NODE_PROCESS_QUERY)
        ) {
          processQueries += 1;
          if (processQueries > 5) {
            return makeSpawnSyncResult({ status: 1 });
          }
          return makeSpawnSyncResult({
            stdout: JSON.stringify(
              processQueries === 1
                ? [
                    {
                      ProcessId: 4242,
                      CommandLine:
                        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789',
                    },
                    { ProcessId: 9999, CommandLine: "powershell.exe" },
                  ]
                : [{ ProcessId: 9999, CommandLine: "powershell.exe" }],
            ),
          });
        }
        return makeSpawnSyncResult();
      });
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: "free",
        listeners: [],
        hints: [],
      }));
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
      ]);
      addSuccessfulScheduledTaskRestartResponses();

      await installGatewayScheduledTask(env, new PassThrough(), "19433");

      expect(processQueries).toBe(5);
      await expect(fs.access(startupEntryPath)).rejects.toThrow();
    });
  });

  it("does not take over when another process owns the replacement port", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      await writeGatewayScript(env, 18789);
      const scriptPath = resolveTaskScriptPath(env);
      const scriptBefore = decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) });
      env.OPENCLAW_GATEWAY_PORT = "19433";
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      spawnSync.mockImplementation((command, args) => {
        if (
          command === getWindowsPowerShellExePath() &&
          Array.isArray(args) &&
          args.includes(NODE_PROCESS_QUERY)
        ) {
          return makeSpawnSyncResult({
            stdout: JSON.stringify([
              {
                ProcessId: 4242,
                CommandLine:
                  '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789',
              },
              {
                ProcessId: 5252,
                CommandLine:
                  '"C:\\Program Files\\nodejs\\node.exe" "C:\\other\\dist\\index.js" gateway --port 19433',
              },
              { ProcessId: 9999, CommandLine: "powershell.exe" },
            ]),
          });
        }
        return makeSpawnSyncResult();
      });
      inspectPortUsage.mockResolvedValue({
        port: 19433,
        status: "busy",
        listeners: [
          {
            pid: 5252,
            command: "node.exe",
            commandLine:
              '"C:\\Program Files\\nodejs\\node.exe" "C:\\other\\dist\\index.js" gateway --port 19433',
          },
        ],
        hints: [],
      });
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
      ]);
      const pendingSchtasksResponses = schtasksResponses.length;

      await expect(installGatewayScheduledTask(env, new PassThrough(), "19433")).rejects.toThrow(
        "replacement gateway port 19433 is occupied by an unverified process",
      );

      const oldPidKills = spawnSync.mock.calls.filter(
        ([command, args]) =>
          command.endsWith("taskkill.exe") &&
          Array.isArray(args) &&
          args.includes("/PID") &&
          args.includes("4242"),
      );
      expect(oldPidKills).toHaveLength(0);
      expect(schtasksResponses).toHaveLength(pendingSchtasksResponses);
      expect(decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) })).toBe(
        scriptBefore,
      );
      await expect(fs.access(startupEntryPath)).resolves.toBeUndefined();
    });
  });

  it("preflights the replacement port when the fallback is stopped", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      await writeGatewayScript(env, 18789);
      const scriptPath = resolveTaskScriptPath(env);
      const scriptBefore = decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) });
      env.OPENCLAW_GATEWAY_PORT = "19433";
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      spawnSync.mockImplementation((command, args) =>
        command === getWindowsPowerShellExePath() &&
        Array.isArray(args) &&
        args.includes(NODE_PROCESS_QUERY)
          ? makeSpawnSyncResult({
              stdout: JSON.stringify([
                {
                  ProcessId: 5252,
                  CommandLine:
                    '"C:\\Program Files\\nodejs\\node.exe" "C:\\other\\dist\\index.js" gateway --port 19433',
                },
                { ProcessId: 9999, CommandLine: "powershell.exe" },
              ]),
            })
          : makeSpawnSyncResult(),
      );
      inspectPortUsage.mockImplementation(async (port) =>
        port === 19433
          ? {
              port,
              status: "busy",
              listeners: [
                {
                  pid: 5252,
                  command: "node.exe",
                  commandLine:
                    '"C:\\Program Files\\nodejs\\node.exe" "C:\\other\\dist\\index.js" gateway --port 19433',
                },
              ],
              hints: [],
            }
          : { port, status: "free", listeners: [], hints: [] },
      );

      await expect(installGatewayScheduledTask(env, new PassThrough(), "19433")).rejects.toThrow(
        "replacement gateway port 19433 is occupied by an unverified process",
      );

      expect(decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) })).toBe(
        scriptBefore,
      );
      await expect(fs.access(startupEntryPath)).resolves.toBeUndefined();
    });
  });

  it("refuses takeover when the replacement port probe is inconclusive", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      await writeGatewayScript(env, 18789);
      const scriptPath = resolveTaskScriptPath(env);
      const scriptBefore = decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) });
      env.OPENCLAW_GATEWAY_PORT = "19433";
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      spawnSync.mockImplementation((command, args) =>
        command === getWindowsPowerShellExePath() &&
        Array.isArray(args) &&
        args.includes(NODE_PROCESS_QUERY)
          ? makeSpawnSyncResult({
              stdout: JSON.stringify([
                {
                  ProcessId: 4242,
                  CommandLine:
                    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789',
                },
                { ProcessId: 9999, CommandLine: "powershell.exe" },
              ]),
            })
          : makeSpawnSyncResult(),
      );
      inspectPortUsage.mockResolvedValue({
        port: 19433,
        status: "unknown",
        listeners: [],
        hints: [],
      });

      await expect(installGatewayScheduledTask(env, new PassThrough(), "19433")).rejects.toThrow(
        "Could not verify replacement gateway port 19433",
      );

      expect(decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) })).toBe(
        scriptBefore,
      );
      await expect(fs.access(startupEntryPath)).resolves.toBeUndefined();
    });
  });

  it("keeps a direct replacement fallback when the takeover task does not start", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      await writeGatewayScript(env);
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      let processAlive = true;
      spawnSync.mockImplementation((command, args) => {
        if (
          command === getWindowsPowerShellExePath() &&
          Array.isArray(args) &&
          args.includes(NODE_PROCESS_QUERY)
        ) {
          return makeSpawnSyncResult({
            stdout: JSON.stringify(
              processAlive
                ? [
                    {
                      ProcessId: 4242,
                      CommandLine:
                        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789',
                    },
                    { ProcessId: 9999, CommandLine: "powershell.exe" },
                  ]
                : [{ ProcessId: 9999, CommandLine: "powershell.exe" }],
            ),
          });
        }
        if (command.endsWith("taskkill.exe")) {
          processAlive = false;
        }
        return makeSpawnSyncResult();
      });
      inspectPortUsage
        .mockResolvedValueOnce({
          port: 18789,
          status: "busy",
          listeners: [{ pid: 4242, command: "node.exe" }],
          hints: [],
        })
        .mockResolvedValue({ port: 18789, status: "free", listeners: [], hints: [] });
      fastForwardTaskStartWait();
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
      ]);
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: notYetRunTaskQueryOutput(), stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: notYetRunTaskQueryOutput(), stderr: "" },
      );

      await installGatewayScheduledTask(env);

      expect(spawn).toHaveBeenCalledTimes(1);
      await expect(fs.access(startupEntryPath)).resolves.toBeUndefined();
    });
  });

  it("relaunches the fallback when replacement running evidence never appears", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      await writeGatewayScript(env);
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      let processQueries = 0;
      spawnSync.mockImplementation((command, args) => {
        if (
          command === getWindowsPowerShellExePath() &&
          Array.isArray(args) &&
          args.includes(NODE_PROCESS_QUERY)
        ) {
          processQueries += 1;
          return makeSpawnSyncResult({
            stdout: JSON.stringify(
              processQueries < 3
                ? [
                    {
                      ProcessId: 4242,
                      CommandLine:
                        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789',
                    },
                    { ProcessId: 9999, CommandLine: "powershell.exe" },
                  ]
                : [{ ProcessId: 9999, CommandLine: "powershell.exe" }],
            ),
          });
        }
        return makeSpawnSyncResult();
      });
      fastForwardTaskStartWait();
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
      ]);
      addSuccessfulScheduledTaskRestartResponses(
        [notYetRunTaskQueryOutput()],
        notYetRunTaskQueryOutput(),
      );

      await expect(installGatewayScheduledTask(env)).rejects.toThrow(
        "Replacement Windows Scheduled Task did not produce running evidence",
      );

      expectStartupFallbackSpawn();
      expect(processQueries).toBeGreaterThanOrEqual(4);
      await expect(fs.access(startupEntryPath)).resolves.toBeUndefined();
    });
  });

  it("re-probes the captured fallback port after a transient config reload", async () => {
    useListenerBackedFallbackOwnership();
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      await writeGatewayScript(env, 18789);
      env.OPENCLAW_GATEWAY_PORT = "19433";
      let oldPortProbes = 0;
      inspectPortUsage.mockImplementation(async (port) => {
        if (port !== 18789) {
          return { port, status: "free", listeners: [], hints: [] };
        }
        oldPortProbes += 1;
        return oldPortProbes < 3
          ? { port, status: "free", listeners: [], hints: [] }
          : {
              port,
              status: "busy",
              listeners: [
                {
                  pid: 4242,
                  command: "node.exe",
                  commandLine: 'node "C:\\openclaw\\dist\\index.js" gateway --port 18789',
                },
              ],
              hints: [],
            };
      });
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: runningTaskQueryOutput(), stderr: "" },
      ]);
      addSuccessfulScheduledTaskRestartResponses();

      await installGatewayScheduledTask(env, new PassThrough(), "19433", {
        status: "running",
        pid: 4242,
      });

      expect(oldPortProbes).toBeGreaterThanOrEqual(3);
      expectGatewayTermination(4242);
      await expect(fs.access(startupEntryPath)).rejects.toThrow();
    });
  });

  it("keeps the fallback when a previously running process cannot be proven gone", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      await writeGatewayScript(env);
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "free",
        listeners: [],
        hints: [],
      });

      await expect(
        installGatewayScheduledTask(env, new PassThrough(), "18789", { status: "running" }),
      ).rejects.toThrow("previously running Windows login item has not exited cleanly");
      await expect(fs.access(startupEntryPath)).resolves.toBeUndefined();
    });
  });

  it("removes an old Startup-folder launcher after Scheduled Task restart is proven", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      const hiddenStartupEntryPath = await writeStartupFallbackEntry(env, "vbs");
      await writeGatewayScript(env);
      addSuccessfulScheduledTaskRestartResponses();

      await restartScheduledTask({ env, stdout: new PassThrough() });

      await expect(fs.access(startupEntryPath)).rejects.toThrow();
      await expect(fs.access(hiddenStartupEntryPath)).rejects.toThrow();
    });
  });

  it("waits for running evidence before removing a Startup-folder launcher", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      await writeGatewayScript(env);
      addSuccessfulScheduledTaskRestartResponses([
        notYetRunTaskQueryOutput(),
        runningTaskQueryOutput(),
      ]);

      await restartScheduledTask({ env, stdout: new PassThrough() });

      expect(sleepMock).toHaveBeenCalledWith(250);
      await expect(fs.access(startupEntryPath)).rejects.toThrow();
    });
  });

  it("accepts a clean hidden-launcher exit when its gateway listener is running", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const hiddenEnv = { ...env, OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" };
      const startupEntryPath = await writeStartupFallbackEntry(hiddenEnv);
      await writeGatewayScript(hiddenEnv);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      addSuccessfulScheduledTaskRestartResponses(
        [cleanExitTaskQueryOutput()],
        cleanExitTaskQueryOutput(),
      );

      await restartScheduledTask({ env: hiddenEnv, stdout: new PassThrough() });

      await expect(fs.access(startupEntryPath)).rejects.toThrow();
    });
  });

  it("does not accept a clean task exit for the foreground launcher", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const startupEntryPath = await writeStartupFallbackEntry(env);
      await writeGatewayScript(env);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      fastForwardTaskStartWait();
      addSuccessfulScheduledTaskRestartResponses(
        [cleanExitTaskQueryOutput()],
        cleanExitTaskQueryOutput(),
      );

      await restartScheduledTask({ env, stdout: new PassThrough() });

      await expect(fs.access(startupEntryPath)).resolves.toBeUndefined();
    });
  });

  it("keeps the Startup launcher when a clean task exit needs the direct fallback", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const hiddenEnv = { ...env, OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" };
      const startupEntryPath = await writeStartupFallbackEntry(hiddenEnv);
      await writeGatewayScript(hiddenEnv);
      fastForwardTaskStartWait();
      findVerifiedGatewayListenerPidsOnPortSync.mockImplementation(() =>
        spawn.mock.calls.length > 0 ? [4242] : [],
      );
      addSuccessfulScheduledTaskRestartResponses(
        [cleanExitTaskQueryOutput(), cleanExitTaskQueryOutput()],
        cleanExitTaskQueryOutput(),
      );

      await restartScheduledTask({ env: hiddenEnv, stdout: new PassThrough() });

      expect(spawn).toHaveBeenCalled();
      await expect(fs.access(startupEntryPath)).resolves.toBeUndefined();
    });
  });

  it("falls back to a Startup-folder launcher when schtasks create returns Spanish access denied", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses([
        { code: 1, stdout: "", stderr: "Error: Acceso denegado." },
      ]);

      await installGatewayScheduledTask(env);

      await expect(fs.access(resolveStartupEntryPath(env))).resolves.toBeUndefined();
      expectStartupFallbackSpawn();
    });
  });

  it("falls back to a Startup-folder launcher when schtasks create returns localized access denied", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses([{ code: 1, stdout: "", stderr: "错误: 拒绝访问。" }]);

      await installGatewayScheduledTask(env);

      await expect(fs.access(resolveStartupEntryPath(env))).resolves.toBeUndefined();
      expectStartupFallbackSpawn();
    });
  });

  it("falls back to a Startup-folder launcher when schtasks create hangs", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses([
        { code: 124, stdout: "", stderr: "schtasks timed out after 15000ms" },
      ]);

      await installGatewayScheduledTask(env);

      await expect(fs.access(resolveStartupEntryPath(env))).resolves.toBeUndefined();
      expectStartupFallbackSpawn();
    });
  });

  it("falls back to a Startup-folder launcher when schtasks availability is slow", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      schtasksResponses.push(
        { code: 124, stdout: "", stderr: "schtasks produced no output for 30000ms" },
        { code: 124, stdout: "", stderr: "schtasks produced no output for 30000ms" },
        { code: 124, stdout: "", stderr: "schtasks produced no output for 30000ms" },
      );

      await installGatewayScheduledTask(env);

      await expect(fs.access(resolveStartupEntryPath(env))).resolves.toBeUndefined();
      expectStartupFallbackSpawn();
    });
  });

  it("launches through the Startup-style launcher when schtasks /Run is accepted but never starts the task", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      fastForwardTaskStartWait();
      addAcceptedRunNeverStartsResponses();

      await installGatewayScheduledTask(env);

      expectStartupFallbackSpawn();
    });
  });

  it("falls back after an accepted task exits cleanly without launch evidence", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      fastForwardTaskStartWait();
      addAcceptedRunCleanExitResponses();

      await installGatewayScheduledTask(env);

      expectStartupFallbackSpawn();
    });
  });

  it("falls back when Task Scheduler records a fresh clean exit without launch evidence", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      fastForwardTaskStartWait();
      addAcceptedRunCleanExitResponses(cleanExitTaskQueryOutput("5/2/2026 2:40:00 PM"));

      await installGatewayScheduledTask(env);

      expectStartupFallbackSpawn();
    });
  });

  it("keeps polling when an accepted task transitions from not-yet-run to clean exit", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      fastForwardTaskStartWait();
      addAcceptedRunCleanExitResponses(notYetRunTaskQueryOutput());

      await installGatewayScheduledTask(env);

      expectStartupFallbackSpawn();
    });
  });

  it("does not fall back when a listener appears after the clean task exit", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      fastForwardTaskStartWait();
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockReturnValue([4242]);
      addAcceptedRunCleanExitResponses();

      await installGatewayScheduledTask(env);

      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it("does not treat a gateway listener as node Scheduled Task launch evidence", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      fastForwardTaskStartWait();
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      addAcceptedRunNeverStartsResponses();

      await installNodeScheduledTask(env);

      expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
      expectStartupFallbackSpawn();
    });
  });

  it("does not relaunch when the node Scheduled Task process is already running", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      fastForwardTaskStartWait();
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      spawnSync.mockImplementation((command, args) => {
        if (
          command === getWindowsPowerShellExePath() &&
          Array.isArray(args) &&
          args.includes(
            "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
          )
        ) {
          return {
            pid: 0,
            output: [null, "", ""],
            stdout: JSON.stringify([
              {
                ProcessId: 5151,
                CommandLine: "node openclaw node run --host 127.0.0.1 --port 18789",
              },
            ]),
            stderr: "",
            status: 0,
            signal: null,
          };
        }
        return {
          pid: 0,
          output: [null, "", ""],
          stdout: "",
          stderr: "",
          status: 0,
          signal: null,
        };
      });
      addAcceptedRunNeverStartsResponses();

      await installNodeScheduledTask(env);

      expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it("does not relaunch the task script when schtasks shows startup progress after /Run", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: notYetRunTaskQueryOutput(), stderr: "" },
        {
          code: 0,
          stdout: [
            "Status: Ready",
            "Last Run Time: 4/15/2026 11:42:31 PM",
            "Last Run Result: 267011",
            "",
          ].join("\r\n"),
          stderr: "",
        },
      ]);

      await installGatewayScheduledTask(env);

      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it("does not relaunch the task script when the scheduled task process is already starting", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const taskScriptPath = resolveTaskScriptPath(env);
      fastForwardTaskStartWait();
      spawnSync.mockImplementation((command, args) => {
        if (
          command === getWindowsPowerShellExePath() &&
          Array.isArray(args) &&
          args.includes(
            "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
          )
        ) {
          return {
            pid: 0,
            output: [null, "", ""],
            stdout: JSON.stringify([
              {
                ProcessId: 4242,
                CommandLine: `cmd.exe /d /s /c "${taskScriptPath}"`,
              },
            ]),
            stderr: "",
            status: 0,
            signal: null,
          };
        }
        return {
          pid: 0,
          output: [null, "", ""],
          stdout: "",
          stderr: "",
          status: 0,
          signal: null,
        };
      });
      addAcceptedRunNeverStartsResponses();

      await installGatewayScheduledTask(env);

      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it("reports a fallback-launched gateway as running even when schtasks still says not-yet-run", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      await writeGatewayScript(env);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: notYetRunTaskQueryOutput(), stderr: "" },
      );

      const runtime = await readScheduledTaskRuntime(env);
      expect(runtime.status).toBe("running");
      expect(runtime.pid).toBe(4242);
      expect(runtime.state).toBe("Ready");
      expect(runtime.lastRunResult).toBe("267011");
    });
  });

  it("reports the exact scheduled gateway process while its listener is still starting", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      await writeGatewayScript(env);
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: notYetRunTaskQueryOutput(), stderr: "" },
      );
      spawnSync.mockImplementation((command, args) => {
        if (
          command === getWindowsPowerShellExePath() &&
          Array.isArray(args) &&
          args.includes(NODE_PROCESS_QUERY)
        ) {
          return makeSpawnSyncResult({
            stdout: JSON.stringify([
              {
                ProcessId: 4242,
                CommandLine:
                  '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789',
              },
            ]),
          });
        }
        return makeSpawnSyncResult();
      });

      const runtime = await readScheduledTaskRuntime(env);
      expect(runtime.status).toBe("running");
      expect(runtime.pid).toBe(4242);
      expect(runtime.detail).toContain("Gateway process detected");
      expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
      expect(inspectPortUsage).not.toHaveBeenCalled();
    });
  });

  it("does not report a node task as running from a gateway listener", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      env.OPENCLAW_SERVICE_KIND = "node";
      env.OPENCLAW_WINDOWS_TASK_NAME = "OpenClaw Node";
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: notYetRunTaskQueryOutput(), stderr: "" },
      );

      const runtime = await readScheduledTaskRuntime(env);
      expect(runtime.status).toBe("stopped");
      expect(runtime.state).toBe("Ready");
      expect(runtime.lastRunResult).toBe("267011");
      expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
    });
  });

  it("reports a registered node task as running from the matching node host process", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const nodeEnv = {
        ...env,
        OPENCLAW_SERVICE_KIND: "node",
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Node",
      };
      await writeNodeScript(nodeEnv);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: notYetRunTaskQueryOutput(), stderr: "" },
      );
      spawnSync.mockImplementation((command, args) => {
        if (
          command === getWindowsPowerShellExePath() &&
          Array.isArray(args) &&
          args.includes(
            "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
          )
        ) {
          return {
            pid: 0,
            output: [null, "", ""],
            stdout: JSON.stringify([
              {
                ProcessId: 4242,
                CommandLine: "C:\\manual\\openclaw.cmd node run --host 127.0.0.1 --port 18789",
              },
              {
                ProcessId: 5151,
                CommandLine: "C:\\bin\\openclaw.cmd node run --host 127.0.0.1 --port 18789",
              },
            ]),
            stderr: "",
            status: 0,
            signal: null,
          };
        }
        return {
          pid: 0,
          output: [null, "", ""],
          stdout: "",
          stderr: "",
          status: 0,
          signal: null,
        };
      });

      const runtime = await readScheduledTaskRuntime(nodeEnv);
      expect(runtime.status).toBe("running");
      expect(runtime.pid).toBe(5151);
      expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
      expect(inspectPortUsage).not.toHaveBeenCalled();
    });
  });

  it("does not trust an unverified busy port when schtasks still says not-yet-run", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      await writeGatewayScript(env);
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 4242, command: "node.exe" }],
        hints: [],
      });
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: notYetRunTaskQueryOutput(), stderr: "" },
      );

      const runtime = await readScheduledTaskRuntime(env);
      expect(runtime.status).toBe("stopped");
      expect(runtime.state).toBe("Ready");
      expect(runtime.lastRunResult).toBe("267011");
    });
  });

  it("treats an installed Startup-folder launcher as loaded", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses();
      await writeStartupFallbackEntry(env);

      await expect(isScheduledTaskInstalled({ env })).resolves.toBe(true);
    });
  });

  it("keeps legacy Startup-folder cmd entries visible after hidden launcher opt-in", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses();
      await writeStartupFallbackEntry(env);

      await expect(
        isScheduledTaskInstalled({
          env: {
            ...env,
            OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
          },
        }),
      ).resolves.toBe(true);
    });
  });

  it("removes legacy Startup-folder cmd entries after hidden launcher opt-in", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      schtasksResponses.push({ code: 0, stdout: "", stderr: "" });
      const startupEntryPath = await writeStartupFallbackEntry(env);
      const stdout = new PassThrough();

      await uninstallScheduledTask({
        env: {
          ...env,
          OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
        },
        stdout,
      });

      await expect(fs.access(startupEntryPath)).rejects.toThrow();
    });
  });

  it("removes hidden Startup-folder entries when the caller env lacks the marker", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      schtasksResponses.push({ code: 0, stdout: "", stderr: "" });
      const startupEntryPath = resolveStartupEntryPath(env, "vbs");
      await fs.mkdir(path.dirname(startupEntryPath), { recursive: true });
      await fs.writeFile(startupEntryPath, 'CreateObject("WScript.Shell")\n', "utf8");

      await uninstallScheduledTask({
        env,
        stdout: new PassThrough(),
      });

      await expect(fs.access(startupEntryPath)).rejects.toThrow();
    });
  });

  it("reports runtime from a verified gateway listener when using the Startup fallback", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses();
      await writeStartupFallbackEntry(env);
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [
          {
            pid: 4242,
            command: "node.exe",
            commandLine: 'node "C:\\openclaw\\dist\\index.js" gateway --port 18789',
          },
        ],
        hints: [],
      });

      const runtime = await readScheduledTaskRuntime(env);
      expect(runtime.status).toBe("running");
      expect(runtime.pid).toBe(4242);
    });
  });

  it("does not report a node Startup fallback as running from the gateway listener", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const nodeEnv = makeNodeServiceEnv(env);
      addStartupFallbackMissingResponses();
      await writeStartupFallbackEntry(nodeEnv);
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 4242, command: "node.exe" }],
        hints: [],
      });

      const runtime = await readScheduledTaskRuntime(nodeEnv);
      expect(runtime.status).not.toBe("running");
      expect(runtime.pid).toBeUndefined();
      expect(inspectPortUsage).not.toHaveBeenCalled();
    });
  });

  it("does not kill the gateway listener when stopping a node Startup fallback", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const nodeEnv = makeNodeServiceEnv(env);
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      addStartupFallbackMissingResponses();
      await writeStartupFallbackEntry(nodeEnv);
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [
          {
            pid: 5151,
            command: "node.exe",
            commandLine: 'node "C:\\openclaw\\dist\\index.js" gateway --port 18789',
          },
        ],
        hints: [],
      });

      await stopScheduledTask({ env: nodeEnv, stdout: new PassThrough() });

      expect(inspectPortUsage).not.toHaveBeenCalled();
      expect(killProcessTree).not.toHaveBeenCalled();
    });
  });

  it("refuses to stop a Startup fallback with an unverified busy port owner", async () => {
    useListenerBackedFallbackOwnership();
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses();
      await writeStartupFallbackEntry(env);
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 5151, command: "other.exe" }],
        hints: [],
      });

      await expect(stopScheduledTask({ env, stdout: new PassThrough() })).rejects.toThrow(
        "not a verified gateway process",
      );
      expect(killProcessTree).not.toHaveBeenCalled();
    });
  });

  it("stops a node Startup fallback by terminating the matching node host process", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const nodeEnv = makeNodeServiceEnv(env);
      addStartupFallbackMissingResponses();
      await writeStartupFallbackEntry(nodeEnv);
      await writeNodeScript(nodeEnv);
      mockWindowsNodeHostProcess();

      await stopScheduledTask({ env: nodeEnv, stdout: new PassThrough() });

      expect(inspectPortUsage).not.toHaveBeenCalled();
      expectTaskkillPid(5151);
    });
  });

  it("cleans up a stale node Startup fallback when a node Scheduled Task is registered", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const nodeEnv = makeNodeServiceEnv(env);
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
      );
      await writeStartupFallbackEntry(nodeEnv);
      await writeNodeScript(nodeEnv);
      mockWindowsNodeHostProcess();

      await stopScheduledTask({ env: nodeEnv, stdout: new PassThrough() });

      expect(inspectPortUsage).not.toHaveBeenCalled();
      expectTaskkillPid(5151);
    });
  });

  it("stops a registered node Scheduled Task by terminating the matching node host process", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const nodeEnv = makeNodeServiceEnv(env);
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
      );
      await writeNodeScript(nodeEnv);
      mockWindowsNodeHostProcess();

      await stopScheduledTask({ env: nodeEnv, stdout: new PassThrough() });

      expect(inspectPortUsage).not.toHaveBeenCalled();
      expectTaskkillPid(5151);
    });
  });

  it("restarts the Startup fallback by killing the current pid and relaunching the entry", async () => {
    useListenerBackedFallbackOwnership();
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not found" },
      ]);
      await writeGatewayScript(env);
      await writeStartupFallbackEntry(env);
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [
          {
            pid: 5151,
            command: "node.exe",
            commandLine: 'node "C:\\openclaw\\dist\\index.js" gateway --port 18789',
          },
        ],
        hints: [],
      });

      const stdout = new PassThrough();
      await expect(restartScheduledTask({ env, stdout })).resolves.toEqual({
        outcome: "completed",
      });
      expectGatewayTermination(5151);
      expectStartupFallbackSpawn();
    });
  });

  it("refuses to restart a Startup fallback with an unverified busy port owner", async () => {
    useListenerBackedFallbackOwnership();
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses();
      await writeStartupFallbackEntry(env);
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 5151, command: "other.exe" }],
        hints: [],
      });

      await expect(restartScheduledTask({ env, stdout: new PassThrough() })).rejects.toThrow(
        "not a verified gateway process",
      );
      expect(killProcessTree).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it("relaunches the task script when restart sees a scheduled-task run no-op", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      await writeGatewayScript(env);
      sleepMock.mockImplementationOnce(async () => {
        timeState.now += 15_000;
      });
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "free",
        listeners: [],
        hints: [],
      });
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: notYetRunTaskQueryOutput(), stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: notYetRunTaskQueryOutput(), stderr: "" },
      );

      await expect(restartScheduledTask({ env, stdout: new PassThrough() })).resolves.toEqual({
        outcome: "completed",
      });

      expectStartupFallbackSpawn();
    });
  });

  it("kills the Startup fallback runtime even when the CLI env omits the gateway port", async () => {
    useListenerBackedFallbackOwnership();
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      schtasksResponses.push({ code: 0, stdout: "", stderr: "" });
      await writeGatewayScript(env);
      await writeStartupFallbackEntry(env);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([5151]);
      inspectPortUsage
        .mockResolvedValueOnce({
          port: 18789,
          status: "busy",
          listeners: [{ pid: 5151, command: "node.exe" }],
          hints: [],
        })
        .mockResolvedValueOnce({
          port: 18789,
          status: "busy",
          listeners: [{ pid: 5151, command: "node.exe" }],
          hints: [],
        })
        .mockResolvedValueOnce({
          port: 18789,
          status: "free",
          listeners: [],
          hints: [],
        });

      const stdout = new PassThrough();
      const envWithoutPort = { ...env };
      delete envWithoutPort.OPENCLAW_GATEWAY_PORT;
      await stopScheduledTask({ env: envWithoutPort, stdout });

      expectGatewayTermination(5151);
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
