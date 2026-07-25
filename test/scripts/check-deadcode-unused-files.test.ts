// Check Deadcode Unused Files tests cover check deadcode unused files script behavior.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkKnipUnusedFileScanResult,
  checkUnusedFiles,
  KNIP_MAX_BUFFER_BYTES,
  parseKnipCompactUnusedFiles,
  runKnipUnusedFiles,
} from "../../scripts/check-deadcode-unused-files.mjs";

class FakeKnipProcess extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly stdout = new EventEmitter();
  pid = 12345;
}

function finishFakeProcess(
  child: FakeKnipProcess,
  status: number | null,
  signal: NodeJS.Signals | null,
): void {
  child.emit("exit", status, signal);
  child.emit("close", status, signal);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (existsSync(filePath)) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`timeout waiting for ${filePath}`);
}

// Pid files are written with plain writeFileSync, so an existence poll can
// observe the open-truncate 0-byte window and parse NaN. Wait for a real pid.
async function waitForPidFile(filePath: string, timeoutMs: number): Promise<number> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (existsSync(filePath)) {
      const pid = Number.parseInt(readFileSync(filePath, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    }
    await sleep(5);
  }
  throw new Error(`timeout waiting for pid in ${filePath}`);
}

async function waitForDead(pid: number, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`process still alive: ${pid}`);
}

function waitForChildClose(
  child: ReturnType<typeof spawn>,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("child did not close before timeout"));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

describe("check-deadcode-unused-files", () => {
  it("has no checked-in unused-file allowlist", () => {
    expect(existsSync(path.resolve("scripts/deadcode-unused-files.allowlist.mjs"))).toBe(false);
    const script = readFileSync(path.resolve("scripts/check-deadcode-unused-files.mjs"), "utf8");
    expect(script).not.toContain("allowlist");
    expect(script).toContain("production and full-tree unused-file checks passed with 0 entries");
    expect(script).toContain('"config/knip.all-exports.config.ts"');
    expect(script).toContain("result.status !== 0");
  });

  it("parses the compact Knip unused-file section", () => {
    expect(
      parseKnipCompactUnusedFiles(`
> openclaw@2026.4.27 deadcode:knip /repo
> pnpm dlx knip --reporter compact --files

Unused files (2)
src/b.ts: src/b.ts
src/a.ts: src/a.ts
C:\\tmp\\outside.ts: C:\\tmp\\outside.ts
C:outside.ts: C:outside.ts
\\\\server\\share\\outside.ts: \\\\server\\share\\outside.ts

Unused dependencies (1)
left-pad: package.json
`),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("parses Knip's files-only compact output", () => {
    expect(parseKnipCompactUnusedFiles("src/b.ts: src/b.ts\nsrc/a.ts: src/a.ts\n")).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("keeps dot-directory and root entry files", () => {
    expect(
      parseKnipCompactUnusedFiles(
        ".agents/skills/example/scripts/check.mjs: .agents/skills/example/scripts/check.mjs\ntsdown.ai.config.ts: tsdown.ai.config.ts\n",
      ),
    ).toEqual([".agents/skills/example/scripts/check.mjs", "tsdown.ai.config.ts"]);
  });

  it("ignores pnpm dlx progress lines in files-only compact output", () => {
    expect(
      parseKnipCompactUnusedFiles(`
Progress: resolved 21, reused 0, downloaded 0, added 0
src/b.ts: src/b.ts
Progress: resolved 65, reused 20, downloaded 1, added 21, done
src/a.ts: src/a.ts
`),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("accepts an empty compact report with zero unused files", () => {
    expect(checkUnusedFiles("")).toStrictEqual({
      files: [],
      ok: true,
      message: "",
    });
  });

  it("rejects a nonzero Knip exit even when no unused files were printed", () => {
    expect(
      checkKnipUnusedFileScanResult({
        errorCode: undefined,
        output: "",
        signal: null,
        status: 2,
      }),
    ).toStrictEqual({
      failureReason: "exit status 2",
      message: "",
      ok: false,
    });
  });

  it("rejects every unused file without an allowlist", () => {
    expect(
      checkUnusedFiles("Unused files (2)\nsrc/z.ts: src/z.ts\nsrc/a.ts: src/a.ts\n"),
    ).toStrictEqual({
      files: ["src/a.ts", "src/z.ts"],
      ok: false,
      message: `Unused files are not allowed:
  src/a.ts
  src/z.ts
Delete the files or model their real entrypoints in Knip.`,
    });
  });

  it("runs Knip through a process-group-aware subprocess", async () => {
    const calls: unknown[] = [];
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-knip-runner-"));
    const pnpmExecPath = path.join(root, "pnpm.cjs");
    writeFileSync(pnpmExecPath, "console.log('pnpm');\n", "utf8");

    try {
      const resultPromise = runKnipUnusedFiles({
        nodeExecPath: "/test-node",
        npmExecPath: pnpmExecPath,
        spawnCommand(command: string, args: string[], options: unknown) {
          calls.push({ args, command, options });
          const child = new FakeKnipProcess();
          queueMicrotask(() => {
            child.stdout.emit("data", "partial stdout");
            child.stderr.emit("data", "partial stderr");
            finishFakeProcess(child, 0, null);
          });
          return child;
        },
        writeStatus: () => {},
      });

      const result = await resultPromise;

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        args: [
          pnpmExecPath,
          "--config.minimum-release-age=0",
          "dlx",
          "--package",
          "knip@6.8.0",
          "knip",
          "--config",
          "config/knip.config.ts",
          "--production",
          "--no-progress",
          "--reporter",
          "compact",
          "--files",
          "--no-config-hints",
        ],
        command: "/test-node",
        options: {
          detached: process.platform !== "win32",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      });
      expect(result).toStrictEqual({
        errorCode: undefined,
        errorMessage: undefined,
        output: "partial stdoutpartial stderr",
        signal: null,
        status: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to bare pnpm when no managed pnpm runner is available", async () => {
    const calls: unknown[] = [];

    const resultPromise = runKnipUnusedFiles({
      env: { PATH: "" },
      npmExecPath: "",
      platform: "linux",
      spawnCommand(command: string, args: string[], options: unknown) {
        calls.push({ args, command, options });
        const child = new FakeKnipProcess();
        queueMicrotask(() => finishFakeProcess(child, 0, null));
        return child;
      },
      writeStatus: () => {},
    });

    await resultPromise;

    const call = calls[0] as { command: string };
    expect(path.basename(call.command)).toBe("pnpm");
    expect(call).toMatchObject({
      args: [
        "--config.minimum-release-age=0",
        "dlx",
        "--package",
        "knip@6.8.0",
        "knip",
        "--config",
        "config/knip.config.ts",
        "--production",
        "--no-progress",
        "--reporter",
        "compact",
        "--files",
        "--no-config-hints",
      ],
      options: {
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
  });

  it("emits heartbeat status and reports Knip timeouts", async () => {
    const statuses: string[] = [];
    const child = new FakeKnipProcess();
    const originalKill = process.kill.bind(process);
    const kills: Array<NodeJS.Signals | number | undefined> = [];
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (Math.abs(pid) === child.pid) {
        if (signal === 0) {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        kills.push(signal);
        finishFakeProcess(child, null, (signal as NodeJS.Signals | undefined) ?? "SIGTERM");
        return true;
      }
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;
    try {
      const result = await runKnipUnusedFiles({
        heartbeatMs: 1,
        killGraceMs: 50,
        maxBufferBytes: KNIP_MAX_BUFFER_BYTES,
        spawnCommand: () => child,
        timeoutMs: 5,
        writeStatus: (message: string) => statuses.push(message),
      });

      expect(statuses.some((message) => message.includes("still running"))).toBe(true);
      expect(statuses.some((message) => message.includes("timed out"))).toBe(true);
      expect(kills).toContain("SIGTERM");
      expect(result).toStrictEqual({
        errorCode: "ETIMEDOUT",
        errorMessage: expect.stringContaining("Knip production unused-file scan timed out"),
        output: "",
        signal: "SIGTERM",
        status: null,
      });
    } finally {
      process.kill = originalKill;
    }
  });

  it.skipIf(process.platform === "win32")(
    "waits for timed-out Knip process groups after the wrapper exits",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-knip-timeout-"));
      const childPidPath = path.join(root, "child.pid");
      let childPid = 0;

      try {
        const childScript = [
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          "const fs = require('node:fs');",
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
          "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(child.pid));",
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("");

        const resultPromise = runKnipUnusedFiles({
          env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
          killGraceMs: 50,
          spawnCommand(_command: string, _args: string[], options: unknown) {
            return spawn(process.execPath, ["-e", parentScript], {
              ...(options as Parameters<typeof spawn>[2]),
              env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
            });
          },
          timeoutMs: 100,
          writeStatus: () => {},
        });

        childPid = await waitForPidFile(childPidPath, 2_000);
        expect(isProcessAlive(childPid)).toBe(true);

        await expect(resultPromise).resolves.toMatchObject({
          errorCode: "ETIMEDOUT",
        });
        await waitForDead(childPid, 2_000);
      } finally {
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans active Knip descendants before forwarding parent SIGTERM",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-knip-parent-signal-"));
      const childPidPath = path.join(root, "child.pid");
      const readyPath = path.join(root, "child.ready");
      const scriptUrl = pathToFileURL(path.resolve("scripts/check-deadcode-unused-files.mjs")).href;
      let childPid = 0;
      let runner: ReturnType<typeof spawn> | undefined;

      try {
        const childScript = [
          "const fs = require('node:fs');",
          "process.on('SIGTERM', () => {});",
          `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
          `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("");
        const runnerScript = [
          "import { spawn } from 'node:child_process';",
          `import { runKnipUnusedFiles } from ${JSON.stringify(scriptUrl)};`,
          "await runKnipUnusedFiles({",
          "  spawnCommand(_command, _args, options) {",
          `    return spawn(process.execPath, ['-e', ${JSON.stringify(parentScript)}], options);`,
          "  },",
          "  timeoutMs: 60_000,",
          "  writeStatus: () => {},",
          "});",
        ].join("\n");

        runner = spawn(process.execPath, ["--input-type=module", "-e", runnerScript], {
          cwd: process.cwd(),
          stdio: ["ignore", "ignore", "pipe"],
        });

        await waitForFile(readyPath, 2_000);
        childPid = await waitForPidFile(childPidPath, 2_000);
        expect(isProcessAlive(childPid)).toBe(true);

        runner.kill("SIGTERM");

        await expect(waitForChildClose(runner)).resolves.toEqual({
          code: null,
          signal: "SIGTERM",
        });
        await waitForDead(childPid, 2_000);
      } finally {
        if (runner?.pid && isProcessAlive(runner.pid)) {
          runner.kill("SIGKILL");
        }
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps output delivered after process exit but before stdio close", async () => {
    const child = new FakeKnipProcess();
    const resultPromise = runKnipUnusedFiles({
      spawnCommand: () => child,
      writeStatus: () => {},
    });

    child.stdout.emit("data", "before-exit\n");
    child.emit("exit", 0, null);
    child.stdout.emit("data", "after-exit\n");
    child.emit("close", 0, null);

    await expect(resultPromise).resolves.toStrictEqual({
      errorCode: undefined,
      errorMessage: undefined,
      output: "before-exit\nafter-exit\n",
      signal: null,
      status: 0,
    });
  });

  it("bounds captured Knip output", async () => {
    const child = new FakeKnipProcess();
    const originalKill = process.kill.bind(process);
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (Math.abs(pid) === child.pid) {
        if (signal === 0) {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        finishFakeProcess(child, null, (signal as NodeJS.Signals | undefined) ?? "SIGTERM");
        return true;
      }
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;
    try {
      const resultPromise = runKnipUnusedFiles({
        killGraceMs: 50,
        maxBufferBytes: 4,
        spawnCommand: () => child,
        timeoutMs: 1000,
        writeStatus: () => {},
      });
      child.stdout.emit("data", "too much output");

      await expect(resultPromise).resolves.toStrictEqual({
        errorCode: "ENOBUFS",
        errorMessage: "Knip production unused-file scan exceeded 4 output bytes",
        output: "too ",
        signal: "SIGTERM",
        status: null,
      });
    } finally {
      process.kill = originalKill;
    }
  });

  it("reports spawn errors", async () => {
    const resultPromise = runKnipUnusedFiles({
      spawnCommand: () => {
        const child = new FakeKnipProcess();
        queueMicrotask(() =>
          child.emit(
            "error",
            Object.assign(new Error("spawn pnpm ENOENT"), {
              code: "ENOENT",
            }),
          ),
        );
        return child;
      },
      writeStatus: () => {},
    });

    await expect(resultPromise).resolves.toStrictEqual({
      errorCode: "ENOENT",
      errorMessage: "spawn pnpm ENOENT",
      output: "",
      signal: null,
      status: null,
    });
  });
});
