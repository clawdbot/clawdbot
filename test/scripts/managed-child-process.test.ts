// Managed Child Process tests cover managed child process script behavior.
import { spawn } from "node:child_process";
import fs from "node:fs";
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

// Call after installing handlers and keepalive: existence must mean a complete, ready PID.
function publishReadyPidScript(argIndex: number): string {
  return `
const pidPath = process.argv[${argIndex}];
fs.writeFileSync(pidPath + ".tmp", String(process.pid));
fs.renameSync(pidPath + ".tmp", pidPath);
`;
}

describe("managed-child-process", () => {
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
        args: ["-p", "tsconfig.plugin-sdk.dts.json", "--listFilesOnly", "--noEmit"],
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
        "C:\\repo\\node_modules\\.bin\\tsgo -p tsconfig.plugin-sdk.dts.json --listFilesOnly --noEmit",
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

  it("shares process signal listeners across parallel managed commands", async () => {
    const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
    const baseline = new Map(signals.map((signal) => [signal, process.listenerCount(signal)]));
    const children: Array<Parameters<typeof terminateManagedChild>[0]> = [];
    let readyCount = 0;
    const commands = Array.from({ length: 12 }, () =>
      runManagedCommand({
        args: ["-e", "setTimeout(() => {}, 10_000)"],
        bin: process.execPath,
        shell: false,
        stdio: "ignore",
        onReady: (child) => {
          children.push(child);
          readyCount += 1;
        },
      }),
    );

    try {
      await waitFor(() => readyCount === commands.length);
      for (const signal of signals) {
        expect(process.listenerCount(signal)).toBe((baseline.get(signal) ?? 0) + 1);
      }
    } finally {
      for (const child of children) {
        terminateManagedChild(child, "SIGTERM");
      }
      await Promise.all(commands);
    }

    for (const signal of signals) {
      expect(process.listenerCount(signal)).toBe(baseline.get(signal) ?? 0);
    }
  });

  it("times out and kills managed command descendants", async () => {
    const dir = createTempDir("openclaw-managed-timeout-");
    const childPath = path.join(dir, "child.mjs");
    const childPidPath = path.join(dir, "child.pid");
    const descendantPidPath = path.join(dir, "descendant.pid");
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
setTimeout(() => process.exit(0), 5_000);
setInterval(() => {}, 1000);
${publishReadyPidScript(1)}
`)},
  process.argv[3],
], { stdio: "ignore" });
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
${publishReadyPidScript(2)}
`,
      "utf8",
    );

    let childPid = 0;
    let descendantPid = 0;
    try {
      await expect(
        runManagedCommand({
          bin: process.execPath,
          args: [childPath, childPidPath, descendantPidPath],
          shell: false,
          stdio: "ignore",
          timeoutMs: 500,
        }),
      ).rejects.toMatchObject({ code: "ETIMEDOUT" });

      childPid = Number(fs.readFileSync(childPidPath, "utf8"));
      descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
      expect(isProcessAlive(childPid)).toBe(false);
      expect(isProcessAlive(descendantPid)).toBe(false);
    } finally {
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
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

  it("allows bounded retry output and normal long-running work to complete", async () => {
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

  posixIt("rejects and drains descendants left after a successful leader exit", async () => {
    const dir = createTempDir("openclaw-managed-lingering-");
    const descendantPidPath = path.join(dir, "descendant.pid");
    let descendantPid = 0;
    try {
      await expect(
        runManagedCommand({
          bin: process.execPath,
          args: [
            "-e",
            `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [
  "-e",
  "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.send('ready'); process.disconnect(); setInterval(() => {}, 1000)",
  process.argv[1],
], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
child.once("message", () => process.exit(0));
`,
            descendantPidPath,
          ],
          requireProcessTreeExit: true,
          shell: false,
          stdio: "ignore",
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({ code: "EPROCESSGROUP_CLEANUP_FAILED" });
      descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
      expect(isProcessAlive(descendantPid)).toBe(false);
    } finally {
      if (descendantPid && isProcessAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });

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
