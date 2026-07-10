// Run With Env tests cover run with env script behavior.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import {
  isRunWithEnvHelpRequest,
  parseRunWithEnvArgs,
  resolveForceKillDelayMs,
  resolveSpawnCommand,
  signalRunWithEnvChild,
} from "../../scripts/run-with-env.mjs";

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

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs = 3_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for child exit"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("run-with-env", () => {
  it("parses leading env assignments before the command separator", () => {
    expect(
      parseRunWithEnvArgs([
        "OPENCLAW_GATEWAY_PROJECT_SHARDS=1",
        "EMPTY=",
        "--",
        "node",
        "scripts/run-vitest.mjs",
        "run",
      ]),
    ).toEqual({
      env: {
        OPENCLAW_GATEWAY_PROJECT_SHARDS: "1",
        EMPTY: "",
      },
      command: "node",
      args: ["scripts/run-vitest.mjs", "run"],
    });
  });

  it("rejects missing command separators", () => {
    expect(() => parseRunWithEnvArgs(["OPENCLAW_GATEWAY_PROJECT_SHARDS=1", "node"])).toThrow(
      /Usage:/u,
    );
  });

  it("prints wrapper help without spawning a command", () => {
    const result = spawnSync(process.execPath, ["scripts/run-with-env.mjs", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: node scripts/run-with-env.mjs");
    expect(result.stderr).toBe("");
  });

  it("keeps command help passthrough after the separator", () => {
    expect(
      isRunWithEnvHelpRequest(["OPENCLAW_GATEWAY_PROJECT_SHARDS=1", "--", "node", "--help"]),
    ).toBe(false);
  });

  it("rejects malformed assignments before spawning", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-with-env.mjs",
        "1INVALID=value",
        "--",
        "node",
        "-e",
        "process.stdout.write('spawned')",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid environment assignment");
  });

  it("uses the current Node executable for bare Node command names", () => {
    const args = ["scripts/run-vitest.mjs"];
    expect(resolveSpawnCommand("node", args, "/usr/bin/node", "linux")).toEqual({
      command: "/usr/bin/node",
      args,
    });
    for (const command of ["node", "NODE", "node.exe", "Node.Exe"]) {
      expect(resolveSpawnCommand(command, args, "C:\\Node24\\node.exe", "win32")).toEqual({
        command: "C:\\Node24\\node.exe",
        args,
      });
    }
  });

  it("preserves platform-specific and explicitly pathed commands", () => {
    const args = ["scripts/run-vitest.mjs"];
    for (const command of ["NODE", "node.exe", "C:\\Tools\\node.exe"]) {
      expect(resolveSpawnCommand(command, args, "/usr/bin/node", "linux")).toEqual({
        command,
        args,
      });
    }
    expect(
      resolveSpawnCommand("C:\\Tools\\node.exe", args, "C:\\Node24\\node.exe", "win32"),
    ).toEqual({
      command: "C:\\Tools\\node.exe",
      args,
    });
  });

  it("rejects malformed force-kill grace configuration before spawning", () => {
    expect(resolveForceKillDelayMs({})).toBe(5_000);
    expect(resolveForceKillDelayMs({ OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: "250" })).toBe(250);
    expect(
      resolveForceKillDelayMs({
        OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: String(MAX_TIMER_TIMEOUT_MS + 1),
      }),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
    for (const value of ["0", "-1", "1e3", "100ms"]) {
      expect(() => resolveForceKillDelayMs({ OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: value })).toThrow(
        "OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS must be a positive integer",
      );
    }

    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-with-env.mjs",
        "OPENCLAW_RUN_WITH_ENV_SIGNAL_TEST=1",
        "--",
        "node",
        "-e",
        "process.stdout.write('spawned')",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: "100ms" },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS must be a positive integer",
    );
  });

  it("signals Windows wrapped command trees with taskkill", () => {
    withDefaultWindowsSystemRoot(() => {
      const child = {
        kill: vi.fn(),
        pid: 12345,
      };
      const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

      signalRunWithEnvChild(child, "SIGTERM", {
        platform: "win32",
        runTaskkill,
      });
      expect(runTaskkill).toHaveBeenNthCalledWith(1, taskkillPath, ["/PID", "12345", "/T"], {
        stdio: "ignore",
      });

      signalRunWithEnvChild(child, "SIGKILL", {
        platform: "win32",
        runTaskkill,
      });
      expect(runTaskkill).toHaveBeenNthCalledWith(2, taskkillPath, ["/PID", "12345", "/T", "/F"], {
        stdio: "ignore",
      });
      expect(child.kill).not.toHaveBeenCalled();
    });
  });

  it("force-kills Windows wrapped command trees when graceful taskkill fails", () => {
    withDefaultWindowsSystemRoot(() => {
      const child = {
        kill: vi.fn(),
        pid: 12345,
      };
      const runTaskkill = vi
        .fn()
        .mockReturnValueOnce({ error: undefined, status: 1 })
        .mockReturnValueOnce({ error: undefined, status: 0 });

      signalRunWithEnvChild(child, "SIGTERM", {
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

  it.runIf(process.platform !== "win32").each(["SIGTERM", "SIGHUP", "SIGINT"] as const)(
    "forwards parent %s to the wrapped command",
    async (signal) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-run-with-env-signals-"));
      const readyFile = path.join(tempDir, "ready");
      const signaledFile = path.join(tempDir, "signaled");
      const handlerLines = ["SIGTERM", "SIGHUP", "SIGINT"].flatMap((handledSignal) => [
        `process.on('${handledSignal}', () => {`,
        `  fs.writeFileSync(process.env.SIGNALED_FILE, '${handledSignal}');`,
        "  setTimeout(() => process.exit(0), 25);",
        "});",
      ]);
      const childScript = [
        "const fs = require('node:fs');",
        ...handlerLines,
        "fs.writeFileSync(process.env.READY_FILE, 'ready');",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      const wrapper = spawn(
        process.execPath,
        [
          "scripts/run-with-env.mjs",
          `READY_FILE=${readyFile}`,
          `SIGNALED_FILE=${signaledFile}`,
          "--",
          "node",
          "-e",
          childScript,
        ],
        { cwd: process.cwd(), stdio: "ignore" },
      );

      try {
        await waitFor(() => existsSync(readyFile), "wrapped command readiness");
        wrapper.kill(signal);

        const exit = await waitForExit(wrapper);
        expect(exit).toEqual({ code: null, signal });
        expect(readFileSync(signaledFile, "utf8")).toBe(signal);
      } finally {
        wrapper.kill("SIGKILL");
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans up wrapped command descendants on wrapper shutdown",
    async () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-run-with-env-descendants-"));
      const readyFile = path.join(tempDir, "ready");
      const grandchildReadyFile = path.join(tempDir, "grandchild-ready");
      const grandchildPidFile = path.join(tempDir, "grandchild-pid");
      const grandchildScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        "process.on('SIGHUP', () => {});",
        "fs.writeFileSync(process.env.GRANDCHILD_READY_FILE, 'ready');",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const childScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
        "fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(grandchild.pid));",
        "fs.writeFileSync(process.env.READY_FILE, 'ready');",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const wrapper = spawn(
        process.execPath,
        [
          "scripts/run-with-env.mjs",
          `READY_FILE=${readyFile}`,
          `GRANDCHILD_READY_FILE=${grandchildReadyFile}`,
          `GRANDCHILD_PID_FILE=${grandchildPidFile}`,
          "--",
          "node",
          "-e",
          childScript,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: "200" },
          stdio: "ignore",
        },
      );
      let grandchildPid = 0;

      try {
        await waitFor(() => existsSync(readyFile), "wrapped command readiness");
        await waitFor(
          () => existsSync(grandchildReadyFile),
          "wrapped command descendant readiness",
        );
        grandchildPid = Number(readFileSync(grandchildPidFile, "utf8"));
        expect(grandchildPid).toBeGreaterThan(0);
        expect(isProcessAlive(grandchildPid)).toBe(true);

        wrapper.kill("SIGTERM");
        const exit = await waitForExit(wrapper, 3_000);
        expect(exit).toEqual({ code: null, signal: "SIGTERM" });
        await waitFor(
          () => !isProcessAlive(grandchildPid),
          "wrapped command descendant cleanup",
          5_000,
        );
      } finally {
        wrapper.kill("SIGKILL");
        if (grandchildPid > 0 && isProcessAlive(grandchildPid)) {
          process.kill(grandchildPid, "SIGKILL");
        }
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "lets wrapped command descendants finish during the shutdown grace period",
    async () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-run-with-env-grace-"));
      const readyFile = path.join(tempDir, "ready");
      const gracefulFile = path.join(tempDir, "graceful");
      const grandchildReadyFile = path.join(tempDir, "grandchild-ready");
      const grandchildScript = [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.GRANDCHILD_READY_FILE, 'ready');",
        "process.on('SIGTERM', () => {",
        "  setTimeout(() => {",
        "    fs.writeFileSync(process.env.GRACEFUL_FILE, 'done');",
        "    process.exit(0);",
        "  }, 75);",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const childScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
        "fs.writeFileSync(process.env.READY_FILE, 'ready');",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const wrapper = spawn(
        process.execPath,
        [
          "scripts/run-with-env.mjs",
          `READY_FILE=${readyFile}`,
          `GRACEFUL_FILE=${gracefulFile}`,
          `GRANDCHILD_READY_FILE=${grandchildReadyFile}`,
          "--",
          "node",
          "-e",
          childScript,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: String(MAX_TIMER_TIMEOUT_MS + 1),
          },
          stdio: "ignore",
        },
      );

      try {
        await waitFor(() => existsSync(readyFile), "wrapped command readiness");
        await waitFor(
          () => existsSync(grandchildReadyFile),
          "wrapped command descendant readiness",
        );
        wrapper.kill("SIGTERM");

        const exit = await waitForExit(wrapper, 3_000);
        expect(exit).toEqual({ code: null, signal: "SIGTERM" });
        expect(readFileSync(gracefulFile, "utf8")).toBe("done");
      } finally {
        wrapper.kill("SIGKILL");
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")("preserves wrapped command signal exits", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-with-env.mjs",
        "OPENCLAW_RUN_WITH_ENV_SIGNAL_TEST=1",
        "--",
        "node",
        "-e",
        "process.kill(process.pid, 'SIGTERM')",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  it.runIf(process.platform !== "win32")("preserves wrapped command force-kill exits", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-with-env.mjs",
        "OPENCLAW_RUN_WITH_ENV_SIGNAL_TEST=1",
        "--",
        "node",
        "-e",
        "process.kill(process.pid, 'SIGKILL')",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGKILL");
  });
});
