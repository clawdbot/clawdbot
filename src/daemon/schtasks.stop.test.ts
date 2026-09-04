// Windows schtasks stop tests cover stopping scheduled task services.
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/schtasks-base-mocks.js";
import {
  gatewayServiceProbeHostsMock,
  inspectPortUsageMock,
  killProcessTreeMock,
  resetSchtasksBaseMocks,
  schtasksCalls,
  schtasksResponses,
  withWindowsEnv,
  writeGatewayScript,
} from "./test-helpers/schtasks-fixtures.js";
const findVerifiedGatewayListenerPidsOnPortSync = vi.hoisted(() =>
  vi.fn<(port: number) => number[]>(() => []),
);
const timeState = vi.hoisted(() => ({ now: 0 }));
const sleepMock = vi.hoisted(() =>
  vi.fn(async (ms: number) => {
    timeState.now += ms;
  }),
);
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
    output: [null, "-2147024891", ""],
    stdout: "-2147024891",
    stderr: "",
    status: 1,
    signal: null,
  })),
);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawnSync };
});

vi.mock("../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: (port: number) =>
    findVerifiedGatewayListenerPidsOnPortSync(port),
}));
vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...actual,
    sleep: (ms: number) => sleepMock(ms),
  };
});

const {
  resolveTaskScriptPath,
  restartScheduledTask,
  resumeScheduledTaskAutoStartAfterUpdate,
  startScheduledTask,
  stopScheduledTask,
  suspendScheduledTaskAutoStartForUpdate,
} = await import("./schtasks.js");
const { resolveScheduledTaskOwnedGatewayPids } = await import("./schtasks-process.js");
const GATEWAY_PORT = 18789;
const SUCCESS_RESPONSE = { code: 0, stdout: "", stderr: "" } as const;
const INSTALLED_GATEWAY_COMMAND_LINE =
  '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789';

function pushSuccessfulSchtasksResponses(count: number) {
  for (let i = 0; i < count; i += 1) {
    schtasksResponses.push({ ...SUCCESS_RESPONSE });
  }
}

function freePortUsage() {
  return {
    port: GATEWAY_PORT,
    status: "free" as const,
    listeners: [],
    hints: [],
  };
}

function busyPortUsage(
  pid: number,
  options: {
    command?: string;
    commandLine?: string;
  } = {},
) {
  return {
    port: GATEWAY_PORT,
    status: "busy" as const,
    listeners: [
      {
        pid,
        command: options.command ?? "node.exe",
        address: `127.0.0.1:${GATEWAY_PORT}`,
        ...(options.commandLine ? { commandLine: options.commandLine } : {}),
      },
    ],
    hints: [],
  };
}

function expectGatewayTermination(pid: number) {
  if (process.platform === "win32") {
    expect(killProcessTreeMock).not.toHaveBeenCalled();
    return;
  }
  expect(killProcessTreeMock).toHaveBeenCalledWith(pid, { graceMs: 300 });
}

function setTaskStateProbeResult(state: number) {
  const stdout = JSON.stringify({ state });
  spawnSync.mockReturnValueOnce({
    pid: 0,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
  });
}

async function withPreparedGatewayTask(
  run: (context: { env: Record<string, string>; stdout: PassThrough }) => Promise<void>,
) {
  await withWindowsEnv("openclaw-win-stop-", async ({ env }) => {
    await writeGatewayScript(env, GATEWAY_PORT);
    const stdout = new PassThrough();
    await run({ env, stdout });
  });
}

beforeEach(() => {
  resetSchtasksBaseMocks();
  findVerifiedGatewayListenerPidsOnPortSync.mockReset();
  findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
  timeState.now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => timeState.now);
  sleepMock.mockReset();
  sleepMock.mockImplementation(async (ms: number) => {
    timeState.now += ms;
  });
  spawnSync.mockReset();
  spawnSync.mockReturnValue({
    pid: 0,
    output: [null, "-2147024891", ""],
    stdout: "-2147024891",
    stderr: "",
    status: 1,
    signal: null,
  });
  inspectPortUsageMock.mockResolvedValue(freePortUsage());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Scheduled Task stop/restart cleanup", () => {
  it("suspends a task whose Settings.Enabled value uses the default", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push(
        {
          ...SUCCESS_RESPONSE,
          stdout: "<Task><Settings><StartWhenAvailable>true</StartWhenAvailable></Settings></Task>",
        },
        { ...SUCCESS_RESPONSE },
      );

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(true);

      expect(schtasksCalls).toEqual([
        ["/Query", "/TN", "OpenClaw Gateway", "/XML"],
        ["/Change", "/TN", "OpenClaw Gateway", "/DISABLE"],
      ]);
    });
  });

  it("preserves an already-disabled task", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({
        ...SUCCESS_RESPONSE,
        stdout:
          "<Task><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><Enabled>false</Enabled></Settings></Task>",
      });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(false);

      expect(schtasksCalls).toEqual([["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
    });
  });

  it("fails closed when task absence cannot be confirmed", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({
        code: 1,
        stdout: "",
        stderr: "ERROR: The system cannot find the file specified.",
      });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).rejects.toThrow(
        "schtasks XML query failed: ERROR: The system cannot find the file specified.",
      );

      expect(schtasksCalls).toEqual([["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
      expect(spawnSync).toHaveBeenCalledOnce();
    });
  });

  it("ignores a stale task script when COM proves the task is absent", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({
        code: 1,
        stdout: "",
        stderr: "FEHLER: Die angegebene Datei wurde nicht gefunden.",
      });
      spawnSync.mockReturnValueOnce({
        pid: 0,
        output: [null, "-2147024894", ""],
        stdout: "-2147024894",
        stderr: "",
        status: 1,
        signal: null,
      });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(false);

      expect(schtasksCalls).toEqual([["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
      expect(spawnSync).toHaveBeenCalledOnce();
    });
  });

  it("fails closed when the task enabled state is missing", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({ ...SUCCESS_RESPONSE, stdout: "<Task><Triggers /></Task>" });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).rejects.toThrow(
        "schtasks XML query did not expose the task enabled state",
      );
    });
  });

  it("restores an enabled task after an ambiguous disable failure", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push(
        {
          ...SUCCESS_RESPONSE,
          stdout: "<Task><Settings><Enabled>true</Enabled></Settings></Task>",
        },
        { code: 124, stdout: "", stderr: "schtasks timed out after 15000ms" },
        { ...SUCCESS_RESPONSE },
      );

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).rejects.toThrow(
        "schtasks disable failed: schtasks timed out after 15000ms",
      );

      expect(schtasksCalls).toEqual([
        ["/Query", "/TN", "OpenClaw Gateway", "/XML"],
        ["/Change", "/TN", "OpenClaw Gateway", "/DISABLE"],
        ["/Change", "/TN", "OpenClaw Gateway", "/ENABLE"],
      ]);
    });
  });

  it("leaves startup-folder fallback installs unchanged when the task is absent", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      const startupEntry = path.join(
        expectDefined(env.APPDATA, "env.APPDATA test invariant"),
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
        "OpenClaw Gateway.cmd",
      );
      await fs.mkdir(path.dirname(startupEntry), { recursive: true });
      await fs.writeFile(startupEntry, "@echo off\r\n", "utf8");
      schtasksResponses.push({
        code: 1,
        stdout: "",
        stderr: "FEHLER: Die angegebene Datei wurde nicht gefunden.",
      });
      spawnSync.mockReturnValueOnce({
        pid: 0,
        output: [null, "-2147024894", ""],
        stdout: "-2147024894",
        stderr: "",
        status: 1,
        signal: null,
      });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(false);

      expect(schtasksCalls).toEqual([["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
      expect(spawnSync).toHaveBeenCalledOnce();
    });
  });

  it("fails closed on an ambiguous task query even when a startup entry exists", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      const startupEntry = path.join(
        expectDefined(env.APPDATA, "env.APPDATA test invariant"),
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
        "OpenClaw Gateway.cmd",
      );
      await fs.mkdir(path.dirname(startupEntry), { recursive: true });
      await fs.writeFile(startupEntry, "@echo off\r\n", "utf8");
      schtasksResponses.push({ code: 1, stdout: "", stderr: "ERROR: Access is denied." });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).rejects.toThrow(
        "schtasks XML query failed: ERROR: Access is denied.",
      );
      expect(spawnSync).toHaveBeenCalledOnce();
    });
  });

  it("reads NUL-separated Scheduled Task XML", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      const xml = "<Task><Settings><Enabled>true</Enabled></Settings></Task>";
      schtasksResponses.push(
        { ...SUCCESS_RESPONSE, stdout: `\uFEFF${xml.split("").join("\u0000")}` },
        { ...SUCCESS_RESPONSE },
      );

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(true);
    });
  });

  it("reenables a task after the update window", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({ ...SUCCESS_RESPONSE });

      await expect(resumeScheduledTaskAutoStartAfterUpdate(env)).resolves.toBe(true);

      expect(schtasksCalls).toEqual([["/Change", "/TN", "OpenClaw Gateway", "/ENABLE"]]);
    });
  });

  it("surfaces a failed task reenable", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({ code: 1, stdout: "", stderr: "ERROR: Access is denied." });

      await expect(resumeScheduledTaskAutoStartAfterUpdate(env)).rejects.toThrow(
        "schtasks enable failed: ERROR: Access is denied.",
      );
    });
  });

  it.each([
    { state: 1, label: "disabled" },
    { state: 3, label: "ready" },
  ])("accepts a localized /End failure when COM proves the task is $label", async ({ state }) => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      const onMutation = vi.fn();
      schtasksResponses.push(
        { ...SUCCESS_RESPONSE },
        { ...SUCCESS_RESPONSE },
        {
          code: 1,
          stdout: "",
          stderr: "FEHLER: Die Aufgabe wird derzeit nicht ausgeführt.",
        },
      );
      setTaskStateProbeResult(state);

      await expect(stopScheduledTask({ env, stdout, onMutation })).resolves.toBeUndefined();

      expect(schtasksCalls).toEqual([
        ["/Query"],
        ["/Query", "/TN", "OpenClaw Gateway"],
        ["/End", "/TN", "OpenClaw Gateway"],
      ]);
      expect(spawnSync).toHaveBeenCalledOnce();
      expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-stop" });
    });
  });

  it.each([
    { state: 0, label: "unknown" },
    { state: 2, label: "queued" },
    { state: 4, label: "running" },
  ])("fails closed after a localized /End failure when the task is $label", async ({ state }) => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      const onMutation = vi.fn();
      schtasksResponses.push(
        { ...SUCCESS_RESPONSE },
        { ...SUCCESS_RESPONSE },
        {
          code: 1,
          stdout: "",
          stderr: "FEHLER: Die Aufgabe konnte nicht beendet werden.",
        },
      );
      setTaskStateProbeResult(state);

      await expect(stopScheduledTask({ env, stdout, onMutation })).rejects.toThrow(
        "schtasks end failed: FEHLER: Die Aufgabe konnte nicht beendet werden.",
      );

      expect(spawnSync).toHaveBeenCalledOnce();
      expect(onMutation).not.toHaveBeenCalled();
    });
  });

  it.each([
    { label: "malformed", status: 0, probeOutput: "3 trailing output" },
    { label: "missing", status: 1, probeOutput: "-2147024894" },
    { label: "unavailable", status: 1, probeOutput: "-2147024891" },
  ])(
    "fails closed after a localized /End failure when the state probe is $label",
    async ({ status, probeOutput }) => {
      await withPreparedGatewayTask(async ({ env, stdout }) => {
        const onMutation = vi.fn();
        schtasksResponses.push(
          { ...SUCCESS_RESPONSE },
          { ...SUCCESS_RESPONSE },
          {
            code: 1,
            stdout: "",
            stderr: "FEHLER: Der Aufgabenstatus ist nicht verfügbar.",
          },
        );
        spawnSync.mockReturnValueOnce({
          pid: 0,
          output: [null, probeOutput, ""],
          stdout: probeOutput,
          stderr: "",
          status,
          signal: null,
        });

        await expect(stopScheduledTask({ env, stdout, onMutation })).rejects.toThrow(
          "schtasks end failed: FEHLER: Der Aufgabenstatus ist nicht verfügbar.",
        );

        expect(spawnSync).toHaveBeenCalledOnce();
        expect(onMutation).not.toHaveBeenCalled();
      });
    },
  );

  it("kills the lingering gateway process owned by the persisted task command", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      const onMutation = vi.fn();
      pushSuccessfulSchtasksResponses(3);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      inspectPortUsageMock
        .mockResolvedValueOnce(busyPortUsage(4242, { commandLine: INSTALLED_GATEWAY_COMMAND_LINE }))
        .mockResolvedValueOnce(freePortUsage());

      await stopScheduledTask({ env, stdout, onMutation });

      expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
      expectGatewayTermination(4242);
      expect(inspectPortUsageMock).toHaveBeenCalledTimes(2);
      expect(inspectPortUsageMock).toHaveBeenCalledWith(GATEWAY_PORT, {
        probeHosts: ["127.0.0.1"],
      });
      expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-stop" });
    });
  });

  it("does not adopt a portless arbitrary task action", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      delete env.OPENCLAW_GATEWAY_PORT;
      const scriptPath = resolveTaskScriptPath(env);
      await fs.writeFile(
        scriptPath,
        '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "C:\\probe.cjs"\r\n',
        "utf8",
      );

      await expect(resolveScheduledTaskOwnedGatewayPids(env)).resolves.toEqual([]);

      expect(inspectPortUsageMock).not.toHaveBeenCalled();
      expect(gatewayServiceProbeHostsMock).not.toHaveBeenCalled();
    });
  });

  it.each(["gateway", "task-supervisor", "gateway-with-supervisor"])(
    "stops the exact installed Windows %s even before its port is bound",
    async (owner) => {
      await withPreparedGatewayTask(async ({ env, stdout }) => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        pushSuccessfulSchtasksResponses(3);
        inspectPortUsageMock.mockResolvedValue(freePortUsage());
        let forced = false;
        spawnSync.mockImplementation((command, args) => {
          const executable = command.toLowerCase();
          if (executable.endsWith("taskkill.exe")) {
            const argv = Array.isArray(args) ? args.map(String) : [];
            if (argv.includes("/F")) {
              forced = true;
              return {
                pid: 0,
                output: [null, "", ""],
                stdout: "",
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
              status: 1,
              signal: null,
            };
          }
          const processes = [
            ...(owner === "gateway-with-supervisor"
              ? [
                  {
                    ProcessId: 4141,
                    CommandLine: `${INSTALLED_GATEWAY_COMMAND_LINE} --task-supervisor`,
                  },
                ]
              : []),
            {
              ProcessId: 3131,
              CommandLine:
                '"C:\\Program Files\\nodejs\\node.exe" "C:\\other-openclaw.cjs" gateway --port 18789',
            },
            ...(!forced
              ? [
                  {
                    ProcessId: 4242,
                    CommandLine:
                      INSTALLED_GATEWAY_COMMAND_LINE +
                      (owner === "task-supervisor" ? " --task-supervisor" : ""),
                  },
                ]
              : []),
            { ProcessId: 9999, CommandLine: "powershell.exe" },
          ];
          const output = JSON.stringify(processes);
          return {
            pid: 0,
            output: [null, output, ""],
            stdout: output,
            stderr: "",
            status: 0,
            signal: null,
          };
        });

        await stopScheduledTask({ env, stdout });

        const taskkillCalls = spawnSync.mock.calls
          .filter(([command]) => command.toLowerCase().endsWith("taskkill.exe"))
          .map(([, args]) => args);
        expect(taskkillCalls).toEqual([
          ["/T", "/PID", "4242"],
          ["/F", "/T", "/PID", "4242"],
        ]);
        expect(taskkillCalls.flat()).not.toContain("3131");
        expect(taskkillCalls.flat()).not.toContain("4141");
        expect(killProcessTreeMock).not.toHaveBeenCalled();
      });
    },
  );

  it("starts a registered task and ignores audit observer failures", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push(
        { ...SUCCESS_RESPONSE },
        { ...SUCCESS_RESPONSE },
        { ...SUCCESS_RESPONSE },
      );
      setTaskStateProbeResult(4);
      const write = vi.fn();
      const onMutation = vi.fn(() => {
        throw new Error("audit failed");
      });

      await expect(
        startScheduledTask({
          env,
          stdout: { write } as unknown as NodeJS.WritableStream,
          onMutation,
        }),
      ).resolves.toBeUndefined();

      expect(schtasksCalls).toContainEqual(["/Run", "/TN", "OpenClaw Gateway"]);
      expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-start" });
      expect(
        expectDefined(onMutation.mock.invocationCallOrder[0], "start audit call order"),
      ).toBeLessThan(expectDefined(write.mock.invocationCallOrder[0], "start output call order"));
    });
  });

  it("audits a successful task stop before a later output failure", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      pushSuccessfulSchtasksResponses(3);
      const onMutation = vi.fn();
      const stdout = {
        write: vi.fn(() => {
          throw new Error("output failed");
        }),
      } as unknown as NodeJS.WritableStream;

      await expect(stopScheduledTask({ env, stdout, onMutation })).rejects.toThrow("output failed");

      expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-stop" });
    });
  });

  it("does not kill an unrelated listener when the owned process leaves another required host busy", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(3);
      inspectPortUsageMock.mockResolvedValueOnce(
        busyPortUsage(4242, { commandLine: INSTALLED_GATEWAY_COMMAND_LINE }),
      );
      for (let i = 0; i < 20; i += 1) {
        inspectPortUsageMock.mockResolvedValueOnce(busyPortUsage(5252));
      }

      await expect(stopScheduledTask({ env, stdout })).rejects.toThrow(
        "remaining listener ownership could not be verified",
      );

      if (process.platform !== "win32") {
        expect(killProcessTreeMock).toHaveBeenCalledOnce();
        expect(killProcessTreeMock).toHaveBeenCalledWith(4242, { graceMs: 300 });
      } else {
        expect(killProcessTreeMock).not.toHaveBeenCalled();
      }
      expect(killProcessTreeMock).not.toHaveBeenCalledWith(5252, { graceMs: 300 });
    });
  });

  it("falls back to inspected gateway listeners when sync verification misses on Windows", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(3);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
      inspectPortUsageMock
        .mockResolvedValueOnce(
          busyPortUsage(6262, {
            commandLine:
              '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789',
          }),
        )
        .mockResolvedValueOnce(freePortUsage());

      await stopScheduledTask({ env, stdout });

      expectGatewayTermination(6262);
      expect(inspectPortUsageMock).toHaveBeenCalledTimes(2);
    });
  });

  it("does not reclaim gateway listeners when stopping a node Scheduled Task", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(3);
      env.OPENCLAW_SERVICE_KIND = "node";
      env.OPENCLAW_WINDOWS_TASK_NAME = "OpenClaw Node";
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      inspectPortUsageMock.mockResolvedValue(busyPortUsage(4242));

      await stopScheduledTask({ env, stdout });

      expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
      expect(inspectPortUsageMock).not.toHaveBeenCalled();
      expect(killProcessTreeMock).not.toHaveBeenCalled();
      expect(schtasksCalls).toEqual([
        ["/Query"],
        ["/Query", "/TN", "OpenClaw Node"],
        ["/End", "/TN", "OpenClaw Node"],
      ]);
    });
  });

  it("kills the owned gateway process and waits for port release before restart", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      const onMutation = vi.fn();
      pushSuccessfulSchtasksResponses(4);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([5151]);
      inspectPortUsageMock
        .mockResolvedValueOnce(busyPortUsage(5151, { commandLine: INSTALLED_GATEWAY_COMMAND_LINE }))
        .mockResolvedValueOnce(freePortUsage());

      await expect(restartScheduledTask({ env, stdout, onMutation })).resolves.toEqual({
        outcome: "completed",
      });

      expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
      expectGatewayTermination(5151);
      expect(inspectPortUsageMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(inspectPortUsageMock).toHaveBeenCalledWith(GATEWAY_PORT, {
        probeHosts: ["127.0.0.1"],
      });
      expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-restart" });
      expect(schtasksCalls).toEqual([
        ["/Query"],
        ["/Query", "/TN", "OpenClaw Gateway"],
        ["/End", "/TN", "OpenClaw Gateway"],
        ["/Run", "/TN", "OpenClaw Gateway"],
      ]);
    });
  });

  it("does not wait on or force-kill the gateway port when restarting a node Scheduled Task", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(4);
      env.OPENCLAW_SERVICE_KIND = "node";
      env.OPENCLAW_WINDOWS_TASK_NAME = "OpenClaw Node";
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([5151]);
      inspectPortUsageMock.mockResolvedValue(busyPortUsage(5151));

      await expect(restartScheduledTask({ env, stdout })).resolves.toEqual({
        outcome: "completed",
      });

      expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
      expect(inspectPortUsageMock).not.toHaveBeenCalled();
      expect(killProcessTreeMock).not.toHaveBeenCalled();
      expect(schtasksCalls).toEqual([
        ["/Query"],
        ["/Query", "/TN", "OpenClaw Node"],
        ["/End", "/TN", "OpenClaw Node"],
        ["/Run", "/TN", "OpenClaw Node"],
      ]);
    });
  });

  it("throws when /Run fails during restart", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      const onMutation = vi.fn();
      schtasksResponses.push(
        { ...SUCCESS_RESPONSE },
        { ...SUCCESS_RESPONSE },
        { ...SUCCESS_RESPONSE },
        { code: 1, stdout: "", stderr: "ERROR: Access is denied." },
      );

      await expect(restartScheduledTask({ env, stdout, onMutation })).rejects.toThrow(
        "schtasks run failed: ERROR: Access is denied.",
      );
      expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-end" });
      expect(onMutation).not.toHaveBeenCalledWith({ mode: "schtasks-restart" });
      expect(schtasksCalls.at(-1)).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });
});
