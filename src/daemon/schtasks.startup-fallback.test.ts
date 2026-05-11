import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function addStartupFallbackMissingResponses(
  extraResponses: Array<{ code: number; stdout: string; stderr: string }> = [],
) {
  schtasksResponses.push(
    { code: 0, stdout: "", stderr: "" },
    { code: 1, stdout: "", stderr: "not found" },
    ...extraResponses,
  );
}

function installGatewayScheduledTask(env: Record<string, string>, stdout = new PassThrough()) {
  return installScheduledTask({
    env,
    stdout,
    programArguments: ["node", "gateway.js", "--port", "18789"],
    environment: { OPENCLAW_GATEWAY_PORT: "18789" },
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
      const startupScript = await fs.readFile(startupEntryPath, "utf8");
      expect(result.scriptPath).toBe(resolveTaskScriptPath(env));
      expect(startupScript).toContain('start "" /min cmd.exe /d /c');
      expect(startupScript).toContain("gateway.cmd");
      expectStartupFallbackSpawn();
      expect(childUnref).toHaveBeenCalled();
      expect(printed).toContain("Installed Windows login item");
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

      const runtime = await readScheduledTaskRuntime(env);
      expect(runtime.status).toBe("running");
      expect(runtime.pid).toBe(4242);
    });
  });

  it("restarts the Startup fallback by killing the current pid and relaunching the entry", async () => {
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
        listeners: [{ pid: 5151, command: "node.exe" }],
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
