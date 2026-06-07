// Package Openclaw For Docker tests cover package openclaw for docker script behavior.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildPackageArtifacts,
  packOpenClawPackageForDocker,
  parseArgs,
  runCommandForTest,
} from "../../scripts/package-openclaw-for-docker.mjs";

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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${filePath}`);
}

async function waitForDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`process still alive: ${pid}`);
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ signal: NodeJS.Signals | null; status: number | null }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timeout waiting for child exit")),
      timeoutMs,
    );
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ signal, status });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe("package-openclaw-for-docker", () => {
  it("parses package artifact output options", () => {
    expect(
      parseArgs([
        "--output-dir",
        ".artifacts/docker",
        "--output-name=openclaw-current.tgz",
        "--source-dir",
        "/repo",
        "--skip-build",
      ]),
    ).toEqual({
      outputDir: ".artifacts/docker",
      outputName: "openclaw-current.tgz",
      skipBuild: true,
      sourceDir: "/repo",
    });
  });

  it("rejects missing package artifact option values", () => {
    for (const flag of ["--output-dir", "--output-name", "--source-dir"]) {
      expect(() => parseArgs([flag])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([flag, "--skip-build"])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([`${flag}=`])).toThrow(`${flag} requires a value`);
    }
  });

  it("uses build-all as the single bounded package artifact build step", async () => {
    const calls: Array<{
      command: string;
      args: string[];
      cwd: string;
      noPnpm: string | undefined;
      skipDts: string | undefined;
      timeoutMs: number | undefined;
    }> = [];
    const previousTimeout = process.env.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS;
    process.env.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS = "1234";

    try {
      await buildPackageArtifacts("/repo", {
        runImpl: async (
          command: string,
          args: string[],
          cwd: string,
          options: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
        ) => {
          calls.push({
            command,
            args,
            cwd,
            noPnpm: options.env?.OPENCLAW_BUILD_ALL_NO_PNPM,
            skipDts: options.env?.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD,
            timeoutMs: options.timeoutMs,
          });
        },
      });
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS = previousTimeout;
      }
    }

    expect(calls).toEqual([
      {
        command: "node",
        args: ["scripts/build-all.mjs"],
        cwd: "/repo",
        noPnpm: "1",
        skipDts: "1",
        timeoutMs: 1234,
      },
    ]);
  });

  it("trims and restores the changelog around ignore-scripts package artifacts", async () => {
    const calls: string[] = [];
    const tarball = await packOpenClawPackageForDocker("/repo", "/out", {
      prepareChangelog: async (cwd: string) => {
        calls.push(`prepare:${cwd}`);
      },
      restoreChangelog: async (cwd: string) => {
        calls.push(`restore:${cwd}`);
      },
      runCaptureImpl: async (
        command: string,
        args: string[],
        cwd: string,
        options: { deferForwardedSignalExit?: boolean },
      ) => {
        calls.push(`${command}:${args.join(" ")}:${cwd}`);
        expect(options.deferForwardedSignalExit).toBe(true);
        return "openclaw-2026.5.28.tgz\n";
      },
    });

    expect(tarball).toBe(path.join("/out", "openclaw-2026.5.28.tgz"));
    expect(calls).toEqual([
      "prepare:/repo",
      "npm:pack --silent --ignore-scripts --pack-destination /out:/repo",
      "restore:/repo",
    ]);
  });

  it("restores the changelog when ignore-scripts packaging fails", async () => {
    const calls: string[] = [];

    await expect(
      packOpenClawPackageForDocker("/repo", "/out", {
        prepareChangelog: async (cwd: string) => {
          calls.push(`prepare:${cwd}`);
        },
        restoreChangelog: async (cwd: string) => {
          calls.push(`restore:${cwd}`);
        },
        runCaptureImpl: async () => {
          calls.push("pack");
          throw new Error("pack failed");
        },
      }),
    ).rejects.toThrow("pack failed");

    expect(calls).toEqual(["prepare:/repo", "pack", "restore:/repo"]);
  });

  it("kills timed-out child process groups", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-timeout-"));
    const childPidPath = path.join(tempDir, "child.pid");
    let childPid;
    try {
      const childScript = ["process.on('SIGTERM', () => {});", "setInterval(() => {}, 1000);"].join(
        "",
      );
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(child.pid));",
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("");

      const runPromise = runCommandForTest(process.execPath, ["-e", parentScript], process.cwd(), {
        env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
        killAfterMs: 25,
        timeoutMs: 500,
      });
      const timeoutAssertion = expect(runPromise).rejects.toThrow(/timed out after 500ms/u);
      await waitForFile(childPidPath, 2000);
      childPid = Number(fs.readFileSync(childPidPath, "utf8"));
      await timeoutAssertion;
      await waitForDead(childPid, 2000);
    } finally {
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("keeps fallback SIGKILL armed for descendants after the direct child exits", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-descendant-"));
    const childPidPath = path.join(tempDir, "child.pid");
    let childPid;
    try {
      const childScript = ["process.on('SIGTERM', () => {});", "setInterval(() => {}, 1000);"].join(
        "",
      );
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(child.pid));",
        "setInterval(() => {}, 1000);",
      ].join("");

      await expect(
        runCommandForTest(process.execPath, ["-e", parentScript], process.cwd(), {
          env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
          killAfterMs: 25,
          timeoutMs: 500,
        }),
      ).rejects.toThrow(/timed out after 500ms/u);

      await waitForFile(childPidPath, 2000);
      childPid = Number(fs.readFileSync(childPidPath, "utf8"));
      await waitForDead(childPid, 2000);
    } finally {
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("does not fire delayed SIGKILL after a timed-out child exits during grace", async () => {
    if (process.platform === "win32") {
      return;
    }

    const killSpy = vi.spyOn(process, "kill");
    try {
      const script = [
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("");

      await expect(
        runCommandForTest(process.execPath, ["-e", script], process.cwd(), {
          killAfterMs: 100,
          timeoutMs: 25,
        }),
      ).rejects.toThrow(/timed out after 25ms/u);

      const sigkillCallsAfterExit = killSpy.mock.calls.filter(
        ([, signal]) => signal === "SIGKILL",
      ).length;
      await sleep(150);
      expect(killSpy.mock.calls.filter(([, signal]) => signal === "SIGKILL")).toHaveLength(
        sigkillCallsAfterExit,
      );
    } finally {
      killSpy.mockRestore();
    }
  });

  it("fails captured commands that exceed the stdout limit", async () => {
    const script = [
      "process.stdout.write('x'.repeat(2048));",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("");

    await expect(
      runCommandForTest(process.execPath, ["-e", script], process.cwd(), {
        captureStdout: true,
        killAfterMs: 50,
        maxCapturedStdoutBytes: 1024,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/exceeded captured stdout limit \(1024 bytes\)/u);
  });

  it("forwards external termination to active child process groups", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-signal-"));
    const childPidPath = path.join(tempDir, "child.pid");
    const scriptUrl = pathToFileURL(path.resolve("scripts/package-openclaw-for-docker.mjs")).href;
    let childPid = 0;
    let runnerPid;
    try {
      const childScript = "setInterval(() => {}, 1000);";
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(child.pid));",
        "setInterval(() => {}, 1000);",
      ].join("");
      const runnerScript = [
        `import { runCommandForTest } from ${JSON.stringify(scriptUrl)};`,
        `await runCommandForTest(process.execPath, ['-e', ${JSON.stringify(parentScript)}], process.cwd(), { timeoutMs: 60000 });`,
      ].join("\n");
      const runner = spawn(process.execPath, ["--input-type=module", "-e", runnerScript], {
        cwd: process.cwd(),
        env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
        stdio: ["ignore", "ignore", "pipe"],
      });
      runnerPid = runner.pid ?? 0;

      await waitForFile(childPidPath, 2000);
      childPid = Number(fs.readFileSync(childPidPath, "utf8"));
      runner.kill("SIGTERM");
      const result = await waitForExit(runner, 5000);

      expect(result).toEqual({ signal: null, status: 143 });
      await waitForDead(childPid, 2000);
    } finally {
      if (runnerPid && isProcessAlive(runnerPid)) {
        process.kill(runnerPid, "SIGKILL");
      }
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
