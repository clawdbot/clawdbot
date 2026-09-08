import type { SpawnSyncOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import * as commands from "../process/exec.js";
import * as launchdCurrent from "./launchd-current-service.js";
import * as launchctl from "./launchd-exec.js";
import { stopLaunchAgent } from "./launchd-stop.js";
import { suspendScheduledTaskAutoStartForUpdate } from "./schtasks-control.js";
import * as schtasksExec from "./schtasks-exec.js";
import { terminateGatewayProcessTree } from "./schtasks-process.js";
import * as systemctl from "./systemd-exec.js";
import { stopSystemdService } from "./systemd-lifecycle.js";
import * as systemdScope from "./systemd-scope.js";

const native = vi.hoisted(() => ({
  active: true,
  now: 0,
  spawn: vi.fn<
    (
      command: string,
      args?: readonly string[],
      options?: SpawnSyncOptions,
    ) => {
      pid: number;
      output: Array<string | null>;
      stdout: string;
      stderr: string;
      status: number;
      signal: null;
    }
  >(),
}));
vi.mock("node:child_process", async (actual) => ({
  ...(await actual<typeof import("node:child_process")>()),
  spawnSync: native.spawn,
}));
vi.mock("../utils.js", async (actual) => ({
  ...(await actual<typeof import("../utils.js")>()),
  sleep: async (ms: number) => {
    native.now += ms;
    native.active = false;
  },
}));
afterEach(() => {
  vi.restoreAllMocks();
  native.spawn.mockReset();
  native.active = true;
  native.now = 0;
});
const assertCurrent = () => {
  if (!native.active) {
    throw new Error("stop owner retired");
  }
};

it("rechecks the original owner after systemd routing reads and before dispatch", async () => {
  vi.spyOn(systemdScope, "findInstalledSystemdGatewayScope").mockImplementation(async () => {
    native.active = false;
    return { scope: "user", unitName: "openclaw-gateway.service", unitPath: "/unused/service" };
  });
  vi.spyOn(systemctl, "assertSystemdAvailable").mockResolvedValue(undefined);
  const dispatch = vi
    .spyOn(systemctl, "execSystemctlUser")
    .mockResolvedValue({ code: 0, termination: "exit", stdout: "", stderr: "" });
  await expect(
    stopSystemdService({ env: {}, stdout: new PassThrough(), assertCurrent }),
  ).rejects.toThrow("stop owner retired");
  expect(dispatch).not.toHaveBeenCalled();
});

it("rechecks the original owner after launchd ancestry reads and before bootout", async () => {
  vi.spyOn(launchdCurrent, "isCurrentProcessInsideLaunchdService").mockImplementation(async () => {
    native.active = false;
    return false;
  });
  const dispatch = vi
    .spyOn(launchctl, "execLaunchctl")
    .mockResolvedValue({ code: 0, termination: "exit", stdout: "", stderr: "" });
  await expect(
    stopLaunchAgent({ env: {}, stdout: new PassThrough(), assertCurrent }),
  ).rejects.toThrow("stop owner retired");
  expect(dispatch).not.toHaveBeenCalled();
});

it("does not force a Windows process tree after losing the owner during graceful drain", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(Date, "now").mockImplementation(() => native.now);
  native.spawn.mockImplementation((command) => {
    const stdout = command.toLowerCase().endsWith("taskkill.exe") ? "" : '[{"ProcessId":4242}]';
    return { pid: 0, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
  });
  await expect(terminateGatewayProcessTree(4242, 300, assertCurrent)).rejects.toThrow(
    "stop owner retired",
  );
  expect(
    native.spawn.mock.calls
      .filter(([command]) => command.toLowerCase().endsWith("taskkill.exe"))
      .map(([, args]) => args),
  ).toEqual([["/T", "/PID", "4242"]]);
});

it("rechecks ownership after the asynchronous Windows suppression guard", async () => {
  const dispatch = vi.spyOn(schtasksExec, "execSchtasks").mockResolvedValue({
    code: 0,
    stdout: "<Task><Settings><Enabled>true</Enabled></Settings></Task>",
    stderr: "",
  });
  await expect(
    suspendScheduledTaskAutoStartForUpdate(
      { HOME: "/unused", OPENCLAW_WINDOWS_TASK_NAME: "Native Fence Proof" },
      {
        restoreOnFailure: false,
        beforeMutation: async () => {
          assertCurrent();
          queueMicrotask(() => {
            native.active = false;
          });
        },
        assertCurrent,
      },
    ),
  ).rejects.toThrow("stop owner retired");
  expect(dispatch.mock.calls.map(([args]) => args[0])).toEqual(["/Query"]);
});

it.each(["timeout", "signal"] as const)(
  "does not report terminated schtasks as success: %s",
  async (termination) => {
    vi.spyOn(commands, "runCommandWithTimeout").mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: true,
      termination,
      cleanup: "normal",
      noOutputTimedOut: false,
    });
    const result = await schtasksExec.execSchtasks(["/End", "/TN", "Native Fence Proof"]);
    expect(result.code).not.toBe(0);
  },
);
