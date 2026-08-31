// Managed Child Process tests cover managed child process script behavior.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createManagedCommandSpawnSpec,
  inspectManagedProcessGroup,
  runManagedCommand,
  signalExitCode,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "../../scripts/lib/managed-child-process.mts";
import {
  runNodeStep,
  runNodeStepsInParallel,
} from "../../scripts/prepare-extension-package-boundary-artifacts.mts";
import { waitForChildClose, waitForDead, waitForPidFile } from "../helpers/process-wait.js";
import { startProcessWatchdogFixture } from "../helpers/process-watchdog.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const posixIt = process.platform === "win32" ? it.skip : it;
const taskkillPath = path.win32.join("C:\\Windows", "System32", "taskkill.exe");

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function withDefaultWindowsSystemRoot(run: () => void): void {
  const originalSystemRoot = process.env.SystemRoot;
  const originalWindir = process.env.WINDIR;
  try {
    process.env.SystemRoot = "C:\\Windows";
    delete process.env.WINDIR;
    run();
  } finally {
    restoreEnvValue("SystemRoot", originalSystemRoot);
    restoreEnvValue("WINDIR", originalWindir);
  }
}

function expectProcessPid(pid: number | undefined): number {
  if (pid == null) {
    throw new Error("Expected spawned process to expose a pid");
  }
  return pid;
}

async function killFixturePid(pid: number, processGroup = false): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error("Invalid owned fixture PID");
  }
  await runQaGatewayFixture(
    async () => {
      try {
        process.kill(processGroup ? -pid : pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    },
    () => waitForDead(pid, 2_000),
  );
}

// Call after installing handlers and keepalive: existence must mean a complete, ready PID.
function publishReadyPidScript(argIndex: number): string {
  return `
const pidPath = process.argv[${argIndex}];
fs.writeFileSync(pidPath + ".tmp", String(process.pid));
fs.renameSync(pidPath + ".tmp", pidPath);
`;
}

describe("managed-child-process", () => {
  it.runIf(process.platform === "linux")(
    "accepts exited tooling descendants still awaiting reaping",
    async () => {
      const dir = createTempDir("openclaw-managed-zombie-");
      const childPath = path.join(dir, "child.mts");
      const runnerPath = path.join(dir, "runner.mjs");
      fs.writeFileSync(childPath, 'const value: number = 7; console.log("typed-child", value);');
      fs.writeFileSync(
        runnerPath,
        `
import { runManagedCommand } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/managed-child-process.mts")).href)};
process.exitCode = await runManagedCommand({
  bin: process.execPath,
  args: ["--import", ${JSON.stringify(pathToFileURL(path.resolve("scripts/tsx.mjs")).href)}, ${JSON.stringify(childPath)}],
  requireProcessTreeExit: true,
});
`,
      );
      // Linux may reap orphaned tool services after the leader's close. Adopt
      // them here and defer reaping until the real supervisor has settled.
      const reaper = `
import ctypes, os, subprocess, sys
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER failed")
try:
    result = subprocess.run(sys.argv[1:])
finally:
    reaped = 0
    while True:
        try:
            pid, code = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid == 0 or code != 0:
            raise RuntimeError("tool descendant did not exit successfully")
        reaped += 1
    print("successfully reaped:", reaped)
    if reaped == 0:
        raise RuntimeError("fixture did not retain an exited descendant")
sys.exit(result.returncode)
`;
      let output = "";
      const code = await runManagedCommand({
        bin: "python3",
        args: ["-c", reaper, process.execPath, runnerPath],
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs: 10_000,
        onReady(child) {
          for (const pipe of [child.stdout, child.stderr]) {
            pipe?.on("data", (chunk) => (output += String(chunk)));
          }
        },
      });
      expect(code, output).toBe(0);
      expect(output).toContain("typed-child 7");
      expect(output).toMatch(/successfully reaped: [1-9]/u);
    },
  );

  posixIt.each([
    { runner: "managed", resistant: false, abort: false },
    { runner: "managed", resistant: true, abort: false },
    { runner: "managed-inherit", resistant: true, abort: false },
    { runner: "preparation", resistant: false, abort: false },
    { runner: "preparation", resistant: true, abort: false },
    { runner: "preparation", resistant: false, abort: true },
    { runner: "preparation", resistant: true, abort: true },
  ])(
    "joins nested $runner cleanup (resistant=$resistant, abort=$abort)",
    async ({ runner, resistant, abort }) => {
      const dir = fs.realpathSync(createTempDir("openclaw-nested-timeout-"));
      const moduleUrl = (file: string) => pathToFileURL(path.resolve(file)).href;
      const pidPaths = ["wrapper", "implementation", "leaf"].map((role) =>
        path.join(dir, `${role}.pid`),
      );
      const publish = (index: number) =>
        `fs.writeFileSync(${JSON.stringify(pidPaths[index])} + '.tmp', String(process.pid)); fs.renameSync(${JSON.stringify(pidPaths[index])} + '.tmp', ${JSON.stringify(pidPaths[index])});`;
      const wrapper = path.join(dir, "wrapper.mjs");
      fs.writeFileSync(
        wrapper,
        `
import fs from 'node:fs';
import { runTsxCliShim } from ${JSON.stringify(moduleUrl("scripts/lib/tsx-cli-shim.mjs"))};
${publish(0)}
await runTsxCliShim(import.meta.url, { implementation: './implementation.mts', forceKillDelayMs: 10000 });
`,
      );
      fs.writeFileSync(
        path.join(dir, "implementation.mts"),
        `
import fs from 'node:fs';
import { runManagedCommand } from ${JSON.stringify(moduleUrl("scripts/lib/managed-child-process.mts"))};
${publish(1)}
process.exitCode = await runManagedCommand({ bin: process.execPath, args: [${JSON.stringify(path.join(dir, "leaf.mjs"))}], shell: false });
`,
      );
      fs.writeFileSync(
        path.join(dir, "leaf.mjs"),
        `
import fs from 'node:fs';
process.on('SIGTERM', () => { process.stdout.write('shutdown-tail'); ${resistant ? "" : "process.exit(0);"} });
setInterval(() => {}, 1000);
${publish(2)}
`,
      );
      const abortController = new AbortController();
      const stdout = vi.spyOn(process.stdout, "write");
      let output = "";
      const releaseAndWait = startProcessWatchdogFixture(() => {
        const command =
          runner === "preparation"
            ? runNodeStep("nested", [wrapper], 100, { abortController })
            : runManagedCommand({
                bin: process.execPath,
                args: [wrapper],
                stdio: runner === "managed-inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
                timeoutMs: 100,
                onReady: (child) =>
                  child.stdout?.on("data", (chunk) => {
                    output += String(chunk);
                  }),
              });
        return command.then(
          () => undefined,
          (error: unknown) => error,
        );
      });
      const pids: number[] = [];
      // Finish cleanup before the harness afterEach removes PID evidence, retaining all failures.
      await runQaGatewayFixture(
        async () => {
          for (const pidPath of pidPaths) {
            pids.push(await waitForPidFile(pidPath, 10_000));
          }
          expect(pids.every(isProcessAlive)).toBe(true);
          if (abort) {
            abortController.abort();
          }
          expect(await releaseAndWait()).toMatchObject({
            message: expect.stringContaining(
              abort ? "canceled after sibling failure" : "timed out after 100ms",
            ),
          });
          expect(
            pids.filter(isProcessAlive),
            "timeout must join every nested child before rejection",
          ).toEqual([]);
          if (runner === "preparation") {
            expect(
              stdout.mock.calls.some(([chunk]) => String(chunk) === "[nested] shutdown-tail"),
            ).toBe(true);
          } else if (runner === "managed-inherit") {
            expect(stdout.mock.calls.some(([chunk]) => String(chunk) === "shutdown-tail")).toBe(
              true,
            );
          } else {
            expect(output).toBe("shutdown-tail");
          }
        },
        releaseAndWait,
        () => stdout.mockRestore(),
        ...pidPaths.toReversed().map((pidPath) => async () => {
          if (fs.existsSync(pidPath)) {
            await killFixturePid(Number(fs.readFileSync(pidPath, "utf8")));
          }
        }),
      );
    },
    20_000,
  );

  it("rejects timeout values beyond Node's timer range", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/lib/bounded-command.mjs",
        "2147483648",
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("timeout-ms must be at most 2147483647");
    expect(result.stderr).not.toContain("TimeoutOverflowWarning");
  });

  posixIt(
    "keeps the bounded launcher alive until nested signal cleanup finishes",
    async () => {
      const dir = createTempDir("openclaw-bounded-launcher-cleanup-");
      const leafPath = path.join(dir, "leaf.mjs");
      const leafPidPath = path.join(dir, "leaf.pid");
      fs.writeFileSync(
        leafPath,
        `
import fs from "node:fs";
fs.writeFileSync(process.argv[2], String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`,
        "utf8",
      );
      const launcher = spawn(
        process.execPath,
        ["scripts/lib/bounded-command.mjs", "60000", "--", process.execPath, leafPath, leafPidPath],
        { detached: true, stdio: "ignore" },
      );
      const closed = waitForChildClose(launcher, 12_000);
      let leafPid = 0;
      try {
        leafPid = await waitForPidFile(leafPidPath, 5_000);
        process.kill(-launcher.pid!, "SIGTERM");
        await expect(closed).resolves.toEqual({ code: 143, signal: null });
        await waitForDead(leafPid, 2_000);
      } finally {
        if (launcher.pid && isProcessAlive(launcher.pid)) {
          process.kill(-launcher.pid, "SIGKILL");
        }
        if (leafPid && isProcessAlive(leafPid)) {
          process.kill(leafPid, "SIGKILL");
        }
      }
    },
    15_000,
  );

  it("maps forwarded signals to shell-compatible exit codes", () => {
    expect(signalExitCode("SIGHUP")).toBe(129);
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
    expect(signalExitCode("SIGKILL")).toBe(137);
  });

  it("wraps Windows shell argv through cmd.exe without Node shell mode", () => {
    expect(
      createManagedCommandSpawnSpec({
        args: ["lint:scripts", "--", "scripts"],
        bin: "pnpm.cmd",
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        env: {},
        platform: "win32",
        shell: true,
      }),
    ).toEqual({
      args: ["/d", "/s", "/c", "pnpm.cmd lint:scripts -- scripts"],
      command: "C:\\Windows\\System32\\cmd.exe",
      options: {
        cwd: undefined,
        detached: false,
        env: {},
        shell: false,
        stdio: "inherit",
        windowsVerbatimArguments: true,
      },
    });
  });

  it("uses Windows shell normalization when the platform override is win32", () => {
    expect(
      createManagedCommandSpawnSpec({
        args: ["-p", "packages/plugin-sdk/tsconfig.json", "--listFilesOnly", "--noEmit"],
        bin: "C:\\repo\\node_modules\\.bin\\tsgo",
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        env: {},
        platform: "win32",
      }),
    ).toEqual({
      args: [
        "/d",
        "/s",
        "/c",
        "C:\\repo\\node_modules\\.bin\\tsgo -p packages/plugin-sdk/tsconfig.json --listFilesOnly --noEmit",
      ],
      command: "C:\\Windows\\System32\\cmd.exe",
      options: {
        cwd: undefined,
        detached: false,
        env: {},
        shell: false,
        stdio: "inherit",
        windowsVerbatimArguments: true,
      },
    });
  });

  it("preserves explicit non-shell Windows subprocesses", () => {
    expect(
      createManagedCommandSpawnSpec({
        args: ["--version"],
        bin: "node.exe",
        platform: "win32",
        shell: false,
      }),
    ).toEqual({
      args: ["--version"],
      command: "node.exe",
      options: {
        cwd: undefined,
        detached: false,
        env: undefined,
        shell: false,
        stdio: "inherit",
        windowsVerbatimArguments: undefined,
      },
    });
  });

  it("rejects unsafe Windows shell argv instead of passing them to Node shell mode", () => {
    expect(() =>
      createManagedCommandSpawnSpec({
        args: ["build && pnpm test"],
        bin: "pnpm.cmd",
        platform: "win32",
        shell: true,
      }),
    ).toThrow("unsafe Windows cmd.exe argument detected");
  });

  it("signals Windows managed process trees with taskkill", () => {
    withDefaultWindowsSystemRoot(() => {
      const child = {
        kill: vi.fn(),
        pid: 12345,
      };
      const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

      terminateManagedChild(child, "SIGTERM", {
        platform: "win32",
        runTaskkill,
      });
      expect(runTaskkill).toHaveBeenNthCalledWith(1, taskkillPath, ["/PID", "12345", "/T"], {
        killSignal: "SIGKILL",
        stdio: "ignore",
        timeout: 10_000,
      });

      terminateManagedChild(child, "SIGKILL", {
        platform: "win32",
        runTaskkill,
      });
      expect(runTaskkill).toHaveBeenNthCalledWith(2, taskkillPath, ["/PID", "12345", "/T", "/F"], {
        killSignal: "SIGKILL",
        stdio: "ignore",
        timeout: 10_000,
      });
      expect(child.kill).not.toHaveBeenCalled();
    });
  });

  it("force-kills Windows managed process trees when graceful taskkill fails", () => {
    withDefaultWindowsSystemRoot(() => {
      const child = {
        kill: vi.fn(),
        pid: 12345,
      };
      const runTaskkill = vi
        .fn()
        .mockReturnValueOnce({ error: undefined, status: 1 })
        .mockReturnValueOnce({ error: undefined, status: 0 });

      terminateManagedChild(child, "SIGTERM", {
        platform: "win32",
        runTaskkill,
      });

      expect(runTaskkill).toHaveBeenNthCalledWith(1, taskkillPath, ["/PID", "12345", "/T"], {
        killSignal: "SIGKILL",
        stdio: "ignore",
        timeout: 10_000,
      });
      expect(runTaskkill).toHaveBeenNthCalledWith(2, taskkillPath, ["/PID", "12345", "/T", "/F"], {
        killSignal: "SIGKILL",
        stdio: "ignore",
        timeout: 10_000,
      });
      expect(child.kill).not.toHaveBeenCalled();
    });
  });

  it("preserves stdio-only taskkill and falls back after both trusted attempts fail", () => {
    withDefaultWindowsSystemRoot(() => {
      const child = { kill: vi.fn(() => true), pid: 12345 };
      const runTaskkill = vi.fn(() => ({ error: undefined, status: 1 }));

      expect(
        terminateManagedChild(child, "SIGTERM", {
          platform: "win32",
          runTaskkill,
          taskkillTimeoutMs: null,
        }),
      ).toEqual({ processTreeState: "indeterminate" });
      expect(runTaskkill).toHaveBeenNthCalledWith(1, taskkillPath, ["/PID", "12345", "/T"], {
        stdio: "ignore",
      });
      expect(runTaskkill).toHaveBeenNthCalledWith(2, taskkillPath, ["/PID", "12345", "/T", "/F"], {
        stdio: "ignore",
      });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });

  it("preserves direct Windows signaling when a caller does not own taskkill", () => {
    const child = { kill: vi.fn(() => true), pid: 12345 };
    const runTaskkill = vi.fn();

    expect(
      terminateManagedChild(child, "SIGTERM", {
        platform: "win32",
        runTaskkill,
        useWindowsTaskkill: false,
      }),
    ).toEqual({ processTreeState: "signaled" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(runTaskkill).not.toHaveBeenCalled();
  });

  it("signals POSIX process groups without signaling their leaders twice", () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const child = { kill: vi.fn(), pid: 12345 };

    try {
      expect(terminateManagedChild(child, "SIGTERM", { platform: "linux" })).toEqual({
        processTreeState: "signaled",
      });
      expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it.each([
    { code: "ESRCH", processGroupFallback: "nonmissing" as const },
    { code: "EPERM", processGroupFallback: "never" as const },
  ])("preserves caller-owned direct fallback for $code", ({ code, processGroupFallback }) => {
    const error = Object.assign(new Error("process group unavailable"), { code });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw error;
    });
    const child = { kill: vi.fn(), pid: 12345 };

    try {
      terminateManagedChild(child, "SIGTERM", { platform: "linux", processGroupFallback });
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("preserves distinct group permission policies and verifies the leader when requested", () => {
    const permissionError = Object.assign(new Error("group signal denied"), { code: "EPERM" });
    const child = { exitCode: null, pid: 12345, signalCode: null };
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === -12345) {
        throw permissionError;
      }
      return true;
    });

    try {
      expect(
        inspectManagedProcessGroup(child, { errorPolicy: "alive-on-eperm", platform: "linux" }),
      ).toBe("live");
      expect(
        inspectManagedProcessGroup(child, { errorPolicy: "indeterminate", platform: "linux" }),
      ).toBe("indeterminate");
      expect(
        inspectManagedProcessGroup(child, { errorPolicy: "verify-leader", platform: "linux" }),
      ).toBe("live");
      expect(kill).toHaveBeenCalledWith(12345, 0);
      expect(
        inspectManagedProcessGroup(
          { ...child, exitCode: 0 },
          { errorPolicy: "verify-leader", platform: "linux" },
        ),
      ).toBe("dead");
    } finally {
      kill.mockRestore();
    }
  });

  it("inspects direct child liveness only when nongroup cleanup explicitly requires it", () => {
    const child = { exitCode: null, pid: 12345, signalCode: null };

    expect(
      inspectManagedProcessGroup(child, { errorPolicy: "alive-on-eperm", platform: "win32" }),
    ).toBe("dead");
    expect(
      inspectManagedProcessGroup(child, {
        errorPolicy: "alive-on-eperm",
        inspectLeaderWhenNoGroup: true,
        platform: "win32",
      }),
    ).toBe("live");
    expect(
      inspectManagedProcessGroup(
        { ...child, exitCode: 0 },
        { errorPolicy: "alive-on-eperm", inspectLeaderWhenNoGroup: true, platform: "win32" },
      ),
    ).toBe("dead");
  });

  it("bounds process-group waiting when the group remains live", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      await expect(
        waitForManagedProcessGroupExit({ pid: 12345 }, 5, {
          errorPolicy: "alive-on-eperm",
          platform: "linux",
          pollIntervalMs: 1,
        }),
      ).resolves.toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

  it("signals the direct child when process-group ownership is disabled", () => {
    const child = { kill: vi.fn(() => true), pid: 12345 };

    expect(
      terminateManagedChild(child, "SIGTERM", {
        platform: "linux",
        useProcessGroup: false,
      }),
    ).toEqual({ processTreeState: "signaled" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("reports process-group signal errors before falling back to the direct child", () => {
    const originalKill = process.kill.bind(process);
    const groupError = Object.assign(new Error("group signal denied"), { code: "EPERM" });
    const child = { kill: vi.fn(() => true), pid: 12345 };
    const onProcessGroupSignalError = vi.fn();
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -12345 && signal === "SIGTERM") {
        throw groupError;
      }
      return originalKill(pid, signal);
    }) as typeof process.kill;

    try {
      expect(
        terminateManagedChild(child, "SIGTERM", {
          onProcessGroupSignalError,
          platform: "linux",
        }),
      ).toEqual({ processTreeState: "signaled" });
    } finally {
      process.kill = originalKill;
    }

    expect(onProcessGroupSignalError).toHaveBeenCalledWith(groupError);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each(["ignore", "inherit"] as const)(
    "shares listeners across parallel %s commands even when another spawn throws",
    async (stdio) => {
      const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
      const baseline = new Map(signals.map((signal) => [signal, process.listenerCount(signal)]));
      const warnings: string[] = [];
      const onWarning = (warning: Error) => {
        if (warning.name === "MaxListenersExceededWarning") {
          warnings.push(warning.message);
        }
      };
      process.on("warning", onWarning);
      const stdout = vi.spyOn(process.stdout, "write");
      const stderr = vi.spyOn(process.stderr, "write");
      const children: Array<Parameters<typeof terminateManagedChild>[0]> = [];
      let readyCount = 0;
      const commands = Array.from({ length: 12 }, (_, index) =>
        runManagedCommand({
          args: [
            "-e",
            `process.stdout.write('managed-parallel-out-${index}-π\\n'); process.stderr.write('managed-parallel-err-${index}-π\\n'); setTimeout(() => {}, 10_000);`,
          ],
          bin: process.execPath,
          shell: false,
          stdio,
          onReady: (child) => {
            children.push(child);
            readyCount += 1;
          },
        }),
      );

      try {
        await waitFor(() => readyCount === commands.length);
        await expect(runManagedCommand({ bin: "invalid\0command" })).rejects.toMatchObject({
          code: "ERR_INVALID_ARG_VALUE",
        });
        for (const signal of signals) {
          expect(process.listenerCount(signal)).toBe((baseline.get(signal) ?? 0) + 1);
        }
        if (stdio === "inherit" && process.platform !== "win32") {
          for (const [output, kind] of [
            [stdout, "out"],
            [stderr, "err"],
          ] as const) {
            const lines = () =>
              output.mock.calls
                .map(([chunk]) => String(chunk))
                .join("")
                .split("\n")
                .filter((line) => line.startsWith(`managed-parallel-${kind}-`))
                .toSorted();
            await waitFor(() => lines().length === commands.length);
            expect(lines()).toEqual(
              Array.from(
                { length: 12 },
                (_, index) => `managed-parallel-${kind}-${index}-π`,
              ).toSorted(),
            );
          }
        }
      } finally {
        for (const child of children) {
          terminateManagedChild(child, "SIGTERM");
        }
        await Promise.all(commands);
        process.off("warning", onWarning);
        stdout.mockRestore();
        stderr.mockRestore();
      }

      expect(warnings).toEqual([]);
      expect(children.every((child) => !child.pid || !isProcessAlive(child.pid))).toBe(true);
      for (const signal of signals) {
        expect(process.listenerCount(signal)).toBe(baseline.get(signal) ?? 0);
      }
    },
  );

  it.each([
    { bin: "invalid\0command", code: "ERR_INVALID_ARG_VALUE" },
    { bin: "/missing/openclaw-test-command", code: "ENOENT" },
  ])("restores signal listeners after a $code spawn failure", async ({ bin, code }) => {
    const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
    const baseline = signals.map((signal) => process.listenerCount(signal));
    await expect(runManagedCommand({ bin, shell: false })).rejects.toMatchObject({ code });
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(baseline);
  });

  it("times out and kills managed command descendants", async () => {
    const dir = createTempDir("openclaw-managed-timeout-");
    const childPath = path.join(dir, "child.mjs");
    const childPidPath = path.join(dir, "child.pid");
    const descendantPidPath = path.join(dir, "descendant.pid");
    const signalPath = path.join(dir, "signal.txt");
    fs.writeFileSync(
      childPath,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

process.on("SIGTERM", () => fs.writeFileSync(process.argv[4], "SIGTERM\\n"));
setInterval(() => {}, 1_000);
spawn(process.execPath, [
  "-e",
  ${JSON.stringify(`
const fs = require("node:fs");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
${publishReadyPidScript(1)}
`)},
  process.argv[3],
], { stdio: "ignore" });
${publishReadyPidScript(2)}
`,
      "utf8",
    );

    const releaseAndWait = startProcessWatchdogFixture(() =>
      expect(
        runManagedCommand({
          bin: process.execPath,
          args: [childPath, childPidPath, descendantPidPath, signalPath],
          shell: false,
          stdio: "ignore",
          timeoutKillGraceMs: 100,
          timeoutMs: 500,
        }),
      ).rejects.toMatchObject({ code: "ETIMEDOUT" }),
    );
    const killSpy = vi.spyOn(process, "kill");
    let childPid = 0;
    let descendantPid = 0;
    try {
      childPid = await waitForPidFile(childPidPath, 2_000);
      descendantPid = await waitForPidFile(descendantPidPath, 2_000);
      expect(isProcessAlive(childPid)).toBe(true);
      expect(isProcessAlive(descendantPid)).toBe(true);
      await releaseAndWait();
      if (process.platform !== "win32") {
        expect(fs.readFileSync(signalPath, "utf8")).toBe("SIGTERM\n");
        expect(killSpy).toHaveBeenCalledWith(-childPid, "SIGKILL");
      }
      expect(isProcessAlive(childPid)).toBe(false);
      expect(isProcessAlive(descendantPid)).toBe(false);
    } finally {
      try {
        await releaseAndWait();
      } finally {
        killSpy.mockRestore();
        try {
          if (childPid && isProcessAlive(childPid)) {
            process.kill(childPid, "SIGKILL");
            await waitForDead(childPid, 2_000);
          }
        } finally {
          if (descendantPid && isProcessAlive(descendantPid)) {
            process.kill(descendantPid, "SIGKILL");
            await waitForDead(descendantPid, 2_000);
          }
        }
      }
    }
  });

  posixIt("lets a timed-out command handle SIGTERM before forced cleanup", async () => {
    const dir = createTempDir("openclaw-managed-timeout-grace-");
    const childPath = path.join(dir, "child.mjs");
    const signalPath = path.join(dir, "signal.txt");
    fs.writeFileSync(
      childPath,
      `
import fs from "node:fs";
process.on("SIGTERM", () => {
  fs.writeFileSync(process.argv[2], "SIGTERM\\n");
  process.exit(0);
});
setInterval(() => {}, 1_000);
`,
      "utf8",
    );

    await expect(
      runManagedCommand({
        args: [childPath, signalPath],
        bin: process.execPath,
        shell: false,
        stdio: "ignore",
        timeoutKillGraceMs: 10_000,
        timeoutMs: 500,
      }),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(fs.readFileSync(signalPath, "utf8")).toBe("SIGTERM\n");
  });

  posixIt("force-kills descendants after the timed-out leader exits during grace", async () => {
    const dir = createTempDir("openclaw-managed-timeout-leader-exit-");
    const childPath = path.join(dir, "child.mjs");
    const descendantPidPath = path.join(dir, "descendant.pid");
    const signalPath = path.join(dir, "signal.txt");
    fs.writeFileSync(
      childPath,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

const descendant = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);",
], { stdio: "ignore" });
fs.writeFileSync(process.argv[2], String(descendant.pid));
process.on("SIGTERM", () => {
  fs.writeFileSync(process.argv[3], "SIGTERM\\n");
  process.exit(0);
});
setInterval(() => {}, 1_000);
`,
      "utf8",
    );

    let descendantPid = 0;
    try {
      const startedAt = Date.now();
      await expect(
        runManagedCommand({
          args: [childPath, descendantPidPath, signalPath],
          bin: process.execPath,
          shell: false,
          stdio: "ignore",
          timeoutForceKillOnLeaderExit: true,
          timeoutKillGraceMs: 10_000,
          timeoutMs: 500,
        }),
      ).rejects.toMatchObject({ code: "ETIMEDOUT" });

      descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
      expect(fs.readFileSync(signalPath, "utf8")).toBe("SIGTERM\n");
      expect(isProcessAlive(descendantPid)).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      if (descendantPid && isProcessAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });

  it("uses a wall timeout even while the child emits progress", async () => {
    const startedAt = Date.now();
    await expect(
      runManagedCommand({
        bin: process.execPath,
        args: ["-e", "setInterval(() => process.stderr.write('retrying\\n'), 20)"],
        shell: false,
        stdio: "ignore",
        timeoutMs: 200,
      }),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("refuses strict Windows commands before spawning an unverifiable tree", async () => {
    const onReady = vi.fn();
    const runTaskkill = vi.fn();
    await expect(
      runManagedCommand({
        bin: process.execPath,
        args: ["-e", "process.exit(0)"],
        onReady,
        platform: "win32",
        requireProcessTreeExit: true,
        runTaskkill,
        shell: false,
        stdio: "ignore",
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      code: "EPROCESS_TREE_VERIFICATION_UNSUPPORTED",
    });
    expect(onReady).not.toHaveBeenCalled();
    expect(runTaskkill).not.toHaveBeenCalled();
  });

  it("fails closed when Windows taskkill cannot verify timeout cleanup", async () => {
    const originalSystemRoot = process.env.SystemRoot;
    const originalWindir = process.env.WINDIR;
    let childPid = 0;
    const runTaskkill = vi.fn(() => ({
      error: Object.assign(new Error("taskkill timed out"), { code: "ETIMEDOUT" }),
      status: null,
    }));
    try {
      process.env.SystemRoot = "C:\\Windows";
      delete process.env.WINDIR;
      await expect(
        runManagedCommand({
          bin: process.execPath,
          args: ["-e", "setInterval(() => {}, 1_000)"],
          onReady: (child) => {
            childPid = expectProcessPid(child.pid);
          },
          platform: "win32",
          runTaskkill,
          shell: false,
          stdio: "ignore",
          timeoutMs: 200,
        }),
      ).rejects.toMatchObject({
        code: "EPROCESSGROUP_CLEANUP_FAILED",
        manualRecoveryRequired: true,
        processTreeState: "indeterminate",
      });

      expect(runTaskkill).toHaveBeenCalledWith(
        taskkillPath,
        ["/PID", String(childPid), "/T", "/F"],
        {
          killSignal: "SIGKILL",
          stdio: "ignore",
          timeout: 10_000,
        },
      );
      await waitFor(() => !isProcessAlive(childPid));
    } finally {
      restoreEnvValue("SystemRoot", originalSystemRoot);
      restoreEnvValue("WINDIR", originalWindir);
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
    }
  });

  posixIt("does not wait indefinitely when a timed-out child omits close", async () => {
    const startedAt = Date.now();
    let childPid = 0;
    await expect(
      runManagedCommand({
        bin: process.execPath,
        args: ["-e", "setInterval(() => {}, 1_000)"],
        onReady: (child) => {
          childPid = expectProcessPid(child.pid);
          child.removeAllListeners("close");
        },
        shell: false,
        stdio: "ignore",
        timeoutMs: 200,
      }),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(isProcessAlive(childPid)).toBe(false);
  });

  posixIt.each(["before", "after"])(
    "applies the strict wall deadline only before output closure (deadline %s close)",
    async (deadline) => {
      const dir = fs.realpathSync(createTempDir("openclaw-managed-deadline-"));
      const controllerPath = path.join(dir, "controller.mjs");
      const helperUrl = pathToFileURL(path.resolve("scripts/lib/managed-child-process.mts")).href;
      // Only this controller mocks time; child I/O and concurrent tests keep real clocks.
      fs.writeFileSync(
        controllerPath,
        `
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { mock } from "node:test";

const [role, helperUrl, deadline] = process.argv.slice(2);
const file = (name) => new URL(name, import.meta.url);
if (role === "leaf") {
  const timer = setInterval(() => {
    if (fs.existsSync(file("release"))) clearInterval(timer);
  }, 5);
  process.send("ready");
  process.disconnect();
} else if (role === "leader") {
  const child = spawn(process.execPath, [import.meta.filename, "leaf", helperUrl], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  fs.writeFileSync(file("leaf.pid"), String(child.pid));
  child.once("message", () => process.exit(0));
} else {
  const { inspectManagedProcessGroup, runManagedCommand } = await import(helperUrl);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let child, exited, closed;
    const result = runManagedCommand({
      bin: process.execPath,
      args: [import.meta.filename, "leader", helperUrl],
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: 1_000,
      requireProcessTreeExit: true,
      onReady(owned) {
        child = owned;
        fs.writeFileSync(file("leader.pid"), String(child.pid));
        exited = once(child, "exit");
        closed = once(child, "close");
      },
    }).catch((error) => error.code);
    await exited;
    await new Promise(setImmediate);
    assert.equal(child.exitCode, 0);
    assert.equal(inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" }), "dead");
    assert.equal(child.stdout.closed, false);
    assert.equal(child.stderr.closed, false);
    mock.timers.tick(deadline === "before" ? 1_000 : 975);
    fs.writeFileSync(file("release"), "release");
    await closed;
    mock.timers.tick(25);
    const outcome = await result;
    console.log(JSON.stringify({ outcome, stdoutClosed: child.stdout.closed, stderrClosed: child.stderr.closed }));
    assert.equal(outcome, deadline === "before" ? "ETIMEDOUT" : 0);
  } finally {
    mock.timers.reset();
  }
}
`,
      );
      const controller = spawn(
        process.execPath,
        [controllerPath, "controller", helperUrl, deadline],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      controller.stderr!.on("data", (chunk) => {
        stderr += String(chunk);
      });
      await runQaGatewayFixture(
        async () => {
          expect(await waitForChildClose(controller), stderr).toEqual({ code: 0, signal: null });
        },
        () => {
          if (controller.exitCode === null && controller.signalCode === null) {
            controller.kill("SIGKILL");
          }
        },
        () => waitForDead(expectProcessPid(controller.pid), 2_000),
        ...["leader", "leaf"].map((role) => async () => {
          const pidPath = path.join(dir, `${role}.pid`);
          if (fs.existsSync(pidPath)) {
            await killFixturePid(Number(fs.readFileSync(pidPath, "utf8")), true);
          }
        }),
      );
    },
  );

  posixIt.concurrent.for(["timeout", "sibling failure", "normal exit", "normal drainage"])(
    "joins escaped output or fails closed within the cleanup budget after $0",
    { timeout: 25_000 },
    async (mode, { expect: expectCase }) => {
      // Concurrent rows own their roots; the shared afterEach can run while a sibling is alive.
      const dir = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "openclaw-managed-held-output-"),
      );
      const pidPath = path.join(dir, "escaped.pid");
      const parentPidPath = path.join(dir, "parent.pid");
      const failPath = path.join(dir, "fail");
      const normalExit = mode === "normal exit" || mode === "normal drainage";
      const leaf = `
const fs = require('node:fs');
process.on('SIGTERM', () => {});
const keepAlive = setInterval(() => {
  if (${mode === "normal drainage"} && fs.existsSync(${JSON.stringify(failPath)})) {
    clearInterval(keepAlive);
    process.stdout.write('drained-out');
    process.stderr.write('drained-err');
  }
}, ${mode === "normal drainage" ? 5 : 1000});
fs.writeFileSync(${JSON.stringify(pidPath)} + '.tmp', String(process.pid));
fs.renameSync(${JSON.stringify(pidPath)} + '.tmp', ${JSON.stringify(pidPath)});
process.send('ready');
process.disconnect();
`;
      const args = [
        "-e",
        `
require('node:fs').writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid));
const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
child.once('message', () => { ${normalExit ? "process.exit(0);" : ""} });
`,
      ];
      let child: ReturnType<typeof spawn> | undefined;
      let escapedPid = 0;
      let exitedAt = 0;
      let settledAt = 0;
      let stdout = "";
      let stderr = "";
      const abortController = new AbortController();
      let outcome!: Promise<unknown>;
      const releaseAndWait = startProcessWatchdogFixture(() => {
        const command =
          mode !== "sibling failure"
            ? runManagedCommand({
                bin: process.execPath,
                args,
                stdio: ["ignore", "pipe", "pipe"],
                timeoutMs: mode === "timeout" ? 100 : undefined,
                // This row verifies the full pipe-drain budget, not the default TERM grace.
                timeoutKillGraceMs: 100,
                requireProcessTreeExit: normalExit,
                signal: abortController.signal,
                onReady: (owned) => {
                  child = owned;
                  child.stdout?.on("data", (chunk) => {
                    stdout += String(chunk);
                  });
                  child.stderr?.on("data", (chunk) => {
                    stderr += String(chunk);
                  });
                  child.once("exit", () => {
                    exitedAt = Date.now();
                  });
                },
              })
            : runNodeStepsInParallel([
                { label: "blocked", args, timeoutMs: 100, abortKillGraceMs: 100 },
                {
                  label: "primary",
                  args: [
                    "-e",
                    `setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(failPath)})) process.exit(2); }, 5);`,
                  ],
                  timeoutMs: 30_000,
                },
              ]);
        // Observe sibling cancellation without releasing the blocked watchdog.
        outcome = command
          .catch((error: unknown) => error)
          .finally(() => {
            settledAt = Date.now();
          });
        return outcome;
      });
      try {
        escapedPid = await waitForPidFile(pidPath, 10_000);
        const parentPid = await waitForPidFile(parentPidPath, 10_000);
        const canceledAt = Date.now();
        if (mode === "normal drainage") {
          await waitFor(() => exitedAt !== 0);
          expectCase(child?.exitCode).toBe(0);
          expectCase(child?.stdout?.closed).toBe(false);
          expectCase(child?.stderr?.closed).toBe(false);
          expectCase(settledAt).toBe(0);
          fs.writeFileSync(failPath, "drain");
        }
        if (mode === "sibling failure") {
          fs.writeFileSync(failPath, "fail");
        } else if (mode === "timeout") {
          await releaseAndWait();
        } else {
          await waitFor(() => settledAt !== 0, 7_000);
        }
        const failure = await outcome;
        const cleanupFailure = {
          code: "EPROCESSGROUP_CLEANUP_FAILED",
          processTreeState: "indeterminate",
        };
        if (mode === "normal drainage") {
          expectCase(failure).toBe(0);
          expectCase(stdout).toBe("drained-out");
          expectCase(stderr).toBe("drained-err");
          expectCase(child?.stdout?.closed).toBe(true);
          expectCase(child?.stderr?.closed).toBe(true);
        } else if (mode !== "sibling failure") {
          expectCase(failure).toMatchObject(cleanupFailure);
          expectCase(child?.stdout?.destroyed).toBe(true);
          expectCase(child?.stderr?.destroyed).toBe(true);
          if (mode === "normal exit") {
            expectCase(child?.exitCode).toBe(0);
            expectCase(settledAt - exitedAt).toBeGreaterThanOrEqual(5_000);
            expectCase(settledAt - exitedAt).toBeLessThan(7_000);
          }
        } else {
          expectCase(failure).toBeInstanceOf(AggregateError);
          expectCase(failure).toMatchObject({
            message: "primary failed with exit code 2; sibling cleanup could not be verified",
            errors: [{ message: "primary failed with exit code 2" }, cleanupFailure],
          });
        }
        expectCase(Date.now() - canceledAt).toBeLessThan(12_000);
        expectCase(isProcessAlive(parentPid)).toBe(false);
        if (mode === "normal drainage") {
          await waitForDead(escapedPid, 2_000);
        }
        expectCase(isProcessAlive(escapedPid)).toBe(mode !== "normal drainage");
      } finally {
        fs.writeFileSync(failPath, "fail");
        abortController.abort();
        await releaseAndWait();
        if (!escapedPid && fs.existsSync(pidPath)) {
          escapedPid = Number(fs.readFileSync(pidPath, "utf8"));
        }
        if (escapedPid && isProcessAlive(escapedPid)) {
          process.kill(escapedPid, "SIGKILL");
          await waitForDead(escapedPid, 2_000);
        }
        if (child?.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await waitForDead(expectProcessPid(child.pid), 2_000);
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  posixIt("waits through transient indeterminate process-group state", async () => {
    const originalKill = process.kill.bind(process);
    let childPid = 0;
    let injectedIndeterminate = false;
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -childPid && signal === 0 && !injectedIndeterminate) {
        injectedIndeterminate = true;
        throw Object.assign(new Error("transient process-group state"), { code: "EPERM" });
      }
      return originalKill(pid, signal);
    }) as typeof process.kill;

    try {
      await expect(
        runManagedCommand({
          bin: process.execPath,
          args: ["-e", "setInterval(() => {}, 1_000)"],
          onReady: (child) => {
            childPid = expectProcessPid(child.pid);
          },
          shell: false,
          stdio: "ignore",
          timeoutMs: 200,
        }),
      ).rejects.toMatchObject({ code: "ETIMEDOUT" });
    } finally {
      process.kill = originalKill;
    }

    expect(injectedIndeterminate).toBe(true);
    expect(isProcessAlive(childPid)).toBe(false);
  });

  posixIt("accepts a process group that vanishes before its cleanup signal", async () => {
    const originalKill = process.kill.bind(process);
    let childPid = 0;
    let injectedLiveGroup = false;
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -childPid && signal === 0 && !injectedLiveGroup) {
        injectedLiveGroup = true;
        return true;
      }
      return originalKill(pid, signal);
    }) as typeof process.kill;

    try {
      await expect(
        runManagedCommand({
          bin: process.execPath,
          args: ["-e", "process.exit(0)"],
          onReady: (child) => {
            childPid = expectProcessPid(child.pid);
          },
          requireProcessTreeExit: true,
          shell: false,
          stdio: "ignore",
          timeoutMs: 1_000,
        }),
      ).resolves.toBe(0);
    } finally {
      process.kill = originalKill;
    }

    expect(injectedLiveGroup).toBe(true);
    expect(isProcessAlive(childPid)).toBe(false);
  });

  it("allows bounded retry output to complete", async () => {
    await expect(
      runManagedCommand({
        bin: process.execPath,
        args: [
          "-e",
          "process.stderr.write('network retry 1\\n'); setTimeout(() => process.exit(0), 100)",
        ],
        shell: false,
        stdio: "ignore",
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(0);
  });

  posixIt("allows strict normal long-running work to complete", async () => {
    await expect(
      runManagedCommand({
        bin: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(0), 200)"],
        requireProcessTreeExit: true,
        shell: false,
        stdio: "ignore",
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(0);
  });

  it("cleans up the child when onReady throws", async () => {
    let childPid = 0;
    await expect(
      runManagedCommand({
        bin: process.execPath,
        args: ["-e", "setInterval(() => {}, 1_000)"],
        onReady: (child) => {
          childPid = expectProcessPid(child.pid);
          throw new Error("setup failed");
        },
        shell: false,
        stdio: "ignore",
      }),
    ).rejects.toThrow("setup failed");
    expect(isProcessAlive(childPid)).toBe(false);
  });

  posixIt.each([
    { runner: "managed", output: "ignore" },
    { runner: "managed", output: "inherit" },
    { runner: "preparation", output: "ignore" },
    { runner: "preparation", output: "inherit" },
  ] as const)(
    "rejects and drains descendants left after a successful leader exit through $runner ($output output)",
    async ({ runner, output }) => {
      const dir = createTempDir("openclaw-managed-lingering-");
      const descendantPidPath = path.join(dir, "descendant.pid");
      const args = [
        "-e",
        `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [
  "-e",
  "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.send('ready'); process.disconnect(); setInterval(() => {}, 1000)",
  process.argv[1],
], { stdio: ["ignore", ${JSON.stringify(output)}, ${JSON.stringify(output)}, "ipc"] });
child.once("message", () => process.exit(0));
`,
        descendantPidPath,
      ];
      try {
        const command =
          runner === "preparation"
            ? runNodeStep("lingering-prep", args, 1_000)
            : runManagedCommand({
                bin: process.execPath,
                args,
                requireProcessTreeExit: true,
                shell: false,
                stdio: output,
                timeoutMs: 1_000,
              });
        const failure = await command.catch((error: unknown) => error);
        const descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
        expect.soft(failure).toMatchObject({ code: "EPROCESSGROUP_CLEANUP_FAILED" });
        expect
          .soft(
            isProcessAlive(descendantPid),
            `descendant ${descendantPid} must be absent at settlement`,
          )
          .toBe(false);
      } finally {
        // Recover the recorded PID even when an unexpected success fails the assertion.
        if (fs.existsSync(descendantPidPath)) {
          const descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
          if (Number.isSafeInteger(descendantPid) && descendantPid > 1) {
            if (isProcessAlive(descendantPid)) {
              process.kill(descendantPid, "SIGKILL");
            }
            await waitForDead(descendantPid, 2_000);
          }
        }
      }
    },
  );

  posixIt(
    "kills managed child process group descendants when the runner is terminated",
    async () => {
      const dir = createTempDir("openclaw-managed-child-");
      const childPath = path.join(dir, "child.mjs");
      const runnerPath = path.join(dir, "runner.mjs");
      const childPidPath = path.join(dir, "child.pid");
      const descendantPidPath = path.join(dir, "descendant.pid");
      const runnerReadyPath = path.join(dir, "runner.ready");
      const helperUrl = pathToFileURL(path.resolve("scripts/lib/managed-child-process.mts")).href;

      fs.writeFileSync(
        childPath,
        `
	import { spawn } from "node:child_process";
	import fs from "node:fs";

	spawn(process.execPath, [
	  "-e",
	  ${JSON.stringify(`
const fs = require("node:fs");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
${publishReadyPidScript(1)}
`)},
	  process.argv[3],
	], { stdio: "ignore" });
	for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
	  process.on(signal, () => process.exit(0));
	}
setInterval(() => {}, 1_000);
${publishReadyPidScript(2)}
`,
        "utf8",
      );
      fs.writeFileSync(
        runnerPath,
        `
import fs from "node:fs";
import { runManagedCommand } from ${JSON.stringify(helperUrl)};

	process.exitCode = await runManagedCommand({
	  bin: process.execPath,
	  args: [${JSON.stringify(childPath)}, ${JSON.stringify(childPidPath)}, ${JSON.stringify(descendantPidPath)}],
	  stdio: "ignore",
	  onReady: () => fs.writeFileSync(${JSON.stringify(runnerReadyPath)}, "1"),
	});
`,
        "utf8",
      );

      const runner = spawn(process.execPath, [runnerPath], {
        stdio: "ignore",
      });
      const runnerPid = expectProcessPid(runner.pid);
      let childPid = 0;
      let descendantPid = 0;

      try {
        await waitFor(() => fs.existsSync(runnerReadyPath));
        await waitFor(() => fs.existsSync(childPidPath));
        await waitFor(() => fs.existsSync(descendantPidPath));
        childPid = Number(fs.readFileSync(childPidPath, "utf8"));
        descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
        expect(Number.isInteger(childPid)).toBe(true);
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(isProcessAlive(childPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);

        process.kill(runnerPid, "SIGTERM");
        const result = await waitForClose(runner);

        expect(result).toEqual({ code: 143, signal: null });
        await waitFor(() => !isProcessAlive(childPid), 1_500);
        await waitFor(() => !isProcessAlive(descendantPid), 1_500);
      } finally {
        if (isProcessAlive(runnerPid)) {
          process.kill(runnerPid, "SIGKILL");
        }
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );
});

async function waitFor(condition: () => boolean, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await delay(5);
  }
}

async function waitForClose(child: ReturnType<typeof spawn>) {
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") {
    return true;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // kill(pid, 0) also succeeds for a terminated process awaiting reaping.
    return stat.charAt(stat.lastIndexOf(")") + 2) !== "Z";
  } catch {
    return false;
  }
}
