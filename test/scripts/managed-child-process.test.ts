// Managed Child Process tests cover managed child process script behavior.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createManagedCommandSpawnSpec,
  runManagedCommand,
  signalExitCode,
  terminateManagedChild,
} from "../../scripts/lib/managed-child-process.mjs";
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
        args: ["lint:scripts", "--", "scripts"],
        bin: "pnpm.cmd",
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        env: {},
        platform: "win32",
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
        stdio: "ignore",
      });

      terminateManagedChild(child, "SIGKILL", {
        platform: "win32",
        runTaskkill,
      });
      expect(runTaskkill).toHaveBeenNthCalledWith(2, taskkillPath, ["/PID", "12345", "/T", "/F"], {
        stdio: "ignore",
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
        stdio: "ignore",
      });
      expect(runTaskkill).toHaveBeenNthCalledWith(2, taskkillPath, ["/PID", "12345", "/T", "/F"], {
        stdio: "ignore",
      });
      expect(child.kill).not.toHaveBeenCalled();
    });
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

const descendant = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 5_000); setInterval(() => {}, 1000);",
], { stdio: "ignore" });
fs.writeFileSync(process.argv[2], String(process.pid));
fs.writeFileSync(process.argv[3], String(descendant.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
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
      await waitFor(() => !isProcessAlive(childPid), 1_500);
      await waitFor(() => !isProcessAlive(descendantPid), 1_500);
    } finally {
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
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
      const helperUrl = pathToFileURL(path.resolve("scripts/lib/managed-child-process.mjs")).href;

      fs.writeFileSync(
        childPath,
        `
	import { spawn } from "node:child_process";
	import fs from "node:fs";

	const descendant = spawn(process.execPath, [
	  "-e",
	  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
	], { stdio: "ignore" });
	fs.writeFileSync(process.argv[2], String(process.pid));
	fs.writeFileSync(process.argv[3], String(descendant.pid));
	for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
	  process.on(signal, () => process.exit(0));
	}
setInterval(() => {}, 1_000);
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
