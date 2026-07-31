// Memory Host SDK real-process tests cover QMD process-tree cleanup.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCliCommand } from "./qmd-process.js";

type ProcessTreePids = {
  parent: number;
  grandchild: number;
};

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitUntil(params: {
  condition: () => boolean | Promise<boolean>;
  description: string;
  timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (params.timeoutMs ?? 5_000);
  while (!(await params.condition())) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${params.description}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

async function readProcessTreePids(pidFile: string): Promise<ProcessTreePids> {
  let pids: ProcessTreePids | undefined;
  await waitUntil({
    description: "the process-tree PID file",
    condition: async () => {
      try {
        pids = JSON.parse(await fs.readFile(pidFile, "utf8")) as ProcessTreePids;
        return Number.isInteger(pids.parent) && Number.isInteger(pids.grandchild);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return false;
        }
        throw error;
      }
    },
  });
  if (!pids) {
    throw new Error("process-tree PID file was not populated");
  }
  return pids;
}

function killProcessTree(parentPid: number): void {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    spawnSync(
      path.win32.join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(parentPid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    return;
  }
  // The production abort path already force-kills the group. Cleanup after a
  // failed assertion starts gracefully so it cannot kill a reused group id.
  process.kill(-parentPid, "SIGTERM");
}

describe("runCliCommand real process UTF-8 framing", () => {
  it("preserves a multibyte character split across real stdout and stderr pipes", async () => {
    const script = `
      const { setTimeout } = require("node:timers/promises");
      const { finished } = require("node:stream/promises");
      (async () => {
        const cat = Buffer.from("猫");
        process.stdout.write(Buffer.concat([Buffer.from('{"value":"'), cat.subarray(0, 1)]));
        process.stderr.write(Buffer.concat([Buffer.from("path: "), cat.subarray(0, 1)]));
        await setTimeout(50);
        process.stdout.write(Buffer.concat([cat.subarray(1), Buffer.from('"}\\n')]));
        process.stderr.write(Buffer.concat([cat.subarray(1), Buffer.from(" denied\\n")]));
        process.exitCode = 1;
        process.stdout.end();
        process.stderr.end();
        await Promise.all([finished(process.stdout), finished(process.stderr)]);
      })();
    `;

    await expect(
      runCliCommand({
        commandSummary: "real qmd utf8 pipe fixture",
        spawnInvocation: { command: process.execPath, argv: ["-e", script] },
        env: process.env,
        cwd: process.cwd(),
        timeoutMs: 5_000,
        maxOutputChars: 10_000,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: '{"value":"猫"}\n',
      stderr: "path: 猫 denied\n",
    });
  }, 10_000);
});

describe("runCliCommand real process lifecycle", () => {
  it("kills the command and its descendant when the caller aborts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qmd-abort-"));
    const pidFile = path.join(tempDir, "pids.json");
    const controller = new AbortController();
    const abortError = new Error("memory_search timed out after 15s");
    let pending: ReturnType<typeof runCliCommand> | undefined;
    let pids: ProcessTreePids | undefined;

    const childScript = `
        const { spawn } = require("node:child_process");
        const { renameSync, writeFileSync } = require("node:fs");
        const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "ignore",
        });
        const pidFile = process.argv[1];
        const temporaryPidFile = pidFile + ".tmp";
        writeFileSync(temporaryPidFile, JSON.stringify({
          parent: process.pid,
          grandchild: grandchild.pid,
        }));
        renameSync(temporaryPidFile, pidFile);
        setInterval(() => {}, 1000);
      `;

    try {
      pending = runCliCommand({
        commandSummary: "real qmd process-tree fixture",
        spawnInvocation: { command: process.execPath, argv: ["-e", childScript, pidFile] },
        env: process.env,
        cwd: tempDir,
        timeoutMs: 60_000,
        maxOutputChars: 10_000,
        signal: controller.signal,
      });

      pids = await readProcessTreePids(pidFile);
      expect(isProcessRunning(pids.parent)).toBe(true);
      expect(isProcessRunning(pids.grandchild)).toBe(true);

      controller.abort(abortError);
      await expect(pending).rejects.toBe(abortError);
      await waitUntil({
        description: "the detached process tree to exit",
        condition: () =>
          pids !== undefined &&
          !isProcessRunning(pids.parent) &&
          !isProcessRunning(pids.grandchild),
      });
    } finally {
      if (!controller.signal.aborted) {
        controller.abort(abortError);
      }
      await pending?.catch(() => undefined);
      if (pids?.parent && isProcessRunning(pids.parent)) {
        try {
          killProcessTree(pids.parent);
        } catch {
          // Best-effort cleanup when an assertion failed after the child exited.
        }
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);
});
