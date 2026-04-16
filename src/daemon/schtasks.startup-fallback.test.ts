import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quoteCmdScriptArg } from "./cmd-argv.js";
import "./test-helpers/schtasks-base-mocks.js";
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
  restartScheduledTask,
  resolveTaskScriptPath,
  stopScheduledTask,
} = await import("./schtasks.js");

function resolveStartupEntryPath(env: Record<string, string>) {
  return path.join(
    env.APPDATA,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "OpenClaw Gateway.cmd",
  );
}

async function writeStartupFallbackEntry(env: Record<string, string>) {
  const startupEntryPath = resolveStartupEntryPath(env);
  await fs.mkdir(path.dirname(startupEntryPath), { recursive: true });
  await fs.writeFile(startupEntryPath, "@echo off\r\n", "utf8");
  return startupEntryPath;
}

function expectStartupFallbackSpawn(env: Record<string, string>) {
  expect(spawn).toHaveBeenCalledWith(
    "cmd.exe",
    ["/d", "/s", "/c", quoteCmdScriptArg(resolveTaskScriptPath(env))],
    expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true }),
  );
}

function expectGatewayTermination(pid: number) {
  if (process.platform === "win32") {
    expect(killProcessTree).not.toHaveBeenCalled();
    return;
  }
  expect(killProcessTree).toHaveBeenCalledWith(pid, { graceMs: 300 });
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

function notYetRunTaskQueryOutput() {
  return [
    "Status: Ready",
    "Last Run Time: 11/30/1999 12:00:00 AM",
    "Last Run Result: 267011",
    "",
  ].join("\r\n");
}

beforeEach(() => {
  resetSchtasksBaseMocks();
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
  it("falls back to a Startup-folder launcher when schtasks create is denied", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not found" },
        { code: 5, stdout: "", stderr: "ERROR: Access is denied." },
      );

      const stdout = new PassThrough();
      let printed = "";
      stdout.on("data", (chunk) => {
        printed += String(chunk);
      });

      const result = await installScheduledTask({
        env,
        stdout,
        programArguments: ["node", "gateway.js", "--port", "18789"],
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      });

      const startupEntryPath = resolveStartupEntryPath(env);
      const startupScript = await fs.readFile(startupEntryPath, "utf8");
      expect(result.scriptPath).toBe(resolveTaskScriptPath(env));
      expect(startupScript).toContain('start "" /min cmd.exe /d /c');
      expect(startupScript).toContain("gateway.cmd");
      expect(spawn).toHaveBeenCalledWith(
        "cmd.exe",
        ["/d", "/s", "/c", quoteCmdScriptArg(resolveTaskScriptPath(env))],
        expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true }),
      );
      expect(childUnref).toHaveBeenCalled();
      expect(printed).toContain("Installed Windows login item");
    });
  });

  it("falls back to a Startup-folder launcher when schtasks create hangs", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not found" },
        { code: 124, stdout: "", stderr: "schtasks timed out after 15000ms" },
      );

      const stdout = new PassThrough();
      await installScheduledTask({
        env,
        stdout,
        programArguments: ["node", "gateway.js", "--port", "18789"],
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      });

      await expect(fs.access(resolveStartupEntryPath(env))).resolves.toBeUndefined();
      expectStartupFallbackSpawn(env);
    });
  });

  it("launches the task script directly when schtasks /Run is accepted but never starts the task", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      sleepMock.mockImplementationOnce(async () => {
        timeState.now += 15_000;
      });
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not found" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: notYetRunTaskQueryOutput(), stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: notYetRunTaskQueryOutput(), stderr: "" },
      );

      await installScheduledTask({
        env,
        stdout: new PassThrough(),
        programArguments: ["node", "gateway.js", "--port", "18789"],
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      });

      expectStartupFallbackSpawn(env);
    });
  });

  it("does not relaunch the task script when schtasks shows startup progress after /Run", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not found" },
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
      );

      await installScheduledTask({
        env,
        stdout: new PassThrough(),
        programArguments: ["node", "gateway.js", "--port", "18789"],
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      });

      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it("does not relaunch the task script when the scheduled task process is already starting", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const taskScriptPath = resolveTaskScriptPath(env);
      sleepMock.mockImplementationOnce(async () => {
        timeState.now += 15_000;
      });
      spawnSync.mockImplementation((command, args) => {
        if (
          command === "powershell" &&
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
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not found" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: notYetRunTaskQueryOutput(), stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: notYetRunTaskQueryOutput(), stderr: "" },
      );

      await installScheduledTask({
        env,
        stdout: new PassThrough(),
        programArguments: ["node", "gateway.js", "--port", "18789"],
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      });

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

      await expect(readScheduledTaskRuntime(env)).resolves.toMatchObject({
        status: "running",
        pid: 4242,
        state: "Ready",
        lastRunResult: "267011",
      });
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

      await expect(readScheduledTaskRuntime(env)).resolves.toMatchObject({
        status: "stopped",
        state: "Ready",
        lastRunResult: "267011",
      });
    });
  });

  it("treats an installed Startup-folder launcher as loaded", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses();
      await writeStartupFallbackEntry(env);

      await expect(isScheduledTaskInstalled({ env })).resolves.toBe(true);
    });
  });

  it("reports runtime from the gateway listener when using the Startup fallback", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses();
      await writeStartupFallbackEntry(env);
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 4242, command: "node.exe" }],
        hints: [],
      });

      await expect(readScheduledTaskRuntime(env)).resolves.toMatchObject({
        status: "running",
        pid: 4242,
      });
    });
  });

  it("restarts the Startup fallback by killing the current pid and relaunching the entry", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not found" },
      ]);
      await writeStartupFallbackEntry(env);
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 5151, command: "node.exe" }],
        hints: [],
      });

      const stdout = new PassThrough();
      await expect(restartScheduledTask({ env, stdout })).resolves.toEqual({
        outcome: "completed",
      });
      expectGatewayTermination(5151);
      expectStartupFallbackSpawn(env);
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

      expectStartupFallbackSpawn(env);
    });
  });

  it("kills the Startup fallback runtime even when the CLI env omits the gateway port", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      schtasksResponses.push({ code: 0, stdout: "", stderr: "" });
      await writeGatewayScript(env);
      await writeStartupFallbackEntry(env);
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
